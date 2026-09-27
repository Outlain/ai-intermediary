"""No ComfyUI, GPU, network listener, aiohttp installation or sudo needed."""
import copy
import json
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import bridge

ID = "617f9518-f82e-4a10-980f-f3aa8ccf0c65"
OTHER = "81b3d636-4662-4386-a2a8-1638906dc0a7"
TOKEN = "0123456789abcdef" * 4


class Queue:
    def __init__(self):
        self.pending, self.running, self.history = [], [], {}

    def put(self, value):
        self.pending.append(value)

    def get_current_queue(self):
        return self.running, self.pending

    def get_history(self, prompt_id):
        return {prompt_id: self.history[prompt_id]} if prompt_id in self.history else {}


class ReleaseQueue(Queue):
    def __init__(self):
        super().__init__()
        self.flags, self.flag_requests = {}, []

    def set_flag(self, name, value):
        self.flag_requests.append((name, value))
        self.flags[name] = value

    def get_flags(self, reset=True):
        if reset:
            flags, self.flags = self.flags, {}
            return flags
        return self.flags.copy()


class MemoryManager:
    def __init__(self):
        self.models, self.calls = [], []
        self.during_unload = None
        self.unload_error = self.cache_error = self.models_error = None

    def unload_all_models(self, *args, **kwargs):
        self.calls.append(("unload", args, kwargs))
        if self.during_unload:
            self.during_unload()
        if self.unload_error:
            raise self.unload_error
        return "unloaded-result"

    def soft_empty_cache(self, *args, **kwargs):
        self.calls.append(("cache", args, kwargs))
        if self.cache_error:
            raise self.cache_error
        return "cache-result"

    def loaded_models(self):
        if self.models_error:
            raise self.models_error
        return self.models


class Routes:
    def __init__(self):
        self.handlers = {}

    def route(self, method, path):
        def decorate(handler):
            self.handlers[(method, path)] = handler
            return handler
        return decorate

    def get(self, path):
        return self.route("GET", path)

    def post(self, path):
        return self.route("POST", path)


class Web:
    middleware = staticmethod(lambda handler: handler)
    json_response = staticmethod(lambda data, status=200: SimpleNamespace(data=data, status=status))


class Node:
    OUTPUT_NODE = False


class Output:
    OUTPUT_NODE = True


def payload():
    return {"prompt_id": ID, "prompt": {
        "1": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 20}},
        "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0], "filename_prefix": "old-name"}},
    }}


class Tests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="comfy-bridge-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.server = SimpleNamespace(prompt_queue=Queue(), routes=Routes(), app=SimpleNamespace(middlewares=[]))
        self.nodes = {"KSampler": Node, "SaveImage": Output, "PreviewImage": Output, "SaveVideo": Output,
                      "SaveAnimatedWEBP": Output, "VHS_VideoCombine": Output}
        self.guard = bridge.install(self.server, self.nodes, self.root, web=Web, token=TOKEN, disable_api_nodes=True)
        self.middleware = self.server.app.middlewares[0]

    def request(self, path, value=None, token=TOKEN, method="POST"):
        body = json.dumps(value).encode() if value is not None else b""
        return SimpleNamespace(path=path, method=method, headers={bridge.HEADER: token} if token is not None else {},
                               content_length=len(body), _read_bytes=body)

    async def submit(self, value=None, old_id=None):
        async def handler(request):
            rewritten = json.loads(request._read_bytes)
            prompt_id = old_id or rewritten["prompt_id"]
            self.server.prompt_queue.put((0, prompt_id, rewritten["prompt"], {}))
            return Web.json_response({"prompt_id": prompt_id})
        return await self.middleware(self.request("/prompt", value or payload()), handler)

    async def successful_file(self, filename="image.png"):
        self.assertEqual((await self.submit()).status, 200)
        item = self.server.prompt_queue.pending.pop()
        target = self.root / bridge.NAMESPACE / ID / filename
        target.parent.mkdir()
        target.write_bytes(b"test-owned-output")
        artifact = {"filename": filename, "subfolder": f"{bridge.NAMESPACE}/{ID}", "type": "output"}
        self.server.prompt_queue.history[ID] = {"prompt": item, "status": {"completed": True, "status_str": "success"},
                                                "outputs": {"2": {"images": [artifact]}}}
        return target, artifact

    async def test_every_raw_method_and_websocket_requires_token(self):
        called = []
        async def handler(request):
            called.append(request)
            return Web.json_response({})
        for path, method in [("/prompt", "POST"), ("/api/prompt", "POST"), ("/userdata/file", "PUT"),
                             ("/history", "DELETE"), ("/view", "GET"), ("/ws", "GET"), ("/", "GET")]:
            response = await self.middleware(self.request(path, token=None, method=method), handler)
            self.assertEqual(response.status, 401)
        self.assertEqual(called, [])
        result = await self.middleware(self.request("/view", method="GET"), handler)
        self.assertEqual(result.status, 200)

    async def test_missing_token_or_api_nodes_enabled_is_fail_closed(self):
        for field, value in [("token", ""), ("disable_api_nodes", False)]:
            with patch.object(self.guard, field, value):
                self.assertFalse(self.guard.status()["local_only"])
                self.assertNotEqual((await self.submit()).status, 200)
        self.assertEqual(self.server.prompt_queue.pending, [])

    async def test_save_names_are_owned_without_changing_model_inputs(self):
        response = await self.submit()
        self.assertEqual(response.status, 200)
        graph = self.server.prompt_queue.pending[0][2]
        self.assertEqual(graph["1"], payload()["prompt"]["1"])
        self.assertEqual(graph["2"]["inputs"]["filename_prefix"], f"ai-intermediary/{ID}/node-2")
        self.assertEqual(self.guard.status()["protocol"], bridge.PROTOCOL)
        self.assertTrue(self.guard.status()["local_only"])

    async def test_raw_queue_put_and_older_backend_id_are_blocked_before_execution(self):
        with self.assertRaises(bridge.BridgeError):
            self.server.prompt_queue.put((0, ID, payload()["prompt"], {}))
        response = await self.submit(old_id=OTHER)
        self.assertEqual(response.status, 409)
        self.assertEqual(self.server.prompt_queue.pending, [])
        self.assertNotIn(ID, self.guard.owned)

    async def test_duplicate_ids_survive_bridge_restart(self):
        self.assertEqual((await self.submit()).status, 200)
        self.assertEqual((await self.submit()).status, 409)
        other_server = SimpleNamespace(prompt_queue=Queue(), routes=Routes(), app=SimpleNamespace(middlewares=[]))
        restarted = bridge.install(other_server, self.nodes, self.root, web=Web, token=TOKEN, disable_api_nodes=True)
        with self.assertRaisesRegex(bridge.BridgeError, "duplicate_prompt_id"):
            restarted.prepare(payload())
        self.assertEqual(len(self.server.prompt_queue.pending), 1)

    async def test_unknown_saving_nodes_cloud_nodes_and_traversal_rejected(self):
        self.nodes["SaveAnywhere"] = Output
        for node in [{"class_type": "SaveAnywhere", "inputs": {}},
                     {"class_type": "KSampler", "inputs": {"image": "../../secret"}},
                     {"class_type": "KSampler", "inputs": {"video": "http://remote/video.mp4"}}]:
            value = payload()
            value["prompt"]["3"] = node
            self.assertEqual((await self.submit(value)).status, 400)
        self.nodes["KSampler"] = type("ApiNode", (), {"API_NODE": True})
        self.assertEqual((await self.submit()).status, 400)
        self.assertEqual(self.server.prompt_queue.pending, [])

    async def test_v3_output_and_api_metadata_are_checked(self):
        for info in [{"api_node": True}, {"output_node": True}, {"category": "partner nodes/video"}]:
            self.nodes["KSampler"] = type("V3Node", (), {"GET_NODE_INFO_V1": staticmethod(lambda: info)})
            self.assertEqual((await self.submit()).status, 400)

    async def test_rechecks_final_graph_after_custom_prompt_hooks(self):
        async def handler(request):
            data = json.loads(request._read_bytes)
            data["prompt"]["1"]["inputs"]["image"] = "../../secret"
            self.server.prompt_queue.put((0, ID, data["prompt"], {}))
        response = await self.middleware(self.request("/prompt", payload()), handler)
        self.assertEqual(response.status, 400)
        self.assertEqual(self.server.prompt_queue.pending, [])

    async def test_owned_successful_outputs_deleted_but_models_unrelated_files_remain(self):
        target, artifact = await self.successful_file()
        unrelated = self.root / "keep-model.safetensors"
        unrelated.write_bytes(b"keep")
        result = self.guard.delete_artifacts({"prompt_id": ID, "artifacts": [artifact]})
        self.assertEqual(result["deleted"], 1)
        self.assertFalse(target.exists())
        self.assertTrue(unrelated.exists())
        self.assertEqual(self.guard.delete_artifacts({"prompt_id": ID, "artifacts": [artifact]})["missing"], 1)

    async def test_no_delete_without_matching_successful_terminal_history(self):
        target, artifact = await self.successful_file()
        original = copy.deepcopy(self.server.prompt_queue.history[ID])
        for mutation in [lambda r: r["status"].update(completed=False), lambda r: r["status"].update(status_str="error"),
                         lambda r: r.update(prompt=[0, OTHER])]:
            self.server.prompt_queue.history[ID] = copy.deepcopy(original)
            mutation(self.server.prompt_queue.history[ID])
            with self.assertRaises(bridge.BridgeError):
                self.guard.delete_artifacts({"prompt_id": ID, "artifacts": [artifact]})
            self.assertTrue(target.exists())
        self.server.prompt_queue.history.clear()
        with self.assertRaises(bridge.BridgeError):
            self.guard.delete_artifacts({"prompt_id": ID, "artifacts": [artifact]})
        self.assertTrue(target.exists())

    async def test_only_exact_history_descriptors_deleted_and_batch_validates_first(self):
        target, artifact = await self.successful_file()
        for bad in [{**artifact, "filename": "other.png"}, {**artifact, "subfolder": f"ai-intermediary/{OTHER}"},
                    {**artifact, "subfolder": f"ai-intermediary/{ID}/../"}, {**artifact, "type": "input"}]:
            with self.assertRaises(bridge.BridgeError):
                self.guard.delete_artifacts({"prompt_id": ID, "artifacts": [artifact, bad]})
            self.assertTrue(target.exists())

    async def test_symlink_artifacts_and_symlink_directories_never_followed(self):
        target, artifact = await self.successful_file()
        outside = self.root / "unrelated.txt"
        outside.write_bytes(b"keep")
        target.unlink()
        target.symlink_to(outside)
        with self.assertRaises(bridge.BridgeError):
            self.guard.delete_artifacts({"prompt_id": ID, "artifacts": [artifact]})
        self.assertTrue(outside.exists())
        target.unlink()
        target.parent.rmdir()
        target.parent.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(bridge.BridgeError):
            self.guard.delete_artifacts({"prompt_id": ID, "artifacts": [artifact]})
        self.assertTrue(outside.exists())

    async def test_ownership_persistence_failure_prevents_enqueue(self):
        with patch.object(self.guard, "_record_id", side_effect=OSError("disk failed")):
            response = await self.submit()
        self.assertEqual(response.status, 503)
        self.assertEqual(self.server.prompt_queue.pending, [])
        self.assertFalse(self.guard.status()["local_only"])

    async def test_corrupt_ledger_installs_closed_guard(self):
        ledger = self.root / bridge.NAMESPACE / ".broker-owned-jobs.json"
        ledger.write_bytes(b"bad-json")
        server = SimpleNamespace(prompt_queue=Queue(), routes=Routes(), app=SimpleNamespace(middlewares=[]))
        guard = bridge.install(server, self.nodes, self.root, web=Web, token=TOKEN, disable_api_nodes=True)
        self.assertFalse(guard.status()["local_only"])
        with self.assertRaises(bridge.BridgeError):
            server.prompt_queue.put((0, ID, payload()["prompt"], {}))

    async def test_cached_request_size_limit_and_api_alias(self):
        request = self.request("/prompt", payload())
        request._read_bytes = b"x" * (bridge.MAX_BODY + 1)
        response = await self.middleware(request, lambda request: None)
        self.assertEqual(response.status, 413)
        async def handler(request):
            data = json.loads(request._read_bytes)
            self.server.prompt_queue.put((0, ID, data["prompt"], {}))
            return Web.json_response({})
        response = await self.middleware(self.request("/api/prompt", payload()), handler)
        self.assertEqual(response.status, 200)


class ReleaseTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="comfy-bridge-release-test-")
        self.addCleanup(self.directory.cleanup)
        self.server = SimpleNamespace(prompt_queue=ReleaseQueue(), routes=Routes(), app=SimpleNamespace(middlewares=[]))
        self.manager = MemoryManager()
        self.guard = bridge.install(self.server, {"KSampler": Node, "SaveImage": Output}, self.directory.name,
                                    web=Web, token=TOKEN, disable_api_nodes=True, memory_manager=self.manager)
        self.queue = self.server.prompt_queue

    def proof(self):
        return self.guard.status()["release_proof"]

    def request_release(self, request_id=ID):
        return self.guard.request_release({"request_id": request_id})

    def finish(self):
        self.queue.get_flags()
        self.manager.unload_all_models()
        self.manager.soft_empty_cache()

    async def test_release_ack_is_not_proof_and_observers_forward_arguments_and_results(self):
        self.assertEqual(self.proof(), {"supported": True, "request_id": None, "completed": False,
                                        "loaded_models": 0, "error": None})
        result = self.request_release()
        self.assertTrue(result["requested"])
        self.assertFalse(result["release_proof"]["completed"])
        self.assertEqual(self.manager.calls, [], "HTTP request never directly invokes GPU cleanup")
        self.assertEqual(self.queue.get_flags(reset=False), {"unload_models": True, "free_memory": True})
        self.manager.unload_all_models()
        self.manager.soft_empty_cache()
        self.assertFalse(self.proof()["completed"], "Peeked flags are not consumed flags")
        flags = self.queue.get_flags()
        self.assertEqual(flags, {"unload_models": True, "free_memory": True})
        self.assertEqual(self.manager.unload_all_models("arg", option=True), "unloaded-result")
        self.assertFalse(self.proof()["completed"])
        self.assertEqual(self.manager.soft_empty_cache(force=True), "cache-result")
        self.assertTrue(self.proof()["completed"])
        self.assertEqual(self.manager.calls[-2:], [("unload", ("arg",), {"option": True}), ("cache", (), {"force": True})])

    async def test_nested_empty_cache_during_unload_does_not_mark_completed(self):
        self.request_release()
        self.queue.get_flags()
        proofs = []
        def nested():
            self.manager.soft_empty_cache()
            proofs.append(self.proof()["completed"])
        self.manager.during_unload = nested
        self.manager.unload_all_models()
        self.assertEqual(proofs, [False])
        self.assertFalse(self.proof()["completed"])
        self.manager.soft_empty_cache()
        self.assertTrue(self.proof()["completed"])

    async def test_idempotent_same_nonce_does_not_reset_pending_or_completed_proof(self):
        self.request_release()
        self.request_release()
        self.assertEqual(len(self.queue.flag_requests), 2)
        with self.assertRaisesRegex(bridge.BridgeError, "release_in_progress"):
            self.request_release(OTHER)
        self.finish()
        self.assertTrue(self.request_release()["release_proof"]["completed"])
        self.assertEqual(len(self.queue.flag_requests), 2)
        self.assertFalse(self.request_release(OTHER)["release_proof"]["completed"])
        self.assertEqual(len(self.queue.flag_requests), 4)

    async def test_release_requires_empty_queue_and_strict_body(self):
        for body in [None, {}, {"request_id": ID, "extra": True}, {"request_id": "invalid"}, {"request_id": 12}]:
            with self.assertRaises(bridge.BridgeError):
                self.guard.request_release(body)
        for kind in ["running", "pending"]:
            getattr(self.queue, kind).append((0, OTHER))
            with self.assertRaisesRegex(bridge.BridgeError, "backend_busy"):
                self.request_release()
            getattr(self.queue, kind).clear()
        self.assertEqual(self.queue.flag_requests, [])

    async def test_release_http_route_authentication_and_readiness(self):
        handler = self.server.routes.handlers[("POST", "/intermediary/release")]
        middleware = self.server.app.middlewares[0]
        data = json.dumps({"request_id": ID}).encode()
        request = SimpleNamespace(path="/intermediary/release", method="POST", headers={},
                                  content_length=len(data), _read_bytes=data)
        self.assertEqual((await middleware(request, handler)).status, 401)
        request.headers[bridge.HEADER] = TOKEN
        result = await middleware(request, handler)
        self.assertEqual(result.status, 200)
        self.assertFalse(result.data["release_proof"]["completed"])
        with patch.object(self.guard, "storage_error", True):
            self.assertEqual((await middleware(request, handler)).status, 503)

    async def test_missing_capabilities_and_replaced_observers_never_claim_support(self):
        old = SimpleNamespace(prompt_queue=Queue(), routes=Routes(), app=SimpleNamespace(middlewares=[]))
        guard = bridge.install(old, {}, self.directory.name, web=Web, token=TOKEN, disable_api_nodes=True)
        self.assertFalse(guard.status()["release_proof"]["supported"])
        with self.assertRaisesRegex(bridge.BridgeError, "release_proof_unsupported"):
            guard.request_release({"request_id": ID})
        self.request_release()
        self.finish()
        self.manager.soft_empty_cache = lambda: None
        self.assertFalse(self.proof()["supported"])
        self.assertFalse(self.proof()["completed"])
        self.assertEqual(self.proof()["error"], "release_evidence_changed")

    async def test_async_cleanup_is_not_compatible_with_native_worker_observers(self):
        async def asynchronous_cleanup():
            return None
        manager = MemoryManager()
        manager.unload_all_models = asynchronous_cleanup
        server = SimpleNamespace(prompt_queue=ReleaseQueue(), routes=Routes(), app=SimpleNamespace(middlewares=[]))
        guard = bridge.install(server, {}, self.directory.name, web=Web, token=TOKEN, disable_api_nodes=True,
                               memory_manager=manager)
        self.assertFalse(guard.status()["release_proof"]["supported"])

    async def test_flag_read_or_write_exception_never_yields_a_completed_proof(self):
        error = RuntimeError("flag write failed")
        with patch.object(self.queue, "set_flag", side_effect=error):
            with self.assertRaisesRegex(bridge.BridgeError, "release_flag_request_failed"):
                self.request_release()
        self.assertFalse(self.proof()["completed"])
        self.assertEqual(self.proof()["error"], "release_flag_request_failed")
        # Install an original failing reader, not a replacement after install.
        server = SimpleNamespace(prompt_queue=ReleaseQueue(), routes=Routes(), app=SimpleNamespace(middlewares=[]))
        def reader(*args, **kwargs):
            raise error
        server.prompt_queue.get_flags = reader
        manager = MemoryManager()
        guard = bridge.install(server, {}, self.directory.name, web=Web, token=TOKEN, disable_api_nodes=True,
                               memory_manager=manager)
        guard.request_release({"request_id": OTHER})
        with self.assertRaises(RuntimeError) as raised:
            server.prompt_queue.get_flags()
        self.assertIs(raised.exception, error)
        self.assertEqual(guard.status()["release_proof"]["error"], "release_flag_read_failed")

    async def test_new_work_admitted_during_unload_cannot_complete_the_old_nonce(self):
        self.request_release()
        self.queue.get_flags()
        def admission():
            token = bridge._submission.set({"prompt_id": OTHER, "enqueued": False})
            try:
                self.queue.put((0, OTHER, payload()["prompt"], {}))
            finally:
                bridge._submission.reset(token)
        self.manager.during_unload = admission
        self.manager.unload_all_models()
        self.manager.soft_empty_cache()
        self.assertFalse(self.proof()["completed"])
        self.assertEqual(self.proof()["error"], "release_invalidated_by_submission")
        self.assertEqual(len(self.queue.pending), 1)

    async def test_completed_proof_is_invalidated_when_queue_changes_outside_admission(self):
        self.request_release()
        self.finish()
        self.queue.running.append((0, OTHER))
        self.assertFalse(self.proof()["completed"])
        self.assertEqual(self.proof()["error"], "release_evidence_changed")
        self.queue.running.clear()
        self.assertFalse(self.proof()["completed"], "Removing new work does not resurrect old proof")

    async def test_incomplete_flags_and_next_iteration_do_not_complete_old_sequence(self):
        self.request_release()
        self.queue.flags.pop("free_memory")
        self.finish()
        self.assertFalse(self.proof()["completed"])
        self.assertEqual(self.proof()["error"], "release_flags_incomplete")
        self.request_release(OTHER)
        self.queue.get_flags()
        self.queue.get_flags()
        self.manager.unload_all_models()
        self.manager.soft_empty_cache()
        self.assertFalse(self.proof()["completed"])
        self.assertEqual(self.proof()["error"], "release_sequence_incomplete")

    async def test_wrong_thread_cannot_finish_worker_cleanup(self):
        for stage in ["unload", "cache"]:
            self.request_release(ID if stage == "unload" else OTHER)
            self.queue.get_flags()
            if stage == "cache":
                self.manager.unload_all_models()
            thread = threading.Thread(target=self.manager.unload_all_models if stage == "unload" else self.manager.soft_empty_cache)
            thread.start()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.manager.soft_empty_cache()
            self.assertFalse(self.proof()["completed"])
            self.assertEqual(self.proof()["error"], "release_worker_mismatch")

    async def test_native_cleanup_exceptions_propagate_and_poison_proof(self):
        for stage, request_id in [("unload", ID), ("cache", OTHER)]:
            error = RuntimeError(stage)
            self.request_release(request_id)
            self.queue.get_flags()
            if stage == "cache":
                self.manager.unload_all_models()
            setattr(self.manager, stage + "_error", error)
            with self.assertRaises(RuntimeError) as raised:
                (self.manager.unload_all_models if stage == "unload" else self.manager.soft_empty_cache)()
            self.assertIs(raised.exception, error)
            setattr(self.manager, stage + "_error", None)
            self.manager.soft_empty_cache()
            self.assertFalse(self.proof()["completed"])
            self.assertEqual(self.proof()["error"], "release_" + stage + "_failed")

    async def test_empty_registry_and_empty_queue_required_at_completion_and_later(self):
        for models in [[object()], None, (), {"models": []}]:
            self.guard._release = None
            self.manager.models = models
            self.request_release()
            self.finish()
            self.assertFalse(self.proof()["completed"])
        self.manager.models = []
        self.guard._release = None
        self.request_release()
        self.queue.get_flags()
        self.manager.unload_all_models()
        self.queue.pending.append((0, OTHER))
        self.manager.soft_empty_cache()
        self.assertFalse(self.proof()["completed"])
        self.queue.pending.clear()
        self.request_release(OTHER)
        self.finish()
        self.assertTrue(self.proof()["completed"])
        self.manager.models = [object()]
        self.assertFalse(self.proof()["completed"])
        self.assertEqual(self.proof()["error"], "release_evidence_changed")

    async def test_registry_read_failure_never_confirms_cleanup(self):
        self.request_release()
        self.manager.models_error = RuntimeError("cannot inspect registry")
        self.finish()
        self.assertFalse(self.proof()["completed"])
        self.assertIsNone(self.proof()["loaded_models"])

    async def test_admitted_submission_invalidates_proof_and_old_id_cannot_rearm_it(self):
        self.request_release()
        self.finish()
        context = bridge._submission.set({"prompt_id": OTHER, "enqueued": False})
        try:
            graph = payload()["prompt"]
            self.queue.put((0, OTHER, graph, {}))
        finally:
            bridge._submission.reset(context)
        self.assertFalse(self.proof()["completed"])
        self.assertEqual(self.proof()["error"], "release_invalidated_by_submission")
        self.queue.pending.clear()
        result = self.request_release()
        self.assertFalse(result["release_proof"]["completed"])
        self.assertEqual(len(self.queue.flag_requests), 2)
        self.request_release(OTHER)
        self.finish()
        self.assertTrue(self.proof()["completed"])


if __name__ == "__main__":
    unittest.main()

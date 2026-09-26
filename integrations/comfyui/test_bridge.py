"""No ComfyUI, GPU, network listener, aiohttp installation or sudo needed."""
import copy
import json
import os
from pathlib import Path
import tempfile
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


if __name__ == "__main__":
    unittest.main()

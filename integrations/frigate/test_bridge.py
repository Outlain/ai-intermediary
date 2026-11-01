"""Run: python3 -m unittest discover -s integrations/frigate -p 'test_*.py'."""

import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


bridge = load("bridge_under_test", "bridge.py")
installer = load("bridge_installer_under_test", "apply_bridge.py")
TICKET = "a" * 64


def client(base="http://127.0.0.1:11435", provider="ollama"):
    return types.SimpleNamespace(genai_config=types.SimpleNamespace(
        provider=provider, base_url=base, api_key="must-not-leave-in-callback"
    ))


def processor(provider=None):
    return types.SimpleNamespace(genai_manager=types.SimpleNamespace(
        description_client=provider or client()
    ))


def request(path="/api/generate", ticket=None, origin="http://127.0.0.1:11435", method="POST"):
    return types.SimpleNamespace(url=origin + path, method=method,
                                 headers={} if ticket is None else {bridge.HEADER: ticket})


class BridgeTests(unittest.TestCase):
    def test_capabilities_opt_in_and_supported_provider_only(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(bridge.capabilities(client())["completion_reports"])
        with patch.dict(os.environ, {"FRIGATE_INTERMEDIARY_BRIDGE": "1"}):
            self.assertEqual(bridge.capabilities(client()), {
                "protocol": bridge.PROTOCOL, "object": True,
                "review": True, "completion_reports": True,
            })
            self.assertFalse(bridge.capabilities(client(provider="openai"))["object"])

    def test_callback_destination_is_only_configured_http_origin(self):
        for base in (
            "file:///etc/passwd", "http://user:password@localhost", "http://host:invalid",
            "http://host/path", "http://host/?callback=http://evil", "http://host/#x",
            "http://host\n/", "//host", "javascript:alert(1)", None,
        ):
            with self.subTest(base=base):
                self.assertIsNone(bridge.callback_url(client(base)))
        self.assertEqual(bridge.callback_url(client("https://host:8971/")),
                         "https://host:8971" + bridge.CALLBACK_PATH)

    def test_header_request_validation_and_disabled_bridge(self):
        class HTTPException(Exception):
            def __init__(self, status_code, detail):
                self.status_code = status_code
        app = types.SimpleNamespace(genai_manager=processor().genai_manager)
        req = types.SimpleNamespace(headers={}, app=app)
        with patch.dict(sys.modules, {"fastapi": types.SimpleNamespace(HTTPException=HTTPException)}):
            self.assertIsNone(bridge.request_attempt(req))
            with patch.dict(os.environ, {"FRIGATE_INTERMEDIARY_BRIDGE": "1"}):
                for invalid in ("", "b" * 63, "B" * 64, "g" * 64, TICKET + "\n"):
                    req.headers = {bridge.HEADER: invalid}
                    with self.assertRaises(HTTPException) as caught:
                        bridge.request_attempt(req)
                    self.assertEqual(caught.exception.status_code, 400)
                req.headers = {bridge.HEADER: TICKET}
                self.assertEqual(bridge.request_attempt(req), TICKET)
            with patch.dict(os.environ, {"FRIGATE_INTERMEDIARY_BRIDGE": "0"}):
                with self.assertRaises(HTTPException) as caught:
                    bridge.request_attempt(req)
                self.assertEqual(caught.exception.status_code, 409)

    def test_terminal_failure_early_return_and_exception(self):
        @bridge.native_attempt
        def early(self):
            return None
        @bridge.native_attempt
        def fail(self):
            raise RuntimeError("sensitive native error must not enter callback")
        with patch.object(bridge, "report_completion") as report:
            early(processor(), attempt=TICKET)
            self.assertEqual(report.call_args.args[0].outcome, "failed")
            self.assertEqual(report.call_args.args[0].reason, "generation_failed")
            with self.assertRaises(RuntimeError):
                fail(processor(), attempt=TICKET)
            self.assertEqual(report.call_args.args[0].reason, "native_error")
            self.assertIsNone(bridge._current.get())

    def test_success_is_reported_after_native_work_not_after_first_send(self):
        events = []
        @bridge.native_attempt
        def native(self):
            for number in range(2):
                outgoing = request()
                bridge.request_hook(outgoing)
                self.assert_ticket = outgoing.headers[bridge.HEADER]
                events.append(f"inference-{number}")
            events.append("save-handoff")
            bridge.mark_success()
            events.append("native-finished")
        with patch.object(bridge, "report_completion", side_effect=lambda result: events.append(result.outcome)):
            native(processor(), attempt=TICKET)
        self.assertEqual(events, ["inference-0", "inference-1", "save-handoff", "native-finished", "success"])

    def test_review_child_inherits_context_and_parent_waits_before_report(self):
        events = []
        def child():
            outgoing = request()
            bridge.request_hook(outgoing)
            self.assertEqual(outgoing.headers[bridge.HEADER], TICKET)
            events.append("child-native-finished")
            bridge.mark_success()
        @bridge.native_attempt
        def native(self):
            bridge.start_analysis_thread(target=child, args=())
            events.append("parent-returned")
        with patch.object(bridge, "report_completion", side_effect=lambda result: events.append(result.outcome)):
            native(processor(), attempt=TICKET)
        self.assertEqual(events, ["child-native-finished", "parent-returned", "success"])

    def test_live_analysis_returns_without_waiting_for_child(self):
        release = threading.Event()
        entered = threading.Event()

        def child():
            entered.set()
            release.wait(5)

        worker = bridge.start_analysis_thread(target=child, args=())
        try:
            self.assertTrue(entered.wait(5))
            self.assertTrue(worker.is_alive(), "Live analysis should remain asynchronous")
        finally:
            release.set()
            worker.join(timeout=5)
        self.assertFalse(worker.is_alive())

    def test_live_and_two_attempt_threads_do_not_contaminate_each_other(self):
        barrier = threading.Barrier(3)
        seen = {}
        @bridge.native_attempt
        def native(self, key):
            barrier.wait(timeout=5)
            outgoing = request()
            bridge.request_hook(outgoing)
            seen[key] = outgoing.headers.get(bridge.HEADER)
            bridge.mark_success()
        with patch.object(bridge, "report_completion"):
            workers = [threading.Thread(target=native, args=(processor(), key), kwargs={"attempt": ticket})
                       for key, ticket in (("one", "1" * 64), ("two", "2" * 64), ("live", None))]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=5)
                self.assertFalse(worker.is_alive())
        self.assertEqual(seen, {"one": "1" * 64, "two": "2" * 64, "live": None})

    def test_hook_only_tags_own_inference_and_removes_stale_ticket(self):
        @bridge.native_attempt
        def native(self):
            for path, origin, method in (
                ("/api/show", "http://127.0.0.1:11435", "POST"),
                ("/api/generate", "http://other-host:11435", "POST"),
                ("/api/generate", "https://127.0.0.1:11435", "POST"),
                ("/api/generate", "http://127.0.0.1:11435", "GET"),
            ):
                outgoing = request(path, TICKET, origin, method)
                bridge.request_hook(outgoing)
                assert bridge.HEADER not in outgoing.headers
            outgoing = request("/api/chat")
            bridge.request_hook(outgoing)
            assert outgoing.headers[bridge.HEADER] == TICKET
        with patch.object(bridge, "report_completion"):
            native(processor(), attempt=TICKET)
        live = request(ticket=TICKET)
        bridge.request_hook(live)
        self.assertNotIn(bridge.HEADER, live.headers)

    def test_callback_no_auth_secret_no_redirects_and_bounded_retries(self):
        connections = []
        statuses = [503, 503, 202]
        class Connection:
            def __init__(self, host, port, timeout):
                self.host, self.port, self.timeout = host, port, timeout
                self.closed = False
                connections.append(self)
            def request(self, *args, **kwargs):
                self.args, self.kwargs = args, kwargs
            def getresponse(self):
                return types.SimpleNamespace(status=statuses.pop(0))
            def close(self):
                self.closed = True
        attempt = bridge.Attempt(TICKET, bridge.callback_url(client()), "success", "generation_finished")
        with patch.object(bridge.http.client, "HTTPConnection", Connection), patch.object(bridge.time, "sleep"):
            self.assertTrue(bridge.report_completion(attempt))
            self.assertEqual(len(connections), 3)
            self.assertTrue(all(connection.closed for connection in connections))
            sent = connections[0]
            self.assertEqual(sent.args, ("POST", bridge.CALLBACK_PATH))
            self.assertEqual(set(sent.kwargs["headers"]), {bridge.HEADER, "Content-Type"})
            self.assertEqual(json.loads(sent.kwargs["body"]), {"outcome": "success", "reason": "generation_finished"})
            self.assertNotIn("must-not-leave", str(sent.kwargs))
            statuses[:] = [302]
            connections.clear()
            self.assertFalse(bridge.report_completion(attempt))
            self.assertEqual(len(connections), 1)
            statuses[:] = [503, 503, 503]
            connections.clear()
            self.assertFalse(bridge.report_completion(attempt))
            self.assertEqual(len(connections), 3)


class InstallerTests(unittest.TestCase):
    def test_modified_source_is_rejected_without_writing_any_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in installer.HASHES:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("changed source\n")
            with self.assertRaisesRegex(ValueError, "Unsupported Frigate source"):
                installer.prepare(root)
            self.assertFalse((root / "frigate/intermediary_bridge.py").exists())
            self.assertTrue(all((root / path).read_text() == "changed source\n" for path in installer.HASHES))

    @unittest.skipUnless(os.environ.get("FRIGATE_BRIDGE_SOURCE_FIXTURES"), "optional exact-source integration fixtures not provided")
    def test_all_exact_pinned_transforms_compile_and_expose_admin_capability(self):
        fixtures = Path(os.environ["FRIGATE_BRIDGE_SOURCE_FIXTURES"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for number, relative in enumerate(installer.HASHES):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(fixtures / f"{number}.py", path)
            prepared = installer.prepare(root)
            self.assertEqual(len(prepared), len(installer.HASHES) + 1)
            for path, source in prepared.items():
                compile(source, str(path), "exec")
            api = prepared[root / "frigate/api/review.py"]
            self.assertIn('"/intermediary/capabilities",\n    dependencies=[Depends(require_role(["admin"]))]', api)
            provider = prepared[root / "frigate/genai/plugins/ollama.py"]
            self.assertIn('event_hooks={"request": [intermediary_bridge.request_hook]}', provider)
            review = prepared[root / "frigate/data_processing/post/review_descriptions.py"]
            self.assertIn('kwargs={"attempt": request_data.get("attempt")}', review)
            self.assertIn("intermediary_bridge.start_analysis_thread", review)
            route = next(node for node in ast.parse(api).body
                         if isinstance(node, ast.AsyncFunctionDef)
                         and node.name == "regenerate_review_description")
            decorators = " ".join(ast.unparse(node) for node in route.decorator_list)
            self.assertIn("router.put('/review/{review_id}/regenerate_description'", decorators)
            self.assertIn("dependencies=[Depends(require_role(['admin']))]", decorators)

    @unittest.skipUnless(os.environ.get("FRIGATE_BRIDGE_SOURCE_FIXTURES"), "optional exact-source integration fixtures not provided")
    def test_stable_live_processing_and_ipc_lock_are_preserved(self):
        fixtures = Path(os.environ["FRIGATE_BRIDGE_SOURCE_FIXTURES"])
        originals = {relative: (fixtures / f"{number}.py").read_text()
                     for number, relative in enumerate(installer.HASHES)}

        def named_function(source, name):
            return next(node for node in ast.walk(ast.parse(source))
                        if isinstance(node, ast.FunctionDef) and node.name == name)

        # The new retained-review route must not replace stable live handling
        # or regress the stable IPC socket concurrency fix.
        for relative, name in (
            ("frigate/data_processing/post/review_descriptions.py", "process_data"),
            ("frigate/comms/embeddings_updater.py", "send_data"),
        ):
            original = originals[relative]
            transformed = installer.transform(relative, original)
            self.assertEqual(ast.dump(named_function(original, name)),
                             ast.dump(named_function(transformed, name)))


if __name__ == "__main__":
    unittest.main()

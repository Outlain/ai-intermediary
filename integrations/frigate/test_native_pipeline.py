"""Execute transformed native functions with controlled media/IPC/model stubs.

Optional exact-source fixtures are downloaded from the pinned public source;
set FRIGATE_BRIDGE_SOURCE_FIXTURES to a folder containing numbered .py files in
apply_bridge.HASHES order. No camera, network, model, or Frigate DB is accessed.
"""

import ast
import asyncio
import copy
import datetime
import os
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import Mock, patch

from test_bridge import bridge, client, installer, TICKET

NS = types.SimpleNamespace


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code = status_code
        super().__init__(detail)


def function(source, name, namespace):
    tree = ast.parse(source)
    node = next(node for node in ast.walk(tree)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name)
    node.decorator_list = [item for item in node.decorator_list
                           if isinstance(item, ast.Attribute)
                           and isinstance(item.value, ast.Name)
                           and item.value.id == "intermediary_bridge"]
    node.returns = None
    for arg in (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs):
        arg.annotation = None
    node.args.defaults = [ast.Constant(value=None) for value in node.args.defaults]
    module = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
    exec(compile(module, "<pinned-native-function>", "exec"), namespace)
    return namespace[name]


@unittest.skipUnless(os.environ.get("FRIGATE_BRIDGE_SOURCE_FIXTURES"), "optional exact-source integration fixtures not provided")
class NativePipelineTests(unittest.TestCase):
    def setUp(self):
        fixtures = Path(os.environ["FRIGATE_BRIDGE_SOURCE_FIXTURES"])
        self.sources = {path: installer.transform(path, (fixtures / f"{number}.py").read_text())
                        for number, path in enumerate(installer.HASHES)}
        self.events = []
        self.completed = threading.Event()
        self.provider = client()
        self.result = "valid description"
        self.media = [b"fake-jpeg"]
        self.event = NS(id="1789536912-abcde", camera="front", label="person", has_snapshot=False,
                        end_time=200, start_time=100)
        self.review_data = {
            "id": self.event.id, "camera": "front", "start_time": 100, "end_time": 200,
            "data": {"zones": [], "objects": [], "sub_labels": [], "verified_objects": []},
        }
        self.genai_config = NS(enabled=True, debug_save_thumbnails=False, additional_concerns=[],
                               preferred_language=None, activity_context_prompt="", response_style="default")
        self.camera = NS(objects=NS(genai=NS(enabled=True)), review=NS(genai=self.genai_config),
                         zones={}, get_formatted_name=lambda: "Front")
        self.config = NS(cameras={"front": self.camera},
                         model=NS(merged_labelmap={0: "person"}, all_attributes=[]),
                         semantic_search=NS(enabled=False))
        self.manager = NS(description_client=self.provider)
        self.namespace = {
            "intermediary_bridge": bridge, "datetime": datetime, "threading": threading,
            "copy": copy, "logger": Mock(), "DoesNotExist": LookupError,
            "model_to_dict": lambda value: copy.deepcopy(self.review_data),
            "ReviewSegment": NS(id="id", get=lambda query: self.event),
            "Event": NS(id="id", get=lambda query: self.event),
            "EmbeddingsRequestEnum": NS(regenerate_review_description=NS(value="regenerate_review_description")),
            "EventMetadataTypeEnum": NS(regenerate_description=NS(value="regenerate_description")),
            "RegenerateDescriptionEnum": lambda source: source,
            "TrackedObjectUpdateTypesEnum": NS(description="description"),
            "get_event_thumbnail_bytes": lambda event: self.media[0] if self.media else None,
            "ensure_jpeg_bytes": lambda image: image,
            "UPDATE_EVENT_DESCRIPTION": "event-description", "UPDATE_REVIEW_DESCRIPTION": "review-description",
            "JSONResponse": lambda **kwargs: NS(**kwargs),
        }
        review_tree = ast.parse(self.sources["frigate/data_processing/post/review_descriptions.py"])
        for node in review_tree.body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id in (
                        "RECORDING_BUFFER_EXTENSION_PERCENT", "MIN_RECORDING_DURATION",
                    ):
                        self.namespace[target.id] = ast.literal_eval(node.value)
        async def camera_access(*args, **kwargs):
            return None
        self.namespace["require_camera_access"] = camera_access

        def generate(*args):
            outgoing = NS(url="http://127.0.0.1:11435/api/generate", method="POST", headers={})
            bridge.request_hook(outgoing)
            self.events.append(("inference", outgoing.headers.get(bridge.HEADER)))
            return self.result
        self.provider.generate_object_description = generate
        def review_generate(*args):
            result = generate(*args)
            return NS(model_dump=lambda: {"scene": result}) if result else None
        self.provider.generate_review_description = review_generate

        def save(topic, data):
            self.events.append(("save", topic))
        self.processor = NS(genai_manager=self.manager, config=self.config,
                            requestor=NS(send_data=save), tracked_events={},
                            object_desc_speed=Mock(), object_desc_dps=Mock(),
                            review_desc_speed=Mock(), review_desc_dps=Mock(),
                            get_recording_frames=lambda *args, **kwargs: self.media)
        def completion(attempt):
            self.events.append(("completion", attempt.outcome, attempt.ticket))
            self.completed.set()
        self.report_patch = patch.object(bridge, "report_completion", side_effect=completion)
        self.report_patch.start()
        self.addCleanup(self.report_patch.stop)
        self.environment = patch.dict(os.environ, {"FRIGATE_INTERMEDIARY_BRIDGE": "1"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.fastapi = patch.dict(sys.modules, {"fastapi": NS(HTTPException=HTTPException)})
        self.fastapi.start()
        self.addCleanup(self.fastapi.stop)

    def attach(self, source, name):
        method = function(self.sources[source], name, self.namespace)
        setattr(self.processor, name, types.MethodType(method, self.processor))

    def prepare_review_pipeline(self):
        path = "frigate/data_processing/post/review_descriptions.py"
        function(self.sources[path], "run_analysis", self.namespace)
        for name in ("handle_request", "regenerate_description"):
            self.attach(path, name)
        context = NS(requestor=NS(send_data=lambda topic, data: self.processor.handle_request(topic, data)))
        native_ipc = function(self.sources["frigate/embeddings/__init__.py"], "regenerate_review_description", self.namespace)
        context.regenerate_review_description = types.MethodType(native_ipc, context)
        api = function(self.sources["frigate/api/review.py"], "regenerate_review_description", self.namespace)
        request = NS(headers={bridge.HEADER: TICKET}, app=NS(genai_manager=self.manager,
                     frigate_config=self.config, embeddings=context))
        return api, request

    def review_pipeline(self):
        api, request = self.prepare_review_pipeline()
        response = asyncio.run(api(request, self.event.id))
        self.assertEqual(response.status_code, 202)
        self.assertTrue(self.completed.wait(5), "Native generation never reported a terminal outcome")

    def object_pipeline(self):
        path = "frigate/data_processing/post/object_descriptions.py"
        for name in ("__regenerate_description", "_genai_embed_description", "handle_request"):
            self.attach(path, name)
        maintainer_type = type("ObjectProcessorStub", (), {})
        native = maintainer_type()
        native.handle_request = self.processor.handle_request
        self.namespace["ObjectDescriptionProcessor"] = maintainer_type
        maintainer = NS(post_processors=[native])
        metadata = function(self.sources["frigate/embeddings/maintainer.py"], "_process_event_metadata", self.namespace)
        def publish(payload, topic):
            self.events.append(("published-attempt", payload[3]))
            maintainer.event_metadata_subscriber = NS(check_for_update=lambda: (topic, payload))
            metadata(maintainer)
        api = function(self.sources["frigate/api/event.py"], "regenerate_description", self.namespace)
        request = NS(headers={bridge.HEADER: TICKET}, app=NS(genai_manager=self.manager,
                     frigate_config=self.config, event_metadata_updater=NS(publish=publish)))
        response = asyncio.run(api(request, self.event.id, NS(source="thumbnails", force=False)))
        self.assertEqual(response.status_code, 200)
        self.assertTrue(self.completed.wait(5))

    def test_review_actual_api_ipc_and_both_thread_boundaries_success(self):
        self.review_pipeline()
        self.assertEqual(self.events, [("inference", TICKET), ("save", "review-description"),
                                       ("completion", "success", TICKET)])

    def test_review_http_success_but_native_invalid_metadata_is_failure(self):
        self.result = None
        self.review_pipeline()
        self.assertEqual(self.events, [("inference", TICKET), ("completion", "failed", TICKET)])

    def test_review_media_preparation_failure_reports_without_inference(self):
        self.media = []
        self.review_pipeline()
        self.assertEqual(self.events, [("completion", "failed", TICKET)])

    def test_review_camera_access_denied_does_not_dispatch(self):
        async def denied(*args, **kwargs):
            raise PermissionError("camera access denied")
        self.namespace["require_camera_access"] = denied
        api, request = self.prepare_review_pipeline()
        request.app.embeddings.regenerate_review_description = Mock()
        with self.assertRaises(PermissionError):
            asyncio.run(api(request, self.event.id))
        request.app.embeddings.regenerate_review_description.assert_not_called()
        self.assertEqual(self.events, [])

    def test_review_invalid_ticket_does_not_dispatch(self):
        api, request = self.prepare_review_pipeline()
        request.headers[bridge.HEADER] = "invalid"
        request.app.embeddings.regenerate_review_description = Mock()
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(api(request, self.event.id))
        self.assertEqual(caught.exception.status_code, 400)
        request.app.embeddings.regenerate_review_description.assert_not_called()
        self.assertEqual(self.events, [])

    def test_review_unavailable_bridge_does_not_dispatch(self):
        api, request = self.prepare_review_pipeline()
        request.app.embeddings.regenerate_review_description = Mock()
        with patch.dict(os.environ, {"FRIGATE_INTERMEDIARY_BRIDGE": "0"}):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(api(request, self.event.id))
        self.assertEqual(caught.exception.status_code, 409)
        request.app.embeddings.regenerate_review_description.assert_not_called()
        self.assertEqual(self.events, [])

    def test_review_rejected_ipc_request_is_not_reported_as_accepted(self):
        api, request = self.prepare_review_pipeline()
        # Stable Frigate's socket lock returns an empty response when another
        # request owns the channel. No native worker was started in that case.
        request.app.embeddings.requestor.send_data = Mock(return_value="")
        response = asyncio.run(api(request, self.event.id))
        self.assertEqual(response.status_code, 503)
        request.app.embeddings.requestor.send_data.assert_called_once()
        self.assertEqual(self.events, [])

    def test_review_unfinished_or_disabled_camera_does_not_dispatch(self):
        api, request = self.prepare_review_pipeline()
        request.app.embeddings.regenerate_review_description = Mock()
        self.event.end_time = None
        self.assertEqual(asyncio.run(api(request, self.event.id)).status_code, 400)
        self.event.end_time = 200
        self.genai_config.enabled = False
        self.assertEqual(asyncio.run(api(request, self.event.id)).status_code, 400)
        self.config.cameras.clear()
        self.assertEqual(asyncio.run(api(request, self.event.id)).status_code, 400)
        request.app.embeddings.regenerate_review_description.assert_not_called()
        self.assertEqual(self.events, [])

    def test_review_untagged_regeneration_does_not_send_completion(self):
        api, request = self.prepare_review_pipeline()
        request.headers.clear()
        saved = threading.Event()
        original_save = self.processor.requestor.send_data

        def save(*args):
            original_save(*args)
            saved.set()

        self.processor.requestor.send_data = save
        response = asyncio.run(api(request, self.event.id))
        self.assertEqual(response.status_code, 202)
        self.assertTrue(saved.wait(5))
        self.assertEqual(self.events, [("inference", None), ("save", "review-description")])
        self.assertFalse(self.completed.is_set())

    def test_object_actual_api_ipc_provider_and_save_success(self):
        self.object_pipeline()
        self.assertEqual(self.events, [("published-attempt", TICKET), ("inference", TICKET),
                                       ("save", "event-description"), ("completion", "success", TICKET)])

    def test_object_missing_thumbnail_reports_without_inference(self):
        self.media = []
        self.object_pipeline()
        self.assertEqual(self.events, [("published-attempt", TICKET), ("completion", "failed", TICKET)])


if __name__ == "__main__":
    unittest.main()

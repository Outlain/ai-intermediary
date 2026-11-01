"""Apply an exact-source, fail-closed bridge to the Frigate v0.18.2 release.

Run during a derived image build, never against a running installation.
All hashes and transformations are validated before any destination is edited.
"""

import argparse
import ast
import hashlib
from pathlib import Path

PIN = "v0.18.2"
SOURCE_REF = "cfa08c56b23d23280c3d0a218e5a43182c97445b"
HASHES = {
    "frigate/api/event.py": "ed692d038f2427fe57a519de0095ef11bcf64b8a05fc8fb22e9c3ee5ce3e5af0",
    "frigate/api/review.py": "405bfe994f1033b19a5e7cdf31a2bc24c65a202c2720cf1467b10456571b59cb",
    "frigate/embeddings/__init__.py": "79150b2132fb223a40d2da78b3f22bfec4063b4e6fc57f36ba5e3e7dd4dc2bd9",
    "frigate/embeddings/maintainer.py": "4e7c3eb7bea5f051c4a0dd557b689d63fc14a26494b13806fe8e95f0c9f3e676",
    "frigate/data_processing/post/object_descriptions.py": "4cb97a62ebe73ae43e29e765cef193c075b6c84880b5a291033bf3082532cea4",
    "frigate/data_processing/post/review_descriptions.py": "126bd78461f75a7e3b565a3fa4fd70e1730eaa19f7d0527886f147314a2eb8ca",
    "frigate/genai/plugins/ollama.py": "c9fb96b05ffea84ab8c661e1accd0b16b71c9be2c265c69622ec78ddd360ef12",
    "frigate/comms/embeddings_updater.py": "6ae5416cad92782cc1d2b4423e82f4fa08e75fdf3a57397945de5eebc0421bc6",
}

# Narrow backport of retained-review regeneration from upstream Frigate
# bb6c2e98ebb130de032a6be9c087b69af3f4b9e8. The v0.18.2 release remains the
# source of truth for auth, IPC locking, model config, live generation and
# recording access. No development-only configuration or database fields are
# introduced. Native request validation is retained; a busy/unhandled IPC
# request is not falsely acknowledged as accepted.
REVIEW_REGENERATION_API = '''

@router.put(
    "/review/{review_id}/regenerate_description",
    response_model=GenericResponse,
    dependencies=[Depends(require_role(["admin"]))],
    summary="Generate a review item description",
    description="""Re-runs a finished review item through GenAI descriptions.
    Frames come from recordings. Explicit requests accept both alerts and
    detections regardless of the camera's alerts/detections toggles.
    """,
)
async def regenerate_review_description(request: Request, review_id: str):
    attempt = intermediary_bridge.request_attempt(request)
    try:
        review: ReviewSegment = ReviewSegment.get(ReviewSegment.id == review_id)
    except DoesNotExist:
        return JSONResponse(
            content={"success": False, "message": "Review " + review_id + " not found"},
            status_code=404,
        )

    await require_camera_access(review.camera, request=request)

    if review.end_time is None:
        return JSONResponse(
            content={"success": False, "message": "Review " + review_id + " has not ended yet"},
            status_code=400,
        )

    camera_config = request.app.frigate_config.cameras.get(review.camera)
    if camera_config is None or not camera_config.review.genai.enabled:
        return JSONResponse(
            content={"success": False, "message": "GenAI descriptions must be enabled for this camera"},
            status_code=400,
        )

    if request.app.genai_manager.description_client is None:
        return JSONResponse(
            content={"success": False, "message": "A GenAI provider with the descriptions role must be configured"},
            status_code=400,
        )

    context: EmbeddingsContext = request.app.embeddings
    if context.regenerate_review_description(review_id, attempt=attempt) != "started":
        return JSONResponse(
            content={"success": False, "message": "Review description worker did not accept the request; retry later"},
            status_code=503,
        )

    return JSONResponse(
        content={"success": True, "message": "Review " + review_id + " description generation has been requested"},
        status_code=202,
    )
'''

REVIEW_REGENERATION_METHOD = '''
    @intermediary_bridge.native_attempt
    def regenerate_description(self, review_id: str) -> None:
        """Regenerate one finished review using retained recording frames.

        Explicit requests permit both severities but still require the camera's
        review GenAI configuration. Missing media fails without replacing any
        previously saved metadata.
        """
        if self.genai_manager.description_client is None:
            logger.error("No GenAI provider is assigned the descriptions role")
            return

        try:
            review: ReviewSegment = ReviewSegment.get(ReviewSegment.id == review_id)
        except DoesNotExist:
            logger.error("Review item %s not found for description generation", review_id)
            return

        camera_config = self.config.cameras.get(str(review.camera))
        if camera_config is None:
            logger.error("Camera %s no longer exists", review.camera)
            return
        if not camera_config.review.genai.enabled:
            logger.error("GenAI review descriptions are not enabled for %s", review.camera)
            return

        final_data = model_to_dict(review)
        if final_data["end_time"] is None:
            logger.error("Review item %s has not ended yet", review_id)
            return

        duration = final_data["end_time"] - final_data["start_time"]
        buffer_extension = min(5, duration * RECORDING_BUFFER_EXTENSION_PERCENT)
        if duration + (2 * buffer_extension) < MIN_RECORDING_DURATION:
            buffer_extension = min(5, (MIN_RECORDING_DURATION - duration) / 2)
        thumbs = self.get_recording_frames(
            str(review.camera),
            final_data["start_time"] - buffer_extension,
            final_data["end_time"] + buffer_extension,
            height=480,
        )
        if not thumbs:
            logger.error("No recording frames are available for review item %s", review_id)
            return

        if camera_config.review.genai.debug_save_thumbnails:
            Path(os.path.join(CLIPS_DIR, "genai-requests", review_id)).mkdir(
                parents=True, exist_ok=True
            )
            for idx, frame_bytes in enumerate(thumbs):
                with open(
                    os.path.join(CLIPS_DIR, f"genai-requests/{review_id}/{idx}.jpg"),
                    "wb",
                ) as output:
                    output.write(frame_bytes)

        self.review_desc_dps.update()
        intermediary_bridge.start_analysis_thread(
            target=run_analysis,
            args=(
                self.requestor,
                self.genai_manager.description_client,
                self.review_desc_speed,
                camera_config,
                final_data,
                thumbs,
                camera_config.review.genai,
                list(self.config.model.merged_labelmap.values()),
                self.config.model.all_attributes,
            ),
        )

'''


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise ValueError("Bridge patch context did not match exactly once")
    return source.replace(old, new, 1)


def add_import(source):
    return replace_once(source, "import logging\n", "import logging\n\nfrom frigate import intermediary_bridge\n")


def transform(path, source):
    if path == "frigate/api/event.py":
        source = add_import(source)
        source = replace_once(
            source,
            "    request: Request, event_id: str, params: RegenerateQueryParameters = Depends()\n):\n    try:",
            "    request: Request, event_id: str, params: RegenerateQueryParameters = Depends()\n):\n    attempt = intermediary_bridge.request_attempt(request)\n    try:",
        )
        return replace_once(source, "(event.id, params.source, params.force),", "(event.id, params.source, params.force, attempt),")

    if path == "frigate/api/review.py":
        source = add_import(source)
        return source + REVIEW_REGENERATION_API + '''\n\n@router.get(
    "/intermediary/capabilities",
    dependencies=[Depends(require_role(["admin"]))],
    summary="Ollama intermediary native completion bridge capabilities",
)
def intermediary_capabilities(request: Request):
    return intermediary_bridge.capabilities(
        request.app.genai_manager.description_client
    )
'''

    if path == "frigate/embeddings/__init__.py":
        return replace_once(
            source,
            "    def generate_review_summary(self, start_ts: float, end_ts: float) -> str | None:\n",
            '''    def regenerate_review_description(self, review_id: str, attempt: str | None = None) -> str | None:
        return self.requestor.send_data(
            EmbeddingsRequestEnum.regenerate_review_description.value,
            {"review_id": review_id, "attempt": attempt},
        )

    def generate_review_summary(self, start_ts: float, end_ts: float) -> str | None:
''',
        )

    if path == "frigate/comms/embeddings_updater.py":
        return replace_once(
            source,
            '    summarize_review = "summarize_review"\n',
            '    summarize_review = "summarize_review"\n    regenerate_review_description = "regenerate_review_description"\n',
        )

    if path == "frigate/embeddings/maintainer.py":
        source = replace_once(source, "        event_id, source, force = payload", "        event_id, source, force = payload[:3]\n        attempt = payload[3] if len(payload) == 4 else None")
        return replace_once(source, '"source": RegenerateDescriptionEnum(source),\n                            "force": force,', '"source": RegenerateDescriptionEnum(source),\n                            "force": force,\n                            "attempt": attempt,')

    if path == "frigate/data_processing/post/object_descriptions.py":
        source = add_import(source)
        source = replace_once(source, "    def __regenerate_description(self, event_id: str, source: str, force: bool) -> None:", "    @intermediary_bridge.native_attempt\n    def __regenerate_description(self, event_id: str, source: str, force: bool) -> None:")
        source = replace_once(source, 'data["event_id"], data["source"], data["force"]', 'data["event_id"], data["source"], data["force"], attempt=data.get("attempt")')
        return replace_once(source, "        # Embed the description\n", "        intermediary_bridge.mark_success()\n\n        # Embed the description\n")

    if path == "frigate/data_processing/post/review_descriptions.py":
        source = add_import(source)
        source = replace_once(source, "from peewee import DoesNotExist\n", "from peewee import DoesNotExist\nfrom playhouse.shortcuts import model_to_dict\n")
        source = replace_once(
            source,
            "        if topic == EmbeddingsRequestEnum.summarize_review.value:\n",
            '''        if topic == EmbeddingsRequestEnum.regenerate_review_description.value:
            review_id = request_data["review_id"]
            # Extraction and inference must not block the embeddings IPC loop.
            threading.Thread(
                target=self.regenerate_description,
                name=f"regenerate_review_description_{review_id}",
                daemon=True,
                args=(review_id,),
                kwargs={"attempt": request_data.get("attempt")},
            ).start()
            return "started"
        elif topic == EmbeddingsRequestEnum.summarize_review.value:
''',
        )
        source = replace_once(source, "    def get_cache_frames(\n", REVIEW_REGENERATION_METHOD + "    def get_cache_frames(\n")
        return replace_once(source, '            "after": {k: v for k, v in final_data.items()},\n        },\n    )', '            "after": {k: v for k, v in final_data.items()},\n        },\n    )\n    intermediary_bridge.mark_success()')

    if path == "frigate/genai/plugins/ollama.py":
        source = add_import(source)
        return replace_once(source, "                headers=self._auth_headers(),\n            )\n            if not self.validate_model:", "                headers=self._auth_headers(),\n                event_hooks={\"request\": [intermediary_bridge.request_hook]},\n            )\n            if not self.validate_model:")
    raise ValueError("Unknown source path")


def prepare(root):
    prepared = {}
    for relative, expected in HASHES.items():
        path = root / relative
        original = path.read_bytes()
        if hashlib.sha256(original).hexdigest() != expected:
            raise ValueError(f"Unsupported Frigate source: {relative}; exact {PIN} sources required")
        patched = transform(relative, original.decode("utf-8"))
        ast.parse(patched, filename=relative)
        prepared[path] = patched
    bridge = Path(__file__).with_name("bridge.py").read_text()
    ast.parse(bridge, filename="frigate/intermediary_bridge.py")
    target = root / "frigate/intermediary_bridge.py"
    if target.exists():
        raise ValueError("Bridge already exists; rebuild from the original pinned image")
    prepared[target] = bridge
    return prepared


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="directory containing the frigate Python package")
    parser.add_argument("--check", action="store_true", help="verify hashes and patch syntax without writing")
    args = parser.parse_args()
    try:
        prepared = prepare(args.root)
    except (OSError, UnicodeError, ValueError, SyntaxError) as error:
        parser.exit(1, f"Bridge refused: {error}\n")
    if not args.check:
        for path, source in prepared.items():
            path.write_text(source)
    print(f"Frigate {PIN} bridge {'validated' if args.check else 'installed'} ({len(prepared)} files)")


if __name__ == "__main__":
    main()

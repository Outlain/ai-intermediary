"""Local-only ComfyUI admission guard and narrowly scoped output cleanup.

This is not a Python-node sandbox. Install only audited nodes and protect the
raw service port. No shell commands, service restarts or GPU resets occur here.
"""

import asyncio
import contextvars
import copy
import hmac
import json
import os
import re
import stat
import threading
import uuid

PROTOCOL = "ai-intermediary-comfy-v1"
HEADER = "X-AI-Intermediary-Token"
NAMESPACE = "ai-intermediary"
MAX_BODY = 4 * 1024 * 1024  # 2 MiB workflow plus bounded transport metadata
MAX_LEDGER = 8 * 1024 * 1024
MAX_JOBS = 100_000
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
NODE_ID = re.compile(r"^[a-zA-Z0-9_.:-]{1,128}$")
SAVE_NODES = frozenset(("SaveImage", "SaveAnimatedWEBP", "SaveVideo", "VHS_VideoCombine"))
PREVIEW_NODES = frozenset(("PreviewImage", "PreviewAny"))
REMOTE_NODE = re.compile(r"openai|anthropic|replicate|falai|kling|runway|veo|luma|ideogram|comfy_api_nodes|wan2[._]?7", re.I)
_submission = contextvars.ContextVar("ai_intermediary_submission", default=None)


class BridgeError(Exception):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code = code
        self.status = status


def valid_id(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise BridgeError("invalid_prompt_id")
    return value


def descriptor(value, prompt_id):
    if not isinstance(value, dict) or value.get("type") != "output":
        raise BridgeError("invalid_artifact")
    filename, subfolder = value.get("filename"), value.get("subfolder", "")
    if (not isinstance(filename, str) or not filename or len(filename) > 255
            or filename in (".", "..") or re.search(r"[\x00-\x1f\x7f/\\:\[\]]", filename)):
        raise BridgeError("invalid_artifact")
    if (not isinstance(subfolder, str) or len(subfolder) > 1024
            or re.search(r"[\x00-\x1f\x7f\\:\[\]]", subfolder)
            or any(part in ("", ".", "..") for part in subfolder.split("/"))):
        raise BridgeError("invalid_artifact")
    if subfolder != f"{NAMESPACE}/{prompt_id}":
        raise BridgeError("artifact_not_owned", 403)
    return {"filename": filename, "subfolder": subfolder, "type": "output"}


def _safe_inputs(value, depth=0, key=""):
    if depth > 32:
        raise BridgeError("workflow_too_deep")
    if isinstance(value, str):
        if re.match(r"^(?:https?|ftp|file|s3|gs)://|^//", value.strip(), re.I):
            raise BridgeError("remote_input_forbidden")
        if re.search(r"filename|filepath|file_path|directory|folder|prefix|ckpt_name|model_name|image|video", key, re.I):
            if (value.startswith(("/", "\\")) or re.match(r"^[a-z]:", value, re.I)
                    or ".." in re.split(r"[/\\]", value)):
                raise BridgeError("unsafe_input_path")
    elif isinstance(value, dict):
        for name, child in value.items():
            if name in ("__proto__", "prototype", "constructor"):
                raise BridgeError("invalid_workflow")
            _safe_inputs(child, depth + 1, name)
    elif isinstance(value, list):
        for child in value:
            _safe_inputs(child, depth + 1, key)


class Guard:
    def __init__(self, server, node_registry, output_root, *, token, disable_api_nodes):
        self.server = server
        self.node_registry = node_registry
        self.token = token if isinstance(token, str) and token.strip() and len(token) <= 4096 and not re.search(r"[\r\n]", token) else ""
        self.disable_api_nodes = disable_api_nodes is True
        self.instance_id = str(uuid.uuid4())
        self.output_root = os.path.realpath(output_root)
        self.owned = set()
        self.lock = threading.RLock()
        self.storage_error = False
        self.installed = False
        self._original_put = server.prompt_queue.put
        # Install the queue fence before storage initialization. Initialization
        # failure must never leave the queue open to unscheduled raw requests.
        server.prompt_queue.put = self.guarded_put
        try:
            self._read_ledger()
        except (OSError, ValueError, BridgeError):
            self.storage_error = True

    def status(self):
        return {
            "protocol": PROTOCOL,
            "local_only": self.installed and self.disable_api_nodes and bool(self.token) and not self.storage_error,
            "instance_id": self.instance_id,
            "pid": os.getpid(),
            "queue_guard": self.installed,
            "stable_prompt_ids": True,
            "owned_output_cleanup": True,
            "storage_healthy": not self.storage_error,
            "output_namespace": NAMESPACE,
        }

    def authenticate(self, supplied):
        if not self.token or not isinstance(supplied, str) or not hmac.compare_digest(supplied.encode(), self.token.encode()):
            raise BridgeError("bridge_auth_required", 401)

    def _namespace_fd(self):
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        root_fd = os.open(self.output_root, flags)
        try:
            try:
                os.mkdir(NAMESPACE, 0o700, dir_fd=root_fd)
            except FileExistsError:
                pass
            return os.open(NAMESPACE, flags, dir_fd=root_fd)
        finally:
            os.close(root_fd)

    def _read_ledger(self):
        directory = self._namespace_fd()
        try:
            try:
                fd = os.open(".broker-owned-jobs.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            except FileNotFoundError:
                return
            with os.fdopen(fd, "rb") as file:
                info = os.fstat(file.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_LEDGER:
                    raise BridgeError("invalid_ownership_ledger")
                saved = json.loads(file.read(MAX_LEDGER + 1))
            if (not isinstance(saved, dict) or saved.get("schema_version") != 1
                    or not isinstance(saved.get("prompt_ids"), list) or len(saved["prompt_ids"]) > MAX_JOBS):
                raise BridgeError("invalid_ownership_ledger")
            self.owned = {valid_id(value) for value in saved["prompt_ids"]}
        finally:
            os.close(directory)

    def _record_id(self, prompt_id):
        if prompt_id in self.owned:
            raise BridgeError("duplicate_prompt_id", 409)
        if len(self.owned) >= MAX_JOBS:
            raise BridgeError("ownership_ledger_full", 507)
        updated = self.owned | {prompt_id}
        data = json.dumps({"schema_version": 1, "prompt_ids": sorted(updated)}, separators=(",", ":")).encode()
        if len(data) > MAX_LEDGER:
            raise BridgeError("ownership_ledger_full", 507)
        directory = self._namespace_fd()
        temporary = f".ledger-{uuid.uuid4()}.tmp"
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            with os.fdopen(fd, "wb") as file:
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, ".broker-owned-jobs.json", src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
            self.owned = updated
        finally:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass
            os.close(directory)

    def prepare(self, payload):
        if not self.status()["local_only"]:
            raise BridgeError("local_bridge_not_ready", 503)
        if not isinstance(payload, dict) or set(payload) - {"prompt", "prompt_id", "client_id", "extra_data"}:
            raise BridgeError("invalid_submission")
        prompt_id = valid_id(payload.get("prompt_id"))
        prompt = payload.get("prompt")
        if not isinstance(prompt, dict) or not 1 <= len(prompt) <= 512:
            raise BridgeError("invalid_workflow")
        if prompt_id in self.owned:
            raise BridgeError("duplicate_prompt_id", 409)
        extra = payload.get("extra_data", {})
        if not isinstance(extra, dict) or set(extra) - {"extra_pnginfo"}:
            raise BridgeError("api_credentials_forbidden")
        prepared = copy.deepcopy(payload)
        for node_id, node in prepared["prompt"].items():
            if not isinstance(node_id, str) or not NODE_ID.fullmatch(node_id) or not isinstance(node, dict):
                raise BridgeError("invalid_workflow")
            class_type, inputs = node.get("class_type"), node.get("inputs")
            if not isinstance(class_type, str) or not isinstance(inputs, dict) or class_type not in self.node_registry:
                raise BridgeError("unknown_node")
            cls = self.node_registry[class_type]
            info = cls.GET_NODE_INFO_V1() if hasattr(cls, "GET_NODE_INFO_V1") else {}
            if not isinstance(info, dict):
                raise BridgeError("unknown_node")
            module = getattr(cls, "RELATIVE_PYTHON_MODULE", getattr(cls, "__module__", ""))
            if (getattr(cls, "API_NODE", False) or info.get("api_node") or REMOTE_NODE.search(f"{class_type} {module}")
                    or re.search(r"api[ _/-]?nodes|partner[ _/-]?nodes", str(info.get("category", "")), re.I)):
                raise BridgeError("cloud_node_forbidden")
            _safe_inputs(inputs)
            if class_type in SAVE_NODES:
                inputs["filename_prefix"] = f"{NAMESPACE}/{prompt_id}/node-{node_id.replace(':', '-')}"
                if class_type == "VHS_VideoCombine" and inputs.get("save_output", True) is not True:
                    raise BridgeError("video_output_save_required")
            elif (getattr(cls, "OUTPUT_NODE", False) or info.get("output_node")) and class_type not in PREVIEW_NODES:
                raise BridgeError("unsupported_output_node")
        return prepared

    def guarded_put(self, item):
        context = _submission.get()
        if (not self.status()["local_only"] or not isinstance(context, dict) or context.get("enqueued")
                or not isinstance(item, (tuple, list)) or len(item) < 4 or item[1] != context.get("prompt_id")):
            raise BridgeError("unscheduled_or_unsupported_prompt", 409)
        # Check the actual final graph, after other custom on_prompt handlers.
        final = self.prepare({"prompt_id": item[1], "prompt": item[2]})
        with self.lock:
            try:
                self._record_id(item[1])
            except OSError:
                self.storage_error = True
                raise BridgeError("ownership_storage_failed", 503) from None
            copied = list(item)
            copied[2] = final["prompt"]
            context["enqueued"] = True
            return self._original_put(tuple(copied))

    def _history_artifacts(self, prompt_id):
        if prompt_id not in self.owned:
            raise BridgeError("job_not_owned", 403)
        running, pending = self.server.prompt_queue.get_current_queue()
        if any(item[1] == prompt_id for item in [*running, *pending]):
            raise BridgeError("job_not_complete", 409)
        record = self.server.prompt_queue.get_history(prompt_id=prompt_id).get(prompt_id)
        if not isinstance(record, dict):
            raise BridgeError("completion_history_unavailable", 409)
        status_value, prompt = record.get("status", {}), record.get("prompt")
        if (not isinstance(status_value, dict) or status_value.get("completed") is not True
                or status_value.get("status_str") != "success" or not isinstance(prompt, (list, tuple))
                or len(prompt) < 2 or prompt[1] != prompt_id):
            raise BridgeError("job_not_successful", 409)
        results = []
        outputs = record.get("outputs", {})
        if not isinstance(outputs, dict):
            raise BridgeError("invalid_completion_history", 409)
        for node in outputs.values():
            if not isinstance(node, dict):
                continue
            for key in ("images", "gifs", "videos", "audio"):
                entries = node.get(key, [])
                if not isinstance(entries, list):
                    continue
                for entry in entries:
                    try:
                        clean = descriptor(entry, prompt_id)
                        if clean not in results:
                            results.append(clean)
                    except BridgeError:
                        continue
        return results

    def _unlink_owned(self, value):
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        fd = os.open(self.output_root, flags)
        try:
            for part in value["subfolder"].split("/"):
                next_fd = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            info = os.stat(value["filename"], dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                raise BridgeError("artifact_not_regular", 403)
            os.unlink(value["filename"], dir_fd=fd)
            return True
        except FileNotFoundError:
            return False
        except OSError:
            raise BridgeError("artifact_path_unsafe", 403) from None
        finally:
            os.close(fd)

    def delete_artifacts(self, payload):
        if not isinstance(payload, dict):
            raise BridgeError("invalid_delete_request")
        prompt_id = valid_id(payload.get("prompt_id"))
        values = payload.get("artifacts")
        if not isinstance(values, list) or len(values) > 1024:
            raise BridgeError("invalid_artifact_list")
        allowed = self._history_artifacts(prompt_id)
        clean = [descriptor(value, prompt_id) for value in values]
        if any(value not in allowed for value in clean):
            raise BridgeError("artifact_not_in_completed_job", 403)
        unique = list({json.dumps(value, sort_keys=True): value for value in clean}.values())
        deleted = sum(self._unlink_owned(value) for value in unique)
        return {"prompt_id": prompt_id, "deleted": deleted, "missing": len(unique) - deleted}


async def read_json(request):
    if request.content_length is not None and request.content_length > MAX_BODY:
        raise BridgeError("request_too_large", 413)
    cached = getattr(request, "_read_bytes", None)
    if cached is not None:
        body = cached
    else:
        chunks, size = [], 0
        async for chunk in request.content.iter_chunked(65536):
            size += len(chunk)
            if size > MAX_BODY:
                raise BridgeError("request_too_large", 413)
            chunks.append(chunk)
        body = b"".join(chunks)
    if len(body) > MAX_BODY:
        raise BridgeError("request_too_large", 413)
    try:
        return json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise BridgeError("invalid_json") from None


def install(server, node_registry, output_root, *, web, token=None, disable_api_nodes=False):
    guard = Guard(server, node_registry, output_root,
                  token=token if token is not None else os.environ.get("AI_INTERMEDIARY_COMFY_TOKEN", ""),
                  disable_api_nodes=disable_api_nodes)

    @web.middleware
    async def middleware(request, handler):
        try:
            # No public raw API, WebSocket or browser session bypass. The broker
            # injects the header on its authenticated browser gateway requests.
            guard.authenticate(request.headers.get(HEADER))
            route = request.path[4:] if request.path.startswith("/api/") else request.path
            if request.method == "POST" and route == "/prompt":
                prepared = guard.prepare(await asyncio.wait_for(read_json(request), 15))
                request._read_bytes = json.dumps(prepared, separators=(",", ":")).encode()
                context = {"prompt_id": prepared["prompt_id"], "enqueued": False}
                ticket = _submission.set(context)
                try:
                    return await handler(request)
                finally:
                    _submission.reset(ticket)
            return await handler(request)
        except BridgeError as error:
            return web.json_response({"error": error.code}, status=error.status)
        except asyncio.TimeoutError:
            return web.json_response({"error": "body_timeout"}, status=408)

    async def status_route(request):
        guard.authenticate(request.headers.get(HEADER))
        return web.json_response(guard.status())

    async def delete_route(request):
        guard.authenticate(request.headers.get(HEADER))
        payload = await asyncio.wait_for(read_json(request), 15)
        return web.json_response(guard.delete_artifacts(payload))

    server.app.middlewares.insert(0, middleware)
    server.routes.get("/intermediary/status")(status_route)
    server.routes.post("/intermediary/outputs/delete")(delete_route)
    guard.installed = True
    return guard

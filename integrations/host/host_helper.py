#!/usr/bin/env python3
"""Optional local-only AMD telemetry and narrowly scoped Ollama restart helper.

No dependencies beyond Python 3.10+. See README.md before installing. This
process has no GPU reset, reboot, arbitrary-command or process-kill endpoint.
"""

import datetime as dt
import fcntl
import http.server
import json
import math
import os
from pathlib import Path
import re
import selectors
import socket
import socketserver
import stat
import subprocess
import tempfile
import threading
import time
import uuid
from urllib.parse import urlsplit, parse_qs

PROTOCOL = "ollama-intermediary-host-v1"
MAX_OUTPUT = 1024 * 1024
MAX_BODY = 2048
MAX_OPERATIONS = 100000
COOLDOWN = 300
WINDOW = 3600
MAX_RESTARTS = 2


def comfyui_units(value):
    """Root-managed read-only unit allowlist; never a command supplied by HTTP."""
    if not isinstance(value, str):
        raise SafeError("invalid_comfyui_units")
    units = [unit.strip() for unit in value.split(",") if unit.strip()]
    if (len(units) > 8 or len(set(units)) != len(units)
            or any(len(unit) > 128 or not re.fullmatch(r"[a-zA-Z0-9_.@-]+\.service", unit)
                   or unit == "ollama.service" for unit in units)):
        raise SafeError("invalid_comfyui_units")
    return tuple(units)


def read_small(path, limit=65536):
    with open(path, encoding="utf-8") as stream:
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise SafeError("host_data_limit")
    return value


def valid_workers(value):
    return (isinstance(value, dict) and 0 < len(value) <= 4096
            and all(re.fullmatch(r"[1-9][0-9]{0,9}", str(pid))
                    and isinstance(start, str) and re.fullmatch(r"[0-9]{1,24}", start)
                    for pid, start in value.items()))


def valid_proof(value):
    return bool(isinstance(value, dict) and valid_workers(value.get("workers"))
            and isinstance(value.get("boot_id"), str)
            and re.fullmatch(r"[a-f0-9-]{36}", value["boot_id"]))


class SafeError(Exception):
    """Errors exposed to clients contain a fixed code, never command output."""


def utc_now(timestamp=None):
    return dt.datetime.fromtimestamp(time.time() if timestamp is None else timestamp,
                                     dt.timezone.utc).isoformat().replace("+00:00", "Z")


def run_command(argv, timeout=4, max_output=MAX_OUTPUT):
    """Bound memory, runtime and output. Never shell-expand arguments."""
    try:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, close_fds=True,
                                 env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin:/opt/rocm/bin",
                                      "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"})
    except OSError:
        raise SafeError("command_unavailable") from None
    selector = selectors.DefaultSelector()
    output = bytearray()
    received = 0
    deadline = time.monotonic() + timeout
    try:
        for stream in (child.stdout, child.stderr):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SafeError("command_timeout")
            for key, _ in selector.select(min(remaining, 0.1)):
                chunk = os.read(key.fileobj.fileno(), 16384)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                received += len(chunk)
                if received > max_output:
                    raise SafeError("command_output_limit")
                if key.fileobj is child.stdout:
                    output.extend(chunk)
        child.wait(timeout=max(0.01, deadline - time.monotonic()))
        if child.returncode != 0:
            raise SafeError("command_failed")
        return output.decode("utf-8", errors="strict")
    except (UnicodeError, subprocess.TimeoutExpired):
        raise SafeError("command_invalid_output") from None
    finally:
        selector.close()
        if child.poll() is None:
            child.kill()  # Only our bounded diagnostic/sudo subprocess, never a GPU worker.
        child.wait()
        child.stdout.close()
        child.stderr.close()


def normalize(value):
    if isinstance(value, dict):
        return {str(key).lower(): normalize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize(item) for item in value]
    return value


def quantity(value, memory=False):
    """AMD JSON uses {value,unit}; text/string fields are also accepted."""
    unit = ""
    if isinstance(value, dict):
        unit, value = str(value.get("unit", "")), value.get("value")
    if isinstance(value, str):
        match = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*([A-Za-z%°]*)\s*", value)
        if not match:
            return None
        value, suffix = match.groups()
        unit = suffix or unit
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(result) or result < 0:
        return None
    if memory:
        # AMD SMI labels binary MiB/GiB as MB/GB in its CLI.
        scales = {"b": 1, "kb": 1024, "kib": 1024, "mb": 1024 ** 2,
                  "mib": 1024 ** 2, "gb": 1024 ** 3, "gib": 1024 ** 3}
        if unit.lower() not in scales:
            return None
        return int(result * scales[unit.lower()])
    return result


def gpu_rows(payload):
    payload = normalize(payload)
    if isinstance(payload, dict) and "gpu" in payload:
        payload = [payload]
    elif isinstance(payload, dict):
        payload = payload.get("gpu_data", payload.get("gpus"))
    if not isinstance(payload, list) or not payload or len(payload) > 64:
        raise SafeError("telemetry_invalid")
    result = {}
    for row in payload:
        if not isinstance(row, dict) or "gpu" not in row:
            raise SafeError("telemetry_invalid")
        gpu_id = str(row["gpu"])
        if not re.fullmatch(r"\d{1,4}", gpu_id) or gpu_id in result:
            raise SafeError("telemetry_invalid")
        result[gpu_id] = row
    return result


def parse_processes(row, owner):
    if row is None:
        return [], False
    data = row.get("process_list", row.get("process_info"))
    if isinstance(data, str):
        return ([], True) if data.strip().lower() == "no running processes detected" else ([], False)
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list) or len(data) > 4096:
        return [], False
    if len(data) == 1 and isinstance(data[0], dict):
        sentinel = data[0].get("process_info")
        if isinstance(sentinel, str) and sentinel.strip().lower() == "no running processes detected":
            return [], True
    processes = []
    known = True
    for entry in data:
        if not isinstance(entry, dict):
            return [], False
        info = entry.get("process_info", entry)
        if not isinstance(info, dict):
            return [], False
        pid = info.get("pid")
        if isinstance(pid, str) and pid.isdigit():
            pid = int(pid)
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
            return [], False
        ownership = owner(pid)
        known = known and ownership is not None
        memory = info.get("memory_usage", {})
        process = {"pid": pid, "name": None, "vram_bytes": None,
                   "is_ollama": ownership is True, "is_comfyui": False}
        if isinstance(info.get("name"), str) and info["name"] != "N/A":
            process["name"] = re.sub(r"[^\w .+:/-]", "", info["name"])[:80]
        if isinstance(memory, dict):
            process["vram_bytes"] = quantity(memory.get("vram_mem"), memory=True)
        processes.append(process)
    return processes, known


def parse_telemetry(metrics, process_payload, owner):
    rows, process_rows = gpu_rows(metrics), gpu_rows(process_payload)
    if set(rows) != set(process_rows):
        raise SafeError("telemetry_gpu_mismatch")
    gpus = []
    for gpu_id, row in rows.items():
        sections = []
        for key in ("mem_usage", "usage", "temperature", "power"):
            value = row.get(key)
            if value is None or value == "N/A":
                value = {}
            if not isinstance(value, dict):
                raise SafeError("telemetry_invalid")
            sections.append(value)
        memory, usage, temperature, power = sections
        processes, known = parse_processes(process_rows.get(gpu_id), owner)
        total = quantity(memory.get("total_vram"), memory=True)
        used = quantity(memory.get("used_vram"), memory=True)
        free = quantity(memory.get("free_vram"), memory=True)
        if total is not None and ((used is not None and used > total) or
                                  (free is not None and free > total)):
            raise SafeError("telemetry_invalid")
        utilization = quantity(usage.get("gfx_activity"))
        if utilization is not None and utilization > 100:
            utilization = None
        gpus.append({"id": gpu_id, "name": None,
                     "vram_total_bytes": total, "vram_used_bytes": used,
                     "vram_free_bytes": free, "utilization_percent": utilization,
                     "temperature_c": quantity(temperature.get("edge")),
                     "power_w": quantity(power.get("socket_power")),
                     "processes": processes, "processes_known": known})
    return {"available": True, "error": None, "gpus": gpus}


class SystemHost:
    def __init__(self, amd_smi="/opt/rocm/bin/amd-smi", runner=run_command,
                 proc_root="/proc", cgroup_root="/sys/fs/cgroup", comfyui_systemd_units=""):
        if not os.path.isabs(amd_smi):
            raise SafeError("invalid_amd_smi_path")
        self.amd_smi, self.runner = amd_smi, runner
        self.proc_root, self.cgroup_root = Path(proc_root), Path(cgroup_root)
        self.comfyui_systemd_units = comfyui_units(comfyui_systemd_units)

    def boot_id(self):
        try:
            value = read_small(self.proc_root / "sys/kernel/random/boot_id").strip()
            if not re.fullmatch(r"[a-f0-9-]{36}", value):
                raise ValueError()
            return value
        except (OSError, ValueError):
            raise SafeError("host_boot_identity_unknown") from None

    def process_started_at(self, pid):
        # btime has one-second precision. This is a conservative LOWER bound;
        # external recovery requires it to be strictly after the incident.
        try:
            boot = re.search(r"^btime ([0-9]+)$", read_small(self.proc_root / "stat"), re.M)
            ticks = self.process_identity(pid)
            if not boot or ticks is None:
                raise ValueError()
            return int(boot[1]) + int(ticks) / os.sysconf("SC_CLK_TCK")
        except (OSError, ValueError):
            raise SafeError("service_start_time_unknown") from None

    def memory(self):
        try:
            info = dict(re.findall(r"^([A-Za-z_]+):\s+(\d+) kB$", read_small(self.proc_root / "meminfo"), re.M))
            values = {key: int(info[key]) * 1024 for key in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree")}
            if values["MemTotal"] <= 0 or values["MemAvailable"] > values["MemTotal"] or values["SwapFree"] > values["SwapTotal"]:
                raise ValueError()
            result = {"available": True, "error": None, "total_bytes": values["MemTotal"],
                      "available_bytes": values["MemAvailable"], "swap_total_bytes": values["SwapTotal"],
                      "swap_used_bytes": values["SwapTotal"] - values["SwapFree"],
                      "pressure_some_avg10": None, "pressure_full_avg10": None, "oom_kill_count": None}
            try:
                for kind, value in re.findall(r"^(some|full) avg10=([0-9.]+)", read_small(self.proc_root / "pressure/memory"), re.M):
                    metric = float(value)
                    if math.isfinite(metric) and 0 <= metric <= 100:
                        result[f"pressure_{kind}_avg10"] = metric
            except (OSError, ValueError, SafeError):
                pass
            try:
                counter = re.search(r"^oom_kill (\d+)$", read_small(self.proc_root / "vmstat"), re.M)
                if counter:
                    result["oom_kill_count"] = int(counter[1])
            except (OSError, SafeError):
                pass
            return result
        except (OSError, ValueError, KeyError, SafeError):
            return {"available": False, "error": "host_memory_unavailable"}

    def service(self):
        fields = "ActiveState,SubState,MainPID,InvocationID,ControlGroup,KillMode,LoadState,Result"
        raw = self.runner(["/usr/bin/systemctl", "show", "ollama.service", "--no-pager", "--property=" + fields], timeout=2)
        values = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
        if values.get("Result") == "oom-kill":
            raise SafeError("ollama_host_oom")
        invocation = values.get("InvocationID", "")
        cgroup = values.get("ControlGroup", "")
        if values.get("LoadState") != "loaded" or not re.fullmatch(r"[a-f0-9]{32}", invocation):
            raise SafeError("service_identity_unknown")
        if (not cgroup.startswith("/") or ".." in cgroup.split("/") or
                not cgroup.endswith("/ollama.service")):
            raise SafeError("service_cgroup_unknown")
        try:
            pid = int(values.get("MainPID", ""))
        except ValueError:
            raise SafeError("service_identity_unknown") from None
        return {"active": values.get("ActiveState") == "active" and values.get("SubState") == "running",
                "invocation_id": invocation, "main_pid": pid,
                "kill_mode": values.get("KillMode", ""), "control_group": cgroup}

    def owner(self, pid, cgroup):
        try:
            lines = (self.proc_root / str(pid) / "cgroup").read_text().splitlines()
            paths = [line.split(":", 2)[2] for line in lines if line.count(":") >= 2]
            return any(path == cgroup or path.startswith(cgroup + "/") for path in paths)
        except (OSError, UnicodeError):
            return None

    def comfyui_service(self, unit):
        if unit not in self.comfyui_systemd_units:
            raise SafeError("comfyui_unit_not_allowed")
        fields = "ActiveState,SubState,MainPID,InvocationID,ControlGroup,LoadState"
        # '--' means even an allowlisted unit beginning with '-' is not an option.
        raw = self.runner(["/usr/bin/systemctl", "show", "--no-pager", "--property=" + fields, "--", unit], timeout=2)
        values = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
        invocation, cgroup = values.get("InvocationID", ""), values.get("ControlGroup", "")
        if (values.get("LoadState") != "loaded" or values.get("ActiveState") != "active"
                or values.get("SubState") != "running" or not re.fullmatch(r"[a-f0-9]{32}", invocation)):
            raise SafeError("comfyui_service_identity_unknown")
        if (not cgroup.startswith("/") or ".." in cgroup.split("/")
                or not cgroup.endswith("/" + unit)):
            raise SafeError("comfyui_service_cgroup_unknown")
        try:
            pid = int(values.get("MainPID", ""))
            if pid <= 0:
                raise ValueError()
        except ValueError:
            raise SafeError("comfyui_service_identity_unknown") from None
        return {"invocation_id": invocation, "main_pid": pid, "control_group": cgroup}

    def comfyui_observations(self):
        observations = {}
        for unit in self.comfyui_systemd_units:
            try:
                observations[unit] = self.comfyui_service(unit)
            except SafeError:
                # Inability to verify one service never grants any process trust.
                observations[unit] = None
        return observations

    def comfyui_process(self, pid, services):
        try:
            identity = self.process_identity(pid)
            if identity is None:
                return None
            owned = [unit for unit, service in services.items() if service is not None
                     and self.owner(pid, service["control_group"]) is True]
            return (identity, owned) if owned else None
        except SafeError:
            return None

    def process_identity(self, pid):
        try:
            text = (self.proc_root / str(pid) / "stat").read_text()
            # comm may contain spaces or ')'; field 22 is starttime.
            return text[text.rindex(")") + 2:].split()[19]
        except FileNotFoundError:
            return None
        except (OSError, UnicodeError, IndexError, ValueError):
            raise SafeError("process_identity_unknown") from None

    def workers(self, service):
        root = self.cgroup_root / service["control_group"].lstrip("/")
        result = {}
        try:
            directories = [root]
            for directory in directories:
                if len(directories) > 128:
                    raise SafeError("cgroup_limit")
                directories.extend(child for child in directory.iterdir() if child.is_dir() and not child.is_symlink())
                for raw in (directory / "cgroup.procs").read_text().split():
                    pid = int(raw)
                    identity = self.process_identity(pid)
                    if identity is not None:
                        result[pid] = identity
                    if len(result) > 4096:
                        raise SafeError("cgroup_limit")
        except (OSError, ValueError):
            raise SafeError("cgroup_unavailable") from None
        if service["active"] and service["main_pid"] not in result:
            raise SafeError("service_process_mismatch")
        return result

    def telemetry(self, service):
        comfy_before = self.comfyui_observations()
        metrics = self.runner([self.amd_smi, "metric", "--mem-usage", "--usage", "--temperature", "--power", "--json"])
        # --general omits per-process VRAM; full JSON includes MEMORY_USAGE.
        processes = self.runner([self.amd_smi, "process", "--json"])
        try:
            telemetry = parse_telemetry(json.loads(metrics), json.loads(processes),
                                        lambda pid: self.owner(pid, service["control_group"]))
            candidates = {process["pid"]: self.comfyui_process(process["pid"], comfy_before)
                          for gpu in telemetry["gpus"] for process in gpu["processes"]}
            comfy_after = self.comfyui_observations()
            stable = {unit: before for unit, before in comfy_before.items()
                      if before is not None and before == comfy_after.get(unit)}
            for gpu in telemetry["gpus"]:
                for process in gpu["processes"]:
                    before = candidates.get(process["pid"])
                    after = self.comfyui_process(process["pid"], stable)
                    process["is_comfyui"] = bool(before is not None and after is not None
                                                  and before[0] == after[0]
                                                  and set(before[1]).intersection(after[1])
                                                  and not process["is_ollama"])
            return telemetry
        except (ValueError, TypeError, RecursionError):
            raise SafeError("telemetry_invalid") from None

    def restart(self):
        # This exact argv is the sole privileged host operation, granted by sudoers.
        self.runner(["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "restart", "ollama.service"], timeout=45)

    def old_workers_gone(self, workers):
        return all(self.process_identity(int(pid)) != identity for pid, identity in workers.items())


class Journal:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Hold the lock for the helper lifetime: two listeners must not share state.
        self.lock_file = open(str(path) + ".lock", "a", encoding="utf-8")
        try:
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock_file.close()
            raise
        self.data = {"schema": 1, "last_time": 0, "operations": {}}
        self.error = None
        try:
            if self.path.exists():
                if self.path.stat().st_size > 64 * 1024 * 1024:
                    raise ValueError()
                data = json.loads(self.path.read_text())
                if (data.get("schema") != 1 or not isinstance(data.get("operations"), dict)
                        or len(data["operations"]) > MAX_OPERATIONS
                        or not isinstance(data.get("last_time"), (float, int))):
                    raise ValueError()
                for key, entry in data["operations"].items():
                    if str(uuid.UUID(key)) != key or not isinstance(entry, dict):
                        raise ValueError()
                    if "proof" in entry and not valid_proof(entry["proof"]):
                        raise ValueError()
                    if entry.get("state") not in ("uncertain", "failed", "completed"):
                        raise ValueError()
                    if not isinstance(entry.get("dispatched_at", 0), (float, int)):
                        raise ValueError()
                    if (entry.get("operation_id") != key or not isinstance(entry.get("restarted"), bool)
                            or not re.fullmatch(r"[a-f0-9]{32}", entry.get("before_invocation_id", ""))
                            or not isinstance(entry.get("after_invocation_id"), str)
                            or not math.isfinite(entry.get("dispatched_at", 0))):
                        raise ValueError()
                observations = data.get("observations", [])
                if (not isinstance(observations, list) or len(observations) > 4
                        or any(not valid_proof(item) or not re.fullmatch(r"[a-f0-9]{32}", item.get("invocation_id", ""))
                               for item in observations)):
                    raise ValueError()
                if not math.isfinite(data["last_time"]):
                    raise ValueError()
                self.data = data
            else:
                self.save()
        except (OSError, ValueError, TypeError, AttributeError):
            self.error = "state_invalid"

    def save(self):
        temp = None
        try:
            fd, temp = tempfile.mkstemp(prefix=".host-state-", dir=self.path.parent)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(self.data, stream, separators=(",", ":"), allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self.path)
            directory = os.open(self.path.parent, os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except (OSError, ValueError):
            self.error = "state_unwritable"
            raise SafeError("state_unwritable") from None
        finally:
            if temp and os.path.exists(temp):
                os.unlink(temp)

    def close(self):
        self.lock_file.close()


class Controller:
    def __init__(self, host, journal, origin, now=time.time, sleep=time.sleep):
        parts = urlsplit(origin)
        if (parts.scheme not in ("http", "https") or not parts.hostname or parts.username
                or parts.password or parts.path not in ("", "/") or parts.query or parts.fragment):
            raise SafeError("invalid_managed_origin")
        self.origin = origin.rstrip("/")
        self.host, self.journal, self.now, self.sleep = host, journal, now, sleep
        self.mutex = threading.Lock()

    def policy(self):
        now = self.now()
        entries = list(self.journal.data["operations"].values())
        dispatches = [entry["dispatched_at"] for entry in entries if entry.get("dispatched_at")]
        last = max(dispatches, default=0)
        cooldown = max(0, math.ceil(last + COOLDOWN - now))
        remaining = max(0, MAX_RESTARTS - sum(timestamp > now - WINDOW for timestamp in dispatches))
        error = self.journal.error
        if not error and now + 5 < self.journal.data["last_time"]:
            error = "clock_moved_backwards"
        if not error and len(entries) >= MAX_OPERATIONS:
            error = "state_capacity"
        if not error and cooldown:
            error = "restart_cooldown"
        if not error and remaining == 0:
            error = "restart_limit"
        return {"available": error is None, "error": error,
                "cooldown_remaining_seconds": cooldown, "restarts_remaining": remaining}

    def status(self):
        sampled = utc_now(self.now())
        service = {"active": False, "invocation_id": "", "main_pid": 0, "kill_mode": ""}
        telemetry = {"available": False, "error": None, "gpus": []}
        try:
            service = self.host.service()
            telemetry = self.host.telemetry(service)
            after = self.host.service()
            if any(service[key] != after[key] for key in ("invocation_id", "main_pid", "active", "kill_mode")):
                raise SafeError("service_changed_during_sample")
            self.observe(service)
        except SafeError as error:
            telemetry = {"available": False, "error": str(error), "gpus": []}
            if str(error) == "ollama_host_oom" and not self.journal.error:
                self.journal.data["last_service_failure"] = {"code": "ollama_host_oom", "observed_at": sampled}
                self.journal.save()
        # Sample time marks the beginning, so slow checks cannot masquerade as fresh.
        return {"protocol": PROTOCOL, "sampled_at": sampled,
                "managed_ollama_origin": self.origin,
                "service": {key: value for key, value in service.items() if key != "control_group"},
                "telemetry": telemetry, "memory": self.host.memory(),
                "last_service_failure": self.journal.data.get("last_service_failure"),
                "capabilities": {"restart_reconciliation": True, "external_replacement": True, "system_memory": True,
                                 "comfyui_ownership": True},
                "restart_policy": self.policy()}

    def observe(self, service):
        if not service["active"] or service["kill_mode"] != "control-group" or self.journal.error:
            return
        workers = {str(pid): start for pid, start in self.host.workers(service).items()}
        boot = self.host.boot_id()
        if self.host.service()["invocation_id"] != service["invocation_id"]:
            raise SafeError("service_changed_during_sample")
        observations = self.journal.data.get("observations", [])
        same = next((item for item in observations if item["invocation_id"] == service["invocation_id"] and item["boot_id"] == boot), None)
        combined = {**(same["workers"] if same else {}), **workers}
        if not valid_workers(combined):
            raise SafeError("cgroup_limit")
        if same and combined == same["workers"]:
            return
        item = {"invocation_id": service["invocation_id"], "boot_id": boot, "workers": combined}
        self.journal.data["observations"] = [entry for entry in observations if entry is not same][-3:] + [item]
        self.journal.save()

    def replacement(self, since):
        """Read-only host verification: never invoke systemctl restart here."""
        with self.mutex:
            if self.journal.error:
                raise SafeError(self.journal.error)
            if not math.isfinite(since) or since <= 0 or since > self.now():
                raise SafeError("invalid_incident_time")
            service = self.host.service()
            if self.host.process_started_at(service["main_pid"]) <= since:
                raise SafeError("no_new_service_after_incident")
            boot = self.host.boot_id()
            old = [item for item in self.journal.data.get("observations", [])
                   if item["boot_id"] == boot and item["invocation_id"] != service["invocation_id"]]
            if not old:
                raise SafeError("replacement_proof_unavailable")
            proof = {"workers": {pid: start for item in old for pid, start in item["workers"].items()}, "boot_id": boot}
            self.verify_replacement(old[-1]["invocation_id"], proof)
            if self.host.service()["invocation_id"] != service["invocation_id"]:
                raise SafeError("service_changed_during_sample")
            return {"state": "completed", "service_replaced": True, "before_invocation_id": old[-1]["invocation_id"],
                    "after_invocation_id": service["invocation_id"], "started_after": since}

    def verify_replacement(self, before, proof):
        if not valid_proof(proof):
            raise SafeError("legacy_restart_proof_unavailable")
        if self.host.boot_id() != proof["boot_id"]:
            raise SafeError("host_boot_changed")
        after = self.host.service()
        if not after["active"] or after["invocation_id"] == before or after["kill_mode"] != "control-group":
            raise SafeError("restart_not_verified")
        if not self.host.old_workers_gone(proof["workers"]):
            raise SafeError("old_ollama_workers_present")
        self.host.workers(after)
        self.assert_safe_gpu(self.host.telemetry(after), after=True)
        if self.host.service()["invocation_id"] != after["invocation_id"]:
            raise SafeError("service_changed_during_sample")
        return after["invocation_id"]

    def reconcile(self, result):
        if result["state"] != "uncertain" or not result.get("proof"):
            return self.public_result(result)
        try:
            result["after_invocation_id"] = self.verify_replacement(result["before_invocation_id"], result["proof"])
            result.update(state="completed", restarted=True)
            result.pop("error", None)
        except SafeError as error:
            result["error"] = str(error)
        self.journal.save()
        return self.public_result(result)

    def operation(self, operation_id):
        with self.mutex:
            if self.journal.error:
                raise SafeError(self.journal.error)
            result = self.journal.data["operations"].get(operation_id)
            if result is None:
                raise SafeError("operation_not_found")
            return self.reconcile(result)

    @staticmethod
    def assert_safe_gpu(telemetry, after=False):
        if not telemetry.get("available") or not telemetry.get("gpus"):
            raise SafeError("telemetry_unavailable")
        for gpu in telemetry["gpus"]:
            if (not gpu.get("processes_known") or gpu.get("vram_total_bytes") is None
                    or gpu.get("vram_used_bytes") is None or gpu["vram_total_bytes"] <= 0):
                raise SafeError("telemetry_incomplete")
            if any(not process["is_ollama"] for process in gpu["processes"]):
                raise SafeError("unrelated_gpu_process")
            if after:
                if gpu["processes"]:
                    raise SafeError("gpu_processes_after_restart")
                if gpu.get("utilization_percent") is None:
                    raise SafeError("gpu_utilization_unknown")
                if gpu["utilization_percent"] > 1:
                    raise SafeError("gpu_active_after_restart")
                if gpu["vram_used_bytes"] > 512 * 1024 * 1024:
                    raise SafeError("gpu_vram_after_restart")

    def restart(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"operation_id", "expected_invocation_id"}:
            raise SafeError("invalid_request")
        operation_id, expected = payload["operation_id"], payload["expected_invocation_id"]
        try:
            if not isinstance(operation_id, str) or str(uuid.UUID(operation_id)) != operation_id:
                raise ValueError()
        except (ValueError, AttributeError):
            raise SafeError("invalid_operation_id") from None
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{32}", expected):
            raise SafeError("invalid_invocation_id")
        with self.mutex:
            if self.journal.error:
                raise SafeError(self.journal.error)
            previous = self.journal.data["operations"].get(operation_id)
            if previous:
                if previous["before_invocation_id"] != expected:
                    raise SafeError("operation_identity_mismatch")
                return self.reconcile(previous)
            if len(self.journal.data["operations"]) >= MAX_OPERATIONS:
                raise SafeError("state_capacity")
            result = {"operation_id": operation_id, "state": "failed", "restarted": False,
                      "before_invocation_id": expected, "after_invocation_id": ""}
            try:
                policy = self.policy()
                if not policy["available"]:
                    raise SafeError(policy["error"])
                before = self.host.service()
                if before["invocation_id"] != expected:
                    raise SafeError("service_identity_mismatch")
                if before["kill_mode"] != "control-group":
                    raise SafeError("unsafe_service_kill_mode")
                self.assert_safe_gpu(self.host.telemetry(before))
                workers = self.host.workers(before)
                # Recheck identity after slow telemetry reads, before any mutation.
                rechecked = self.host.service()
                if (rechecked["invocation_id"] != expected
                        or rechecked["main_pid"] != before["main_pid"]
                        or rechecked["control_group"] != before["control_group"]):
                    raise SafeError("service_identity_mismatch")
                if rechecked["kill_mode"] != "control-group":
                    raise SafeError("unsafe_service_kill_mode")
                result.update(state="uncertain", error="restart_outcome_uncertain", dispatched_at=self.now(),
                              proof={"workers": {str(pid): start for pid, start in workers.items()}, "boot_id": self.host.boot_id()})
                self.journal.data["last_time"] = self.now()
                self.journal.data["operations"][operation_id] = result
                self.journal.save()  # Durable intent BEFORE invoking systemctl.
                self.host.restart()
                result["restarted"] = True
                # Polling the read-only operation endpoint supplies the bounded
                # settling window. Transient activity never triggers a second restart.
                return self.reconcile(result)
            except SafeError as error:
                result["error"] = str(error)
            self.journal.data["operations"][operation_id] = result
            self.journal.data["last_time"] = max(self.now(), self.journal.data["last_time"])
            self.journal.save()
            return self.public_result(result)

    @staticmethod
    def public_result(result):
        return {**{key: value for key, value in result.items() if key not in ("dispatched_at", "proof")},
                "recheckable": valid_proof(result.get("proof")) is True}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "IntermediaryHost/1"

    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def log_message(self, *args):
        pass  # Do not log request contents, headers or command output.

    def respond(self, status, data):
        body = json.dumps(data, separators=(",", ":"), allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            url = urlsplit(self.path)
            if self.path == "/v1/status":
                return self.respond(200, self.server.controller.status())
            if re.fullmatch(r"/v1/ollama/operations/[a-f0-9-]{36}", self.path):
                return self.respond(200, self.server.controller.operation(self.path.rsplit("/", 1)[1]))
            if url.path == "/v1/ollama/replacement":
                query = parse_qs(url.query, strict_parsing=True)
                if set(query) != {"since"} or len(query["since"]) != 1:
                    raise ValueError()
                return self.respond(200, self.server.controller.replacement(float(query["since"][0])))
            return self.respond(404, {"error": "not_found"})
        except (ValueError, SafeError) as error:
            self.respond(409, {"error": str(error) if isinstance(error, SafeError) else "invalid_request"})

    def do_POST(self):
        if self.path != "/v1/ollama/restart":
            return self.respond(404, {"error": "not_found"})
        try:
            if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) != 1:
                raise SafeError("invalid_request")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                raise SafeError("request_body_limit")
            if self.headers.get_content_type() != "application/json":
                raise SafeError("invalid_request")
            data = self.rfile.read(length)
            if len(data) != length:
                raise SafeError("invalid_request")
            result = self.server.controller.restart(json.loads(data))
            self.respond(200, result)
        except (ValueError, UnicodeError):
            self.respond(400, {"error": "invalid_json"})
        except SafeError as error:
            self.respond(409, {"error": str(error)})


class UnixServer(socketserver.UnixStreamServer):
    # Single-threaded by design: status cannot race a restart or duplicate it.
    allow_reuse_address = False
    request_queue_size = 8

    def __init__(self, path, controller):
        self.controller = controller
        socket_path = Path(path)
        parent = socket_path.parent.stat()
        if parent.st_uid not in (0, os.getuid()) or stat.S_IMODE(parent.st_mode) & 0o022:
            raise SafeError("unsafe_socket_directory")
        if socket_path.exists():
            existing = socket_path.lstat()
            if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != os.getuid():
                raise SafeError("unsafe_socket_path")
            socket_path.unlink()
        previous = os.umask(0o117)
        try:
            super().__init__(path, Handler)
            os.chmod(path, 0o660)
        finally:
            os.umask(previous)


def main():
    origin = os.environ.get("MANAGED_OLLAMA_ORIGIN", "")
    journal = Journal(os.environ.get("HOST_HELPER_STATE", "/var/lib/ai-intermediary-host/state.json"))
    controller = Controller(SystemHost(os.environ.get("AMD_SMI_PATH", "/opt/rocm/bin/amd-smi"),
                                      comfyui_systemd_units=os.environ.get("COMFYUI_SYSTEMD_UNITS", "")), journal, origin)
    path = os.environ.get("HOST_HELPER_SOCKET", "/run/ai-intermediary-host/control.sock")
    if not os.path.isabs(path):
        raise SafeError("invalid_socket_path")
    with UnixServer(path, controller) as server:
        server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    try:
        main()
    except (SafeError, OSError):
        raise SystemExit("Host helper refused startup; check private service configuration and journal permissions.")

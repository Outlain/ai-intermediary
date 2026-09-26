"""No real AMD device, service restart, sudo or root access is used by these tests."""
import copy
import http.client
import json
import os
from pathlib import Path
import socket
import stat
import sys
import tempfile
import threading
import unittest
from unittest import mock
import uuid

import host_helper as helper

OLD = "a" * 32
NEW = "b" * 32


def telemetry():
    return {"available": True, "error": None, "gpus": [{
        "id": "0", "name": None, "vram_total_bytes": 32624 * 1024 ** 2,
        "vram_used_bytes": 57 * 1024 ** 2, "vram_free_bytes": 32567 * 1024 ** 2,
        "utilization_percent": 0, "temperature_c": 29, "power_w": 1,
        "processes": [], "processes_known": True}]}


class FakeHost:
    def __init__(self):
        self.invocation = OLD
        self.kill_mode = "control-group"
        self.calls = 0
        self.reads = 0
        self.sample = telemetry()
        self.failure = None
        self.gone = True
        self.change_during_sample = False
        self.started_at = 9999.0

    def boot_id(self):
        return "11111111-1111-4111-8111-111111111111"

    def process_started_at(self, pid):
        return self.started_at

    def memory(self):
        return {"available": True, "total_bytes": 30 * 1024 ** 3, "available_bytes": 10 * 1024 ** 3,
                "swap_total_bytes": 4 * 1024 ** 3, "swap_used_bytes": 0}

    def service(self):
        self.reads += 1
        if self.change_during_sample and self.reads > 1:
            self.invocation = NEW
        return {"active": True, "invocation_id": self.invocation,
                "main_pid": 12 if self.invocation == OLD else 34,
                "kill_mode": self.kill_mode, "control_group": "/system.slice/ollama.service"}

    def telemetry(self, service):
        return copy.deepcopy(self.sample)

    def workers(self, service):
        return {service["main_pid"]: "123456"}

    def restart(self):
        self.calls += 1
        if self.failure:
            raise helper.SafeError(self.failure)
        self.invocation = NEW

    def old_workers_gone(self, workers):
        return self.gone


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "state.json"
        self.journal = helper.Journal(self.path)
        self.host = FakeHost()
        self.clock = 10000.0
        self.controller = helper.Controller(self.host, self.journal, "http://192.0.2.10:11434",
                                            now=lambda: self.clock, sleep=lambda _: None)

    def tearDown(self):
        self.journal.close()
        self.temp.cleanup()

    def payload(self, expected=OLD):
        return {"operation_id": str(uuid.uuid4()), "expected_invocation_id": expected}

    def test_complete_restart_and_replay(self):
        payload = self.payload()
        result = self.controller.restart(payload)
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["after_invocation_id"], NEW)
        self.assertTrue(result["restarted"])
        replay = self.controller.restart(payload)
        self.assertEqual(replay, result)
        self.assertEqual(self.host.calls, 1)
        self.assertNotIn("dispatched_at", result)

    def test_uncertain_restart_replay_after_helper_restart_never_restarts(self):
        payload = self.payload()
        self.host.failure = "command_timeout"
        result = self.controller.restart(payload)
        self.assertEqual(result["state"], "uncertain")
        self.journal.close()
        self.journal = helper.Journal(self.path)
        self.controller.journal = self.journal
        self.clock += 4000
        self.host.failure = None
        replay = self.controller.restart(payload)
        self.assertEqual(replay["state"], "uncertain")
        self.assertEqual(replay["error"], "restart_not_verified")
        self.assertEqual(self.host.calls, 1)

    def test_crash_after_durable_intent_is_uncertain_on_replay(self):
        payload = self.payload()
        def crash():
            self.host.calls += 1
            raise RuntimeError("simulated process death")
        self.host.restart = crash
        with self.assertRaises(RuntimeError):
            self.controller.restart(payload)
        self.journal.close()
        self.journal = helper.Journal(self.path)
        self.controller.journal = self.journal
        self.assertEqual(self.controller.restart(payload)["state"], "uncertain")
        self.assertEqual(self.host.calls, 1)

    def test_cooldown_and_hourly_limit_persist(self):
        self.controller.restart(self.payload())
        self.assertEqual(self.controller.restart(self.payload(NEW))["error"], "restart_cooldown")
        self.clock += 301
        # A second success needs another unique native service invocation.
        self.host.invocation = OLD
        self.assertEqual(self.controller.restart(self.payload())["state"], "completed")
        self.clock += 301
        self.assertEqual(self.controller.restart(self.payload(NEW))["error"], "restart_limit")
        self.assertEqual(self.host.calls, 2)
        self.journal.close()
        self.journal = helper.Journal(self.path)
        self.controller.journal = self.journal
        self.assertEqual(self.controller.policy()["restarts_remaining"], 0)

    def test_policy_clock_backwards_fails_closed(self):
        self.controller.restart(self.payload())
        self.clock -= 100
        self.assertEqual(self.controller.policy()["error"], "clock_moved_backwards")

    def test_unrelated_gpu_process_blocks_restart(self):
        self.host.sample["gpus"][0]["processes"] = [{"pid": 9, "is_ollama": False}]
        self.assertEqual(self.controller.restart(self.payload())["error"], "unrelated_gpu_process")
        self.assertEqual(self.host.calls, 0)

    def test_unknown_process_list_blocks_restart(self):
        self.host.sample["gpus"][0]["processes_known"] = False
        self.assertEqual(self.controller.restart(self.payload())["error"], "telemetry_incomplete")
        self.assertEqual(self.host.calls, 0)

    def test_unknown_vram_blocks_restart(self):
        self.host.sample["gpus"][0]["vram_used_bytes"] = None
        self.assertEqual(self.controller.restart(self.payload())["error"], "telemetry_incomplete")
        self.assertEqual(self.host.calls, 0)

    def test_no_device_blocks_restart(self):
        self.host.sample["gpus"] = []
        self.assertEqual(self.controller.restart(self.payload())["error"], "telemetry_unavailable")
        self.assertEqual(self.host.calls, 0)

    def test_unsafe_kill_mode_blocks_restart(self):
        self.host.kill_mode = "process"
        self.assertEqual(self.controller.restart(self.payload())["error"], "unsafe_service_kill_mode")
        self.assertEqual(self.host.calls, 0)

    def test_wrong_service_epoch_blocks_restart(self):
        self.assertEqual(self.controller.restart(self.payload(NEW))["error"], "service_identity_mismatch")
        self.assertEqual(self.host.calls, 0)

    def test_service_change_during_read_blocks_restart(self):
        self.host.change_during_sample = True
        self.assertEqual(self.controller.restart(self.payload())["error"], "service_identity_mismatch")
        self.assertEqual(self.host.calls, 0)

    def test_service_change_during_status_marks_telemetry_unavailable(self):
        self.host.change_during_sample = True
        result = self.controller.status()
        self.assertFalse(result["telemetry"]["available"])
        self.assertEqual(result["telemetry"]["error"], "service_changed_during_sample")

    def test_old_worker_survives_no_completion_claim(self):
        self.host.gone = False
        result = self.controller.restart(self.payload())
        self.assertEqual(result["state"], "uncertain")
        self.assertEqual(result["error"], "old_ollama_workers_present")

    def test_vram_remains_high_no_completion_claim(self):
        self.host.sample["gpus"][0]["vram_used_bytes"] = 2 * 1024 ** 3
        result = self.controller.restart(self.payload())
        self.assertEqual(result["state"], "uncertain")
        self.assertEqual(result["error"], "gpu_vram_after_restart")

    def test_gpu_process_remains_no_completion_claim(self):
        self.host.sample["gpus"][0]["processes"] = [{"pid": 12, "is_ollama": True}]
        result = self.controller.restart(self.payload())
        self.assertEqual(result["state"], "uncertain")
        self.assertEqual(result["error"], "gpu_processes_after_restart")

    def test_journal_invalid_refuses_mutation(self):
        self.journal.close()
        self.path.write_text('{"schema":1,"last_time":0,"operations":{"bad":{}}}')
        self.journal = helper.Journal(self.path)
        self.controller.journal = self.journal
        with self.assertRaisesRegex(helper.SafeError, "state_invalid"):
            self.controller.restart(self.payload())
        self.assertEqual(self.host.calls, 0)

    def test_journal_write_failure_never_dispatches_restart(self):
        with mock.patch.object(self.journal, "save", side_effect=helper.SafeError("state_unwritable")):
            with self.assertRaisesRegex(helper.SafeError, "state_unwritable"):
                self.controller.restart(self.payload())
        self.assertEqual(self.host.calls, 0)

    def test_replay_same_uuid_wrong_epoch_rejected(self):
        payload = self.payload()
        self.controller.restart(payload)
        payload["expected_invocation_id"] = NEW
        with self.assertRaisesRegex(helper.SafeError, "operation_identity_mismatch"):
            self.controller.restart(payload)
        self.assertEqual(self.host.calls, 1)

    def test_journal_two_instances_refused(self):
        with self.assertRaises(BlockingIOError):
            helper.Journal(self.path)

    def test_arbitrary_command_or_service_is_not_an_api_option(self):
        request = self.payload()
        request["command"] = "reboot"
        with self.assertRaisesRegex(helper.SafeError, "invalid_request"):
            self.controller.restart(request)
        self.assertEqual(self.host.calls, 0)

    def test_status_omits_private_cgroup_and_has_origin(self):
        result = self.controller.status()
        self.assertNotIn("control_group", result["service"])
        self.assertEqual(result["managed_ollama_origin"], "http://192.0.2.10:11434")
        self.assertEqual(result["protocol"], helper.PROTOCOL)
        self.assertTrue(result["telemetry"]["available"])

    def test_transient_restart_activity_settles_after_helper_restart_without_second_restart(self):
        payload = self.payload()
        self.host.sample["gpus"][0]["utilization_percent"] = 2
        result = self.controller.restart(payload)
        self.assertEqual(result["state"], "uncertain")
        self.assertTrue(result["recheckable"])
        self.assertNotIn("proof", result)
        self.journal.close()
        self.journal = helper.Journal(self.path)
        self.controller.journal = self.journal
        self.host.sample["gpus"][0]["utilization_percent"] = 0
        result = self.controller.operation(payload["operation_id"])
        self.assertEqual(result["state"], "completed")
        self.assertEqual(self.host.calls, 1)

    def test_timeout_can_be_verified_later_but_boot_change_cannot(self):
        payload = self.payload()
        self.host.failure = "command_timeout"
        self.controller.restart(payload)
        self.host.invocation = NEW
        with mock.patch.object(self.host, "boot_id", return_value="2" * 36):
            self.assertEqual(self.controller.operation(payload["operation_id"])["error"], "host_boot_changed")
        self.assertEqual(self.controller.operation(payload["operation_id"])["state"], "completed")
        self.assertEqual(self.host.calls, 1)

    def test_legacy_uncertain_record_has_no_automatic_proof(self):
        payload = self.payload()
        self.host.failure = "command_timeout"
        self.controller.restart(payload)
        del self.journal.data["operations"][payload["operation_id"]]["proof"]
        self.journal.save()
        self.host.invocation = NEW
        result = self.controller.operation(payload["operation_id"])
        self.assertEqual(result["state"], "uncertain")
        self.assertFalse(result["recheckable"])

    def test_adopt_external_restart_only_after_incident_with_durable_worker_proof(self):
        self.controller.status()
        self.journal.close()
        self.journal = helper.Journal(self.path)
        self.controller.journal = self.journal
        self.clock += 10
        self.host.invocation = NEW
        self.host.started_at = self.clock - 1
        result = self.controller.replacement(self.clock - 5)
        self.assertTrue(result["service_replaced"])
        self.assertEqual(result["before_invocation_id"], OLD)
        self.assertEqual(self.host.calls, 0)
        with self.assertRaisesRegex(helper.SafeError, "no_new_service_after_incident"):
            self.controller.replacement(self.clock)
        self.host.gone = False
        with self.assertRaisesRegex(helper.SafeError, "old_ollama_workers_present"):
            self.controller.replacement(self.clock - 5)

    def test_empty_gpu_without_old_worker_observation_is_not_replacement_proof(self):
        with self.assertRaisesRegex(helper.SafeError, "replacement_proof_unavailable"):
            self.controller.replacement(self.clock - 10)
        self.assertEqual(self.host.calls, 0)

    def test_invalid_persisted_worker_proof_fails_closed(self):
        payload = self.payload()
        self.controller.restart(payload)
        self.journal.data["operations"][payload["operation_id"]]["proof"]["workers"] = {}
        self.journal.save()
        self.journal.close()
        self.journal = helper.Journal(self.path)
        self.assertEqual(self.journal.error, "state_invalid")


class ParserTests(unittest.TestCase):
    def metric(self):
        # Recorded user's AMD SMI 26.2.2 readings, represented as native JSON.
        return [{"gpu": 0, "mem_usage": {
            "total_vram": {"value": 32624, "unit": "MB"},
            "used_vram": {"value": 57, "unit": "MB"},
            "free_vram": {"value": 32567, "unit": "MB"}},
            "usage": {"gfx_activity": {"value": 0, "unit": "%"}},
            "temperature": {"edge": {"value": 29, "unit": "°C"}},
            "power": {"socket_power": {"value": 1, "unit": "W"}}}]

    def test_recorded_amd_26_2_2_idle(self):
        result = helper.parse_telemetry(self.metric(), [{"gpu": 0, "process_info": "No running processes detected"}], lambda _: False)
        gpu = result["gpus"][0]
        self.assertEqual(gpu["vram_used_bytes"], 57 * 1024 ** 2)
        self.assertEqual(gpu["vram_total_bytes"], 32624 * 1024 ** 2)
        self.assertEqual(gpu["temperature_c"], 29)
        self.assertEqual(gpu["utilization_percent"], 0)
        self.assertTrue(gpu["processes_known"])

    def test_current_process_list_nested_entries(self):
        data = [{"gpu": 0, "process_list": [
            {"process_info": {"pid": 12, "name": "ollama", "memory_usage": {"vram_mem": {"value": 2, "unit": "GB"}}}},
            {"process_info": {"pid": 99, "name": "python3"}}]}]
        gpu = helper.parse_telemetry(self.metric(), data, lambda pid: pid == 12)["gpus"][0]
        self.assertEqual(gpu["processes"][0]["vram_bytes"], 2 * 1024 ** 3)
        self.assertTrue(gpu["processes"][0]["is_ollama"])
        self.assertFalse(gpu["processes"][1]["is_ollama"])

    def test_native_json_empty_process_list_sentinel(self):
        result = helper.parse_telemetry(self.metric(), [{"gpu": 0, "process_list": [
            {"process_info": "No running processes detected"}]}], lambda _: None)
        self.assertTrue(result["gpus"][0]["processes_known"])
        self.assertEqual(result["gpus"][0]["processes"], [])

    def test_mixed_sentinel_and_process_is_not_empty(self):
        result = helper.parse_telemetry(self.metric(), [{"gpu": 0, "process_list": [
            {"process_info": "No running processes detected"}, {"process_info": {"pid": 123}}]}], lambda _: True)
        self.assertFalse(result["gpus"][0]["processes_known"])

    def test_unavailable_not_reported_as_zero(self):
        metric = self.metric()
        metric[0]["mem_usage"]["used_vram"] = "N/A"
        metric[0]["usage"]["gfx_activity"] = "N/A"
        gpu = helper.parse_telemetry(metric, [{"gpu": 0, "process_info": "N/A"}], lambda _: None)["gpus"][0]
        self.assertIsNone(gpu["vram_used_bytes"])
        self.assertIsNone(gpu["utilization_percent"])
        self.assertFalse(gpu["processes_known"])

    def test_unknown_owner_does_not_look_safe(self):
        gpu = helper.parse_telemetry(self.metric(), [{"gpu": 0, "process_info": {"pid": 2}}], lambda _: None)["gpus"][0]
        self.assertFalse(gpu["processes_known"])
        self.assertFalse(gpu["processes"][0]["is_ollama"])

    def test_different_gpu_sets_refused(self):
        with self.assertRaisesRegex(helper.SafeError, "telemetry_gpu_mismatch"):
            helper.parse_telemetry(self.metric(), [{"gpu": 1, "process_list": []}], lambda _: None)

    def test_uppercase_string_unit_fields(self):
        metric = [{"GPU": 0, "MEM_USAGE": {"TOTAL_VRAM": "32624 MB", "USED_VRAM": "57 MB", "FREE_VRAM": "32567 MB"},
                   "USAGE": {"GFX_ACTIVITY": "0 %"}, "TEMPERATURE": {"EDGE": "29 °C"}, "POWER": {"SOCKET_POWER": "1 W"}}]
        result = helper.parse_telemetry(metric, [{"GPU": 0, "PROCESS_INFO": "No running processes detected"}], lambda _: None)
        self.assertEqual(result["gpus"][0]["vram_used_bytes"], 57 * 1024 ** 2)

    def test_invalid_quantities_null(self):
        for item in [None, "N/A", True, float("nan"), float("inf"), -1]:
            self.assertIsNone(helper.quantity(item))
        self.assertIsNone(helper.quantity(57, memory=True))

    def test_unsupported_temperature_preserves_memory_but_not_fake_zero(self):
        metric = self.metric()
        metric[0]["temperature"] = "N/A"
        gpu = helper.parse_telemetry(metric, [{"gpu": 0, "process_list": []}], lambda _: None)["gpus"][0]
        self.assertEqual(gpu["vram_used_bytes"], 57 * 1024 ** 2)
        self.assertIsNone(gpu["temperature_c"])

    def test_malformed_metric_rejected(self):
        metric = self.metric()
        metric[0]["mem_usage"] = ["malformed"]
        with self.assertRaisesRegex(helper.SafeError, "telemetry_invalid"):
            helper.parse_telemetry(metric, [{"gpu": 0, "process_list": []}], lambda _: None)

    def test_malformed_process_row_not_interpreted_as_idle(self):
        for process_info in (None, "N/A", {"name": "unknown"}, [{"process_info": {"pid": "N/A"}}]):
            result = helper.parse_telemetry(self.metric(), [{"gpu": 0, "process_info": process_info}], lambda _: None)
            self.assertFalse(result["gpus"][0]["processes_known"])


class SystemTests(unittest.TestCase):
    def test_fixed_restart_command_only(self):
        commands = []
        host = helper.SystemHost(runner=lambda argv, **options: commands.append((argv, options)) or "")
        host.restart()
        self.assertEqual(commands, [(["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "restart", "ollama.service"], {"timeout": 45})])

    def test_subprocess_output_bound(self):
        with self.assertRaisesRegex(helper.SafeError, "command_output_limit"):
            helper.run_command([sys.executable, "-c", "print('x'*10000)"], max_output=100)

    def test_subprocess_timeout(self):
        with self.assertRaisesRegex(helper.SafeError, "command_timeout"):
            helper.run_command([sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.05)

    def test_subprocess_stderr_not_exposed(self):
        with self.assertRaisesRegex(helper.SafeError, "^command_failed$"):
            helper.run_command([sys.executable, "-c", "import sys; print('secret',file=sys.stderr); sys.exit(1)"])

    def test_cgroup_ownership_not_process_name(self):
        with tempfile.TemporaryDirectory() as root:
            proc = Path(root) / "proc"
            for pid, cgroup in ((12, "/system.slice/ollama.service"), (13, "/other.service")):
                path = proc / str(pid)
                path.mkdir(parents=True)
                (path / "cgroup").write_text("0::" + cgroup)
            host = helper.SystemHost(proc_root=proc)
            self.assertTrue(host.owner(12, "/system.slice/ollama.service"))
            self.assertFalse(host.owner(13, "/system.slice/ollama.service"))
            self.assertIsNone(host.owner(14, "/system.slice/ollama.service"))

    def test_pid_reuse_is_not_old_worker(self):
        host = helper.SystemHost()
        host.process_identity = lambda pid: "new-start-time"
        self.assertTrue(host.old_workers_gone({123: "old-start-time"}))
        self.assertFalse(host.old_workers_gone({123: "new-start-time"}))

    def test_recursive_cgroup_snapshot_and_start_time_identity(self):
        with tempfile.TemporaryDirectory() as root:
            proc = Path(root) / "proc"
            cgroups = Path(root) / "cgroups"
            cgroup = cgroups / "system.slice" / "ollama.service"
            child = cgroup / "workers"
            child.mkdir(parents=True)
            (cgroup / "cgroup.procs").write_text("12\n")
            (child / "cgroup.procs").write_text("13\n")
            for pid, start in ((12, "12345"), (13, "67890")):
                path = proc / str(pid)
                path.mkdir(parents=True)
                fields = ["S"] + ["0"] * 18 + [start] + ["0"] * 10
                (path / "stat").write_text(str(pid) + " (worker ) tricky name) " + " ".join(fields))
            host = helper.SystemHost(proc_root=proc, cgroup_root=cgroups)
            service = {"control_group": "/system.slice/ollama.service", "active": True, "main_pid": 12}
            self.assertEqual(host.workers(service), {12: "12345", 13: "67890"})
            self.assertFalse(host.old_workers_gone({12: "12345", 13: "67890"}))
            service["main_pid"] = 99
            with self.assertRaisesRegex(helper.SafeError, "service_process_mismatch"):
                host.workers(service)

    def test_sudoers_grant_is_single_exact_fixed_command(self):
        text = (Path(__file__).parent / "ai-intermediary-host.sudoers").read_text()
        rules = [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]
        self.assertEqual(rules, ["ai-intermediary-host ALL=(root) NOPASSWD: /usr/bin/systemctl restart ollama.service"])


class ComfyOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.proc = Path(self.temp.name)
        self.commands = []
        self.service_reads = 0
        self.replace_during_sample = False
        self.fail_service = False
        self.cgroup = "/system.slice/comfyui.service"
        self.unit = "comfyui.service"
        self.processes = [{"pid": 20, "name": "python3"}, {"pid": 99, "name": "comfyui"}]
        self.write_process(20, "/system.slice/comfyui.service/worker", "1234")
        self.write_process(99, "/system.slice/unrelated.service", "5678")
        self.host = helper.SystemHost(proc_root=self.proc, runner=self.runner,
                                      comfyui_systemd_units=self.unit)

    def write_process(self, pid, cgroup, start):
        directory = self.proc / str(pid)
        directory.mkdir(exist_ok=True)
        (directory / "cgroup").write_text("0::" + cgroup)
        (directory / "stat").write_text(str(pid) + " (python3) " + " ".join(["S"] + ["0"] * 18 + [start]))

    def runner(self, argv, **options):
        self.commands.append(argv)
        if argv[0] == "/usr/bin/systemctl":
            self.service_reads += 1
            if self.fail_service:
                raise helper.SafeError("command_failed")
            invocation = NEW if self.replace_during_sample and self.service_reads > 1 else OLD
            return ("ActiveState=active\nSubState=running\nMainPID=20\nLoadState=loaded\n"
                    + "InvocationID=" + invocation + "\nControlGroup=" + self.cgroup + "\n")
        if argv[1] == "metric":
            return json.dumps([{"gpu": 0, "mem_usage": {"total_vram": "32624 MB", "used_vram": "100 MB"},
                                "usage": {"gfx_activity": "2 %"}}])
        if argv[1] == "process":
            return json.dumps([{"gpu": 0, "process_info": self.processes}])
        raise AssertionError("Unexpected command")

    def sample(self):
        return self.host.telemetry({"control_group": "/system.slice/ollama.service"})["gpus"][0]

    def test_verified_cgroup_not_spoofed_name_grants_read_only_comfy_identity(self):
        gpu = self.sample()
        self.assertTrue(gpu["processes"][0]["is_comfyui"])
        self.assertFalse(gpu["processes"][0]["is_ollama"])
        self.assertFalse(gpu["processes"][1]["is_comfyui"])
        self.assertEqual(self.service_reads, 2)
        self.assertTrue(all("restart" not in command and "/usr/bin/sudo" not in command for command in self.commands))
        for command in self.commands:
            if command[0] == "/usr/bin/systemctl":
                self.assertEqual(command[-2:], ["--", "comfyui.service"])

    def test_unconfigured_unit_and_cgroup_prefix_are_never_trusted(self):
        self.host.comfyui_systemd_units = ()
        self.assertFalse(self.sample()["processes"][0]["is_comfyui"])
        self.host.comfyui_systemd_units = (self.unit,)
        self.write_process(20, "/system.slice/comfyui.service-evil/worker", "1234")
        self.assertFalse(self.sample()["processes"][0]["is_comfyui"])

    def test_cgroup_read_failure_and_systemctl_failure_never_grant_ownership(self):
        (self.proc / "20/cgroup").unlink()
        self.assertFalse(self.sample()["processes"][0]["is_comfyui"])
        self.write_process(20, self.cgroup, "1234")
        self.fail_service = True
        self.assertFalse(self.sample()["processes"][0]["is_comfyui"])

    def test_service_replacement_or_wrong_cgroup_invalidates_the_sample_identity(self):
        self.replace_during_sample = True
        self.assertFalse(self.sample()["processes"][0]["is_comfyui"])
        self.replace_during_sample = False
        self.cgroup = "/system.slice/evil-comfyui.service"
        self.assertFalse(self.sample()["processes"][0]["is_comfyui"])

    def test_pid_reuse_between_observations_is_not_verified_comfy(self):
        identities = iter(["1234", "5678", "9999", "5678"])
        self.host.process_identity = lambda _pid: next(identities)
        self.assertFalse(self.sample()["processes"][0]["is_comfyui"])

    def test_known_comfy_process_still_blocks_ollama_restart(self):
        with self.assertRaisesRegex(helper.SafeError, "unrelated_gpu_process"):
            helper.Controller.assert_safe_gpu({"available": True, "gpus": [self.sample()]})

    def test_unit_allowlist_rejects_paths_duplicates_excess_and_ollama_alias(self):
        for value in ["../comfy.service", "comfy.service;reboot", "comfyui", "ollama.service",
                      "comfy.service,comfy.service", ",".join(f"comfy{i}.service" for i in range(9))]:
            with self.assertRaisesRegex(helper.SafeError, "invalid_comfyui_units"):
                helper.SystemHost(comfyui_systemd_units=value)
        self.assertEqual(helper.comfyui_units("comfyui.service, comfyui@second.service"),
                         ("comfyui.service", "comfyui@second.service"))


class MemoryTests(unittest.TestCase):
    def test_process_start_bound_uses_kernel_identity_not_service_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "stat").write_text("cpu 1 2 3\nbtime 1000\n")
            host = helper.SystemHost(proc_root=root)
            with mock.patch.object(host, "process_identity", return_value="500"), mock.patch.object(os, "sysconf", return_value=100):
                self.assertEqual(host.process_started_at(12), 1005)
            with mock.patch.object(host, "process_identity", return_value=None):
                with self.assertRaisesRegex(helper.SafeError, "service_start_time_unknown"):
                    host.process_started_at(12)

    def test_memavailable_swap_pressure_and_oom_counter_are_host_not_gpu_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "meminfo").write_text("MemTotal: 31457280 kB\nMemAvailable: 8388608 kB\nSwapTotal: 4194304 kB\nSwapFree: 0 kB\n")
            (root / "pressure").mkdir()
            (root / "pressure/memory").write_text("some avg10=2.50 avg60=0 total=20\nfull avg10=1.25 avg60=0 total=10\n")
            (root / "vmstat").write_text("oom_kill 2\n")
            host = helper.SystemHost(proc_root=root)
            result = host.memory()
            self.assertEqual(result["total_bytes"], 30 * 1024 ** 3)
            self.assertEqual(result["available_bytes"], 8 * 1024 ** 3)
            self.assertEqual(result["swap_used_bytes"], 4 * 1024 ** 3)
            self.assertEqual(result["pressure_full_avg10"], 1.25)
            self.assertEqual(result["oom_kill_count"], 2)
            (root / "pressure/memory").unlink()
            self.assertTrue(host.memory()["available"])
            self.assertIsNone(host.memory()["pressure_full_avg10"])
            (root / "meminfo").write_text("MemTotal: 100 kB\n")
            self.assertFalse(host.memory()["available"])

    def test_oom_result_is_distinct_from_gpu_failure(self):
        host = helper.SystemHost(runner=lambda *args, **kwargs: "Result=oom-kill\n")
        with self.assertRaisesRegex(helper.SafeError, "ollama_host_oom"):
            host.service()


class UnixHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.temp.name) / "control.sock")
        self.journal = helper.Journal(Path(self.temp.name) / "state.json")
        self.controller = helper.Controller(FakeHost(), self.journal, "http://localhost:11434")
        self.server = helper.UnixServer(self.path, self.controller)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.journal.close()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("localhost")
        conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.sock.connect(self.path)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_socket_permissions_are_auth_boundary_no_tcp(self):
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o660)
        self.assertEqual(self.server.socket.family, socket.AF_UNIX)
        self.assertEqual(self.request("GET", "/v1/status")[0], 200)

    def test_group_writable_socket_directory_refused(self):
        unsafe = Path(self.temp.name) / "unsafe"
        unsafe.mkdir(mode=0o770)
        unsafe.chmod(0o770)
        with self.assertRaisesRegex(helper.SafeError, "unsafe_socket_directory"):
            helper.UnixServer(str(unsafe / "control.sock"), self.controller)

    def test_request_body_bound(self):
        status, body = self.request("POST", "/v1/ollama/restart", "x" * (helper.MAX_BODY + 1), {"Content-Type": "application/json"})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"], "request_body_limit")

    def test_unknown_routes_never_execute(self):
        self.assertEqual(self.request("POST", "/v1/reboot")[0], 404)
        self.assertEqual(self.controller.host.calls, 0)

    def test_read_only_operation_endpoints_never_restart(self):
        status, body = self.request("GET", "/v1/ollama/operations/" + str(uuid.uuid4()))
        self.assertEqual(status, 409)
        self.assertEqual(body["error"], "operation_not_found")
        self.assertEqual(self.request("GET", "/v1/ollama/replacement?since=not-a-time")[0], 409)
        self.assertEqual(self.controller.host.calls, 0)


if __name__ == "__main__":
    unittest.main()

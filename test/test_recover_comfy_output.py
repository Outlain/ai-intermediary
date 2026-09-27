import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("recover", Path(__file__).resolve().parents[1] / "scripts/recover-comfy-output.py")
recover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recover)
JOB = "12345678-1234-1234-1234-123456789abc"
NAME = "node-108_00001_.mp4"


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.namespace = self.root / "ai-intermediary"
        (self.namespace / JOB).mkdir(parents=True)
        self.ledger = self.namespace / ".broker-owned-jobs.json"
        self.ledger.write_text(json.dumps({"schema_version": 1, "prompt_ids": [JOB]}))
        self.video = self.namespace / JOB / NAME
        self.video.write_bytes(b"test movie bytes")

    def test_names_reject_traversal_option_and_shell_injection(self):
        recover.validate_names(JOB, NAME, "108", "ai-intermediary")
        for args in [("../escape", NAME, "108", "ok"), (JOB, "../movie.mp4", "108", "ok"),
                     (JOB, NAME, "109", "ok"), (JOB, NAME, "108", "-it"),
                     (JOB, NAME, "108", "name;echo something"), (JOB, NAME, "__proto__", "ok")]:
            with self.assertRaises(recover.RecoveryError):
                recover.validate_names(*args)

    def test_owned_file_read_only_preserves_bytes_and_ledger(self):
        before = self.video.read_bytes(), self.ledger.read_bytes()
        with recover.owned_file(str(self.root), JOB, NAME) as file:
            self.assertEqual(file.read(), before[0])
            self.assertFalse(file.writable())
        self.assertEqual((self.video.read_bytes(), self.ledger.read_bytes()), before)

    def test_ownership_required(self):
        self.ledger.write_text('{"schema_version":1,"prompt_ids":[]}')
        with self.assertRaises(recover.RecoveryError):
            with recover.owned_file(str(self.root), JOB, NAME):
                self.fail("Must not open an unowned file")

    def test_symlink_file_and_parent_are_rejected(self):
        self.video.unlink()
        self.video.symlink_to(self.ledger)
        with self.assertRaises(OSError):
            with recover.owned_file(str(self.root), JOB, NAME):
                self.fail("Followed link")
        alias = self.root / "alias"
        alias.symlink_to(self.namespace / JOB, target_is_directory=True)
        with self.assertRaises(OSError):
            recover.directory_fd(str(alias))

    def test_empty_file_rejected(self):
        self.video.write_bytes(b"")
        with self.assertRaises(recover.RecoveryError):
            with recover.owned_file(str(self.root), JOB, NAME):
                self.fail("Accepted empty file")

    def test_probe_and_full_software_decode_required(self):
        probe = mock.Mock(returncode=0, stdout=json.dumps({"streams": [{"width": 640, "height": 640}],
                                                         "format": {"duration": "5.0"}}).encode())
        runner = mock.Mock(side_effect=[probe, mock.Mock(returncode=0)])
        with self.video.open("rb") as file:
            info = recover.validate_video(file, runner)
        self.assertEqual(info["duration_seconds"], 5)
        args = runner.call_args_list[1].args[0]
        self.assertEqual(args[args.index("-hwaccel") + 1], "none")
        self.assertIn("-xerror", args)
        self.assertEqual(runner.call_args_list[1].kwargs["timeout"], 300)
        with self.video.open("rb") as file:
            with self.assertRaises(recover.RecoveryError):
                recover.validate_video(file, mock.Mock(side_effect=[probe, mock.Mock(returncode=1)]))

    def test_invalid_video_duration_rejected_before_decode(self):
        for duration in ["0", "nan", "inf", "3601"]:
            runner = mock.Mock(return_value=mock.Mock(returncode=0, stdout=json.dumps({"streams": [{"width": 640, "height": 640}],
                                                                                     "format": {"duration": duration}}).encode()))
            with self.video.open("rb") as file:
                with self.assertRaises(recover.RecoveryError):
                    recover.validate_video(file, runner)
            self.assertEqual(runner.call_count, 1)

    def test_client_streams_fd_without_reading_password_on_host(self):
        runner = mock.Mock(return_value=mock.Mock(returncode=0))
        with self.video.open("rb") as file:
            recover.client("ai-intermediary", "import", JOB, NAME, "108", file, "a" * 64, runner)
            self.assertIs(runner.call_args.kwargs["stdin"], file)
        args = runner.call_args.args[0]
        self.assertEqual(args[:4], ["docker", "exec", "-i", "ai-intermediary"])
        self.assertNotIn("shell", runner.call_args.kwargs)
        self.assertEqual(args[-1], "a" * 64)
        self.assertIn("process.env.ADMIN_TOKEN", recover.NODE_CLIENT)


if __name__ == "__main__":
    unittest.main()

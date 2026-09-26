"""No Docker, privileged writes, or service changes occur in these tests."""

import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("configure_comfy_auth", Path(__file__).resolve().parents[1] / "scripts" / "configure-comfy-auth.py")
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
TOKEN = "ab" * 32


class CredentialTests(unittest.TestCase):
    def test_derived_credential_is_transferred_only_through_captured_stdout(self):
        runner = mock.Mock(return_value=mock.Mock(returncode=0, stdout=json.dumps({"mode": "derived", "token": TOKEN}).encode()))
        self.assertEqual(helper.read_bridge_token("ai-intermediary", runner=runner), TOKEN)
        argv = runner.call_args.args[0]
        self.assertEqual(argv[:5], ["docker", "exec", "ai-intermediary", "node", "-e"])
        self.assertNotIn(TOKEN, " ".join(argv))
        self.assertNotIn("env", runner.call_args.kwargs)
        self.assertEqual(runner.call_args.kwargs["stderr"], subprocess.DEVNULL)

    def test_node_derivation_matches_python_hmac_and_requires_admin(self):
        import hashlib
        import hmac
        environment = {"PATH": os.environ.get("PATH", ""), "ADMIN_TOKEN": "a-private-admin-value"}
        try:
            result = subprocess.run(["node", "-e", helper.DOCKER_PROGRAM], env=environment, capture_output=True, check=True)
        except FileNotFoundError:
            self.skipTest("Node is unavailable")
        expected = hmac.new(environment["ADMIN_TOKEN"].encode(), b"ai-intermediary/comfyui-bridge/v1", hashlib.sha256).hexdigest()
        self.assertEqual(json.loads(result.stdout), {"mode": "derived", "token": expected})
        environment.pop("ADMIN_TOKEN")
        environment["MEDIA_TOKEN"] = "legacy-value"
        result = subprocess.run(["node", "-e", helper.DOCKER_PROGRAM], env=environment, capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        for invalid_admin in [" padded ", "\tbad", "bad\x7f", "caf\u00e9", "\U0001f510-private", "x" * 4097]:
            environment["ADMIN_TOKEN"] = invalid_admin
            result = subprocess.run(["node", "-e", helper.DOCKER_PROGRAM], env=environment, capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, b"")

    def test_container_input_is_not_an_option_or_shell_expression(self):
        for name in ["-it", "one two", "one;pwd", "../name", "one\nname", "x" * 129]:
            with self.assertRaises(helper.SetupError):
                helper.validate_container(name)

    def test_invalid_or_failed_output_never_appears_in_error(self):
        values = [
            mock.Mock(returncode=1, stdout=b"very-private-secret"),
            mock.Mock(returncode=0, stdout=b"very-private-secret"),
            mock.Mock(returncode=0, stdout=json.dumps({"mode": "derived", "token": "very-private-secret"}).encode()),
            mock.Mock(returncode=0, stdout=json.dumps({"mode": "legacy", "token": "private\nINJECT=secret"}).encode()),
            mock.Mock(returncode=0, stdout=b"x" * 40000),
        ]
        for value in values:
            with self.assertRaises(helper.SetupError) as caught:
                helper.read_bridge_token("ai-intermediary", runner=mock.Mock(return_value=value))
            self.assertNotIn("private", str(caught.exception))

    def test_environment_preserves_comments_and_other_keys_replaces_only_token(self):
        previous = '# comment\nOTHER="keep"\nAI_INTERMEDIARY_COMFY_TOKEN=old\n\n  AI_INTERMEDIARY_COMFY_TOKEN=duplicate\nLAST=value'
        expected = '# comment\nOTHER="keep"\nAI_INTERMEDIARY_COMFY_TOKEN="' + TOKEN + '"\n\nLAST=value'
        self.assertEqual(helper.environment_text(previous, TOKEN), expected)
        self.assertEqual(helper.environment_text("OTHER=value", TOKEN), 'OTHER=value\nAI_INTERMEDIARY_COMFY_TOKEN="' + TOKEN + '"\n')

    def test_only_derived_machine_tokens_are_written(self):
        for token in ["", "   ", 'a"b\\c$`d', "value\nNEXT=x", "value\x00", "x" * 4097, "AB" * 32]:
            with self.assertRaises(helper.SetupError):
                helper.environment_text("", token)


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.options = {"anchor": str(self.root), "expected_uid": os.getuid()}
        self.parent = self.root / helper.DIRECTORY
        self.path = self.parent / helper.FILENAME

    def tearDown(self):
        self.temporary.cleanup()

    def test_preflight_is_read_only_and_first_write_is_private(self):
        helper.preflight(**self.options)
        self.assertFalse(self.parent.exists())
        self.assertIsNone(helper.write_configuration(TOKEN, **self.options))
        self.assertEqual(stat.S_IMODE(self.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertIn(TOKEN, self.path.read_text())

    def test_existing_file_gets_private_backup_and_idempotent_second_run(self):
        self.parent.mkdir(mode=0o700)
        self.path.write_text("# original\nOTHER=yes\n")
        backup = helper.write_configuration(TOKEN, **self.options)
        self.assertEqual((self.parent / backup).read_text(), "# original\nOTHER=yes\n")
        self.assertEqual(stat.S_IMODE((self.parent / backup).stat().st_mode), 0o600)
        self.assertTrue(self.path.read_text().startswith("# original\nOTHER=yes\n"))
        self.assertIsNone(helper.write_configuration(TOKEN, **self.options))
        self.assertEqual(len(list(self.parent.glob("*.backup-*"))), 1)

    def test_refuses_symlink_parent(self):
        external = self.root / "other"
        external.mkdir()
        self.parent.symlink_to(external, target_is_directory=True)
        with self.assertRaises(helper.SetupError):
            helper.write_configuration(TOKEN, **self.options)
        self.assertEqual(list(external.iterdir()), [])

    def test_refuses_symlink_file_and_preserves_target(self):
        self.parent.mkdir()
        target = self.root / "external"
        target.write_text("unchanged")
        self.path.symlink_to(target)
        with self.assertRaises(helper.SetupError):
            helper.write_configuration(TOKEN, **self.options)
        self.assertEqual(target.read_text(), "unchanged")
        self.assertTrue(self.path.is_symlink())

    def test_refuses_hardlinks_nonregular_and_unsafe_permissions(self):
        self.parent.mkdir()
        target = self.root / "external"
        target.write_text("unchanged")
        os.link(target, self.path)
        with self.assertRaises(helper.SetupError):
            helper.write_configuration(TOKEN, **self.options)
        self.path.unlink()
        self.path.mkdir()
        with self.assertRaises(helper.SetupError):
            helper.write_configuration(TOKEN, **self.options)
        self.path.rmdir()
        self.parent.chmod(0o777)
        with self.assertRaises(helper.SetupError):
            helper.write_configuration(TOKEN, **self.options)
        self.assertEqual(target.read_text(), "unchanged")

    def test_refuses_wrong_owner_and_oversized_existing_file(self):
        with self.assertRaises(helper.SetupError):
            helper.preflight(anchor=str(self.root), expected_uid=os.getuid() + 1)
        self.parent.mkdir()
        self.path.write_bytes(b"x" * (helper.MAX_ENV_BYTES + 1))
        with self.assertRaises(helper.SetupError):
            helper.write_configuration(TOKEN, **self.options)
        self.assertEqual(self.path.stat().st_size, helper.MAX_ENV_BYTES + 1)

    def test_write_failure_keeps_old_file_and_removes_only_owned_temporary(self):
        helper.write_configuration(TOKEN, **self.options)
        original = self.path.read_bytes()
        unrelated = self.parent / ".do-not-remove"
        unrelated.write_text("keep")
        with mock.patch.object(helper.os, "replace", side_effect=OSError("failure")):
            with self.assertRaises(helper.SetupError):
                helper.write_configuration("cd" * 32, **self.options)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(unrelated.read_text(), "keep")
        self.assertEqual(list(self.parent.glob(".comfy.env.tmp-*")), [])


class CliTests(unittest.TestCase):
    def test_non_root_never_calls_docker_or_writer(self):
        with mock.patch.object(helper.os, "geteuid", return_value=123), mock.patch.object(helper, "read_bridge_token") as read, mock.patch.object(helper, "write_configuration") as write, mock.patch("sys.stderr", new_callable=io.StringIO):
            self.assertEqual(helper.main(["--yes"]), 1)
        read.assert_not_called()
        write.assert_not_called()

    def test_check_cancel_and_noninteractive_are_nonmutating(self):
        for args, interactive, answer, code in [(["--check"], False, "", 0), ([], True, "no", 0), ([], False, "", 1)]:
            with mock.patch.object(helper.os, "geteuid", return_value=0), mock.patch.object(helper, "preflight"), mock.patch.object(helper, "read_bridge_token", return_value=TOKEN), mock.patch.object(helper, "write_configuration") as write, mock.patch.object(helper.sys.stdin, "isatty", return_value=interactive), mock.patch("builtins.input", return_value=answer), mock.patch("sys.stdout", new_callable=io.StringIO), mock.patch("sys.stderr", new_callable=io.StringIO):
                self.assertEqual(helper.main(args), code)
            write.assert_not_called()

    def test_confirmed_run_never_prints_secret_or_calls_service_commands(self):
        with mock.patch.object(helper.os, "geteuid", return_value=0), mock.patch.object(helper, "preflight"), mock.patch.object(helper, "read_bridge_token", return_value=TOKEN) as read, mock.patch.object(helper, "write_configuration", return_value="comfy.env.backup-example") as write, mock.patch("sys.stdout", new_callable=io.StringIO) as output, mock.patch.object(helper.subprocess, "run") as run:
            self.assertEqual(helper.main(["--container", "old-intermediary", "--yes"]), 0)
        read.assert_called_once_with("old-intermediary")
        write.assert_called_once_with(TOKEN)
        self.assertNotIn(TOKEN, output.getvalue())
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()

"""Installer tests never invoke sudo, Docker, systemd or actual AMD commands."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import install as installer


def runtime(**changes):
    return {'origin': 'http://192.0.2.10:11434', 'paused': True, 'active': False,
            'automatic_recovery': False, 'maintenance_configured': True, **changes}


def compose():
    before = {'name': 'existing', 'services': {'ai-intermediary': {'environment': {'KEEP': 'yes'},
              'volumes': [{'type': 'volume', 'source': 'old-state', 'target': '/app/state'}]}},
              'volumes': {'old-state': {'name': 'existing_state'}}}
    after = copy.deepcopy(before)
    service = after['services']['ai-intermediary']
    service['group_add'] = ['993']
    service['environment'].update(HOST_HELPER_ENABLED='true', AUTO_RECOVERY_ENABLED='false',
                                  HOST_HELPER_SOCKET_PATH=installer.RUNTIME + '/control.sock')
    service['volumes'].append({'type': 'bind', 'source': installer.RUNTIME, 'target': installer.RUNTIME, 'read_only': True})
    return before, after


class ValidationTests(unittest.TestCase):
    def test_requires_manual_pause_disabled_automation_and_no_active_work(self):
        self.assertEqual(installer.validate_runtime(runtime()), 'http://192.0.2.10:11434')
        for changes in [{'paused': False}, {'active': True}, {'automatic_recovery': True}, {'maintenance_configured': False}, {'timed_pause': True}]:
            with self.assertRaises(installer.SetupError):
                installer.validate_runtime(runtime(**changes))

    def test_origin_rejects_credentials_paths_and_newline(self):
        for value in ['http://user:secret@localhost:11434', 'file:///etc/passwd', 'http://localhost/api',
                      'http://localhost/?secret=yes', 'http://localhost/#fragment', 'http://local\nhost', None]:
            with self.assertRaises(installer.SetupError):
                installer.validate_origin(value)

    def test_backend_must_resolve_to_this_vm_not_an_unrelated_local_service(self):
        interfaces = [{'addr_info': [{'local': '192.0.2.10'}, {'local': '127.0.0.1'}]}]
        installer.validate_local_origin('http://192.0.2.10:11434', ['192.0.2.10'], interfaces)
        for url, ips in [('http://192.0.2.11:11434', ['192.0.2.11']), ('http://192.0.2.10:80', ['192.0.2.10']),
                         ('https://192.0.2.10:11434', ['192.0.2.10']), ('http://192.0.2.10:11434', [])]:
            with self.assertRaises(installer.SetupError):
                installer.validate_local_origin(url, ips, interfaces)

    def test_existing_configuration_preserved_or_refused_not_overwritten(self):
        text = installer.environment_text('http://192.0.2.10:11434', '/opt/rocm/bin/amd-smi')
        self.assertEqual(installer.environment_text('http://192.0.2.10:11434', '/opt/rocm/bin/amd-smi', text), text)
        with_comfy = text + 'COMFYUI_SYSTEMD_UNITS=comfyui.service,comfyui@second.service\n'
        self.assertEqual(installer.environment_text('http://192.0.2.10:11434', '/opt/rocm/bin/amd-smi', with_comfy), with_comfy)
        for units in ['ollama.service', '../bad.service', 'one.service,one.service']:
            with self.assertRaises(installer.SetupError):
                installer.environment_text('http://192.0.2.10:11434', '/opt/rocm/bin/amd-smi', text + 'COMFYUI_SYSTEMD_UNITS=' + units + '\n')
        for changed in [text.replace('192.0.2.10', '192.0.2.11'), text.replace('/var/lib/', '/somewhere/'), text + 'CUSTOM=yes\n']:
            with self.assertRaises(installer.SetupError):
                installer.environment_text('http://192.0.2.10:11434', '/opt/rocm/bin/amd-smi', changed)

    def test_only_helper_compose_changes_are_allowed(self):
        before, after = compose()
        installer.validate_compose_change(before, after, 993)
        for mutate in [
            lambda v: v.update(name='different-project'),
            lambda v: v['services']['ai-intermediary']['volumes'][0].update(source='new-empty-state'),
            lambda v: v['services']['ai-intermediary'].update(privileged=True),
            lambda v: v['services']['ai-intermediary']['environment'].update(AUTO_RECOVERY_ENABLED='true'),
            lambda v: v['services']['ai-intermediary']['volumes'][1].update(read_only=False),
        ]:
            changed = copy.deepcopy(after); mutate(changed)
            with self.assertRaises(installer.SetupError):
                installer.validate_compose_change(before, changed, 993)

    def test_canonical_service_keeps_existing_state_mount(self):
        before, after = compose()
        installer.validate_compose_change(before, after, 993)
        self.assertEqual(installer.ACCOUNT, 'ai-intermediary-host')
        self.assertEqual(installer.RUNTIME, '/run/ai-intermediary-host')
        self.assertEqual(after['volumes']['old-state']['name'], 'existing_state')
        before['services']['different-service'] = before['services'].pop('ai-intermediary')
        with self.assertRaises(installer.SetupError):
            installer.validate_compose_change(before, after, 993)

    def test_conflicting_helper_cannot_run_with_independent_restart_budget(self):
        safe = ['LoadState=not-found\n',
                'LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\n',
                'LoadState=masked\nActiveState=inactive\nUnitFileState=masked\n']
        for value in safe:
            with mock.patch.object(installer, 'run', return_value=value):
                installer.validate_no_conflicting_helper()
        unsafe = ['', 'LoadState=loaded\nActiveState=active\nUnitFileState=disabled\n',
                  'LoadState=loaded\nActiveState=inactive\nUnitFileState=enabled\n',
                  'LoadState=loaded\nActiveState=activating\nUnitFileState=disabled\n']
        for value in unsafe:
            with mock.patch.object(installer, 'run', return_value=value), self.assertRaises(installer.SetupError):
                installer.validate_no_conflicting_helper()

    def test_incomplete_telemetry_does_not_finish_setup(self):
        good = {'protocol': 'ollama-intermediary-host-v1', 'managed_ollama_origin': 'http://192.0.2.10:11434',
                'service': {'active': True}, 'telemetry': {'available': True, 'gpus': [{'processes_known': True, 'vram_total_bytes': 1}]}}
        installer.validate_helper_status(good, 'http://192.0.2.10:11434')
        for mutate in [lambda v: v['telemetry'].update(available=False), lambda v: v['telemetry'].update(gpus=[]),
                       lambda v: v['service'].update(active=False), lambda v: v.update(managed_ollama_origin='http://other:11434')]:
            changed = copy.deepcopy(good); mutate(changed)
            with self.assertRaises(installer.SetupError):
                installer.validate_helper_status(changed, 'http://192.0.2.10:11434')

    def test_command_failure_redacts_private_output(self):
        completed = mock.Mock(returncode=1, stdout='secret', stderr='private token')
        with mock.patch.object(installer.subprocess, 'run', return_value=completed):
            with self.assertRaises(installer.SetupError) as caught:
                installer.run(['docker', 'compose', 'config'])
        self.assertNotIn('secret', str(caught.exception))
        self.assertNotIn('token', str(caught.exception))


class InstallationTests(unittest.TestCase):
    def test_mock_install_preserves_state_and_restarts_only_helper_and_intermediary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); project = root / 'project'; project.mkdir()
            setup = installer.Installer(project, '/opt/rocm/bin/amd-smi')
            setup.original = '# original override\n'
            setup.override.write_text(setup.original)
            setup.origin = 'http://192.0.2.10:11434'; setup.gid = 993
            setup.before, _ = compose()
            commands = []
            staged = 'services: {ai-intermediary: {group_add: [993]}}\n'
            good = {'protocol': 'ollama-intermediary-host-v1', 'managed_ollama_origin': setup.origin,
                    'service': {'active': True}, 'telemetry': {'available': True, 'gpus': [{'processes_known': True, 'vram_total_bytes': 1}]}}

            def run(argv, **kwargs):
                commands.append(argv)
                return json.dumps(good) if '-c' in argv and '/usr/bin/python3' in argv else ''

            def compose_call(*args, **kwargs):
                commands.append(['docker', 'compose', *args])
                return json.dumps(setup.before) if '--format' in args else ''

            with mock.patch.object(installer, 'ENV_PATH', str(root / 'helper.env')), \
                    mock.patch.object(installer, 'ARTIFACTS', {'host_helper.py': str(root / 'installed.py'),
                                                           installer.SERVICE: str(root / 'helper.service'),
                                                           installer.ACCOUNT + '.sudoers': str(root / 'helper.sudoers')}), \
                    mock.patch.object(installer, 'run', side_effect=run), \
                    mock.patch.object(installer, 'validate_host_target'), \
                    mock.patch.object(installer.subprocess, 'run', return_value=mock.Mock(returncode=0)), \
                    mock.patch.object(installer.Path, 'home', return_value=root), \
                    mock.patch.object(setup, 'prepare_override', return_value=staged), \
                    mock.patch.object(setup, 'still_paused'), \
                    mock.patch.object(installer, 'validate_no_conflicting_helper'), \
                    mock.patch.object(setup, 'compose', side_effect=compose_call), \
                    mock.patch.object(setup, 'container', return_value=runtime(telemetry_verified=True)):
                setup.install()
            self.assertEqual(setup.override.read_text(), staged)
            self.assertEqual((setup.backup / 'docker-compose.override.yml').read_text(), '# original override\n')
            restarts = [v for v in commands if 'restart' in v]
            self.assertEqual(restarts, [['sudo', '/usr/bin/systemctl', 'restart', installer.SERVICE]])
            self.assertIn(['docker', 'compose', 'up', '-d', '--no-deps', '--force-recreate', 'ai-intermediary'], commands)
            joined = json.dumps(commands)
            for forbidden in ['reboot', 'gpu-reset', 'down', 'restart ollama.service']:
                self.assertNotIn(forbidden, joined)

    def test_cancel_and_check_never_call_install(self):
        for args, answer in [(['install.py', '--check'], None), (['install.py'], 'NO')]:
            with mock.patch.object(installer.sys, 'argv', args), \
                    mock.patch.object(installer.Installer, 'preflight'), \
                    mock.patch.object(installer.Installer, 'install') as install_mock, \
                    mock.patch.object(installer.Installer, 'origin', 'http://192.0.2.10:11434', create=True), \
                    mock.patch.object(installer.Installer, 'helper_state', 'LoadState=not-found', create=True), \
                    mock.patch.object(installer.sys.stdin, 'isatty', return_value=True), \
                    mock.patch('builtins.input', return_value=answer), mock.patch('builtins.print'):
                self.assertEqual(installer.main(), 0)
                install_mock.assert_not_called()


if __name__ == '__main__':
    unittest.main()

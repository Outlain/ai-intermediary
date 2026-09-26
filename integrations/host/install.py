#!/usr/bin/env python3
"""Interactive host-only setup. No Docker socket is mounted in the container.

Run as your normal Docker-capable user; sudo is requested only after confirmation.
--check performs read-only preflight and Compose validation, without sudo or setup.
"""
import argparse
import grp
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

from host_helper import SafeError, SystemHost

ACCOUNT = 'ai-intermediary-host'
SERVICE = ACCOUNT + '.service'
RUNTIME = '/run/' + ACCOUNT
ENV_PATH = '/etc/ai-intermediary-host.env'
ARTIFACTS = {
    'host_helper.py': '/opt/ai-intermediary-host/host_helper.py',
    SERVICE: '/etc/systemd/system/' + SERVICE,
    ACCOUNT + '.sudoers': '/etc/sudoers.d/' + ACCOUNT,
}


class SetupError(Exception):
    pass


def run(argv, *, cwd=None, data=None, timeout=30, allowed_exit=(0,)):
    try:
        result = subprocess.run(argv, cwd=cwd, input=data, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise SetupError(f'{Path(argv[0]).name}: unavailable or timed out; no command output exposed.') from None
    if result.returncode not in allowed_exit:
        # Compose output may contain expanded credentials. Do not echo it.
        raise SetupError(f'{Path(argv[0]).name}: command failed (exit {result.returncode}). '
                         'Check prerequisites; private command output was not printed.')
    return result.stdout


def secure_executable(value):
    candidate = Path(value).resolve(strict=True)
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise SetupError('AMD SMI must be an executable file.')
    for item in [candidate, *candidate.parents]:
        info = item.stat()
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise SetupError('AMD SMI and its parent directories must be root-owned and not group/world writable.')
    return str(candidate)


def validate_origin(value):
    try:
        parts = urlsplit(value)
        _ = parts.port
        if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username
                or parts.password or parts.path not in ('', '/') or parts.query or parts.fragment
                or any(c.isspace() for c in value) or any(ord(c) < 32 for c in value)):
            raise ValueError()
    except (TypeError, ValueError):
        raise SetupError('The effective Ollama URL must be an HTTP(S) origin without credentials or an /api path.') from None
    return value.rstrip('/')


def validate_runtime(value):
    if not value.get('paused') or value.get('active'):
        raise SetupError('Pause inference in the dashboard and wait until no active/management request remains, then rerun.')
    if value.get('automatic_recovery') is not False:
        raise SetupError('Disable Automatic Ollama recovery in Settings before installing/updating this helper.')
    if value.get('timed_pause'):
        raise SetupError('Use Until manually resumed for the maintenance pause, not a timed pause, during setup.')
    if not value.get('maintenance_configured'):
        raise SetupError('Configure ADMIN_TOKEN before setup; the installer never creates or prints passwords.')
    return validate_origin(value.get('origin'))


def validate_no_conflicting_helper():
    # Two privileged helpers would have independent restart budgets. An older
    # installation must be retired by its operator before this one is started.
    previous = run(['systemctl', 'show', 'ollama-intermediary-host.service',
                    '--property=LoadState,ActiveState,UnitFileState'], allowed_exit=(0, 1))
    values = dict(line.split('=', 1) for line in previous.splitlines() if '=' in line)
    if values.get('LoadState') == 'not-found':
        return
    if (values.get('ActiveState') not in ('inactive', 'failed')
            or values.get('UnitFileState') not in ('disabled', 'masked', 'masked-runtime')):
        raise SetupError('Another host-helper installation may still run. Stop and disable it, preserve its restart journal, '
                         'and complete the deployment migration before installing this helper.')


def validate_local_origin(origin, resolved, interfaces):
    parts = urlsplit(origin)
    if parts.scheme != 'http' or parts.port != 11434:
        raise SetupError('Automatic setup supports direct native HTTP Ollama on port 11434. Use the manual guide for custom ports/proxies.')
    local = {ipaddress.ip_address(info['local'].split('%')[0]) for interface in interfaces for info in interface.get('addr_info', [])}
    addresses = {ipaddress.ip_address(value.split('%')[0]) for value in resolved}
    if not addresses or not addresses.issubset(local):
        raise SetupError('The configured Ollama backend does not resolve exclusively to this VM. Do not install control of an unrelated local service.')


def environment_text(origin, amd, previous=None):
    expected = {'MANAGED_OLLAMA_ORIGIN': origin, 'AMD_SMI_PATH': amd,
                'HOST_HELPER_SOCKET': RUNTIME + '/control.sock',
                'HOST_HELPER_STATE': '/var/lib/ai-intermediary-host/state.json'}
    if previous is not None:
        parsed = {}
        for line in previous.splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            if '=' not in line:
                raise SetupError('Existing helper environment has unsupported syntax; preserve it and use the manual guide.')
            key, value = line.split('=', 1)
            if key in parsed or (key not in expected and key != 'COMFYUI_SYSTEMD_UNITS'):
                raise SetupError('Existing helper environment contains custom/duplicate settings; manual review required.')
            parsed[key] = value.strip().strip('"').strip("'")
        comparable = dict(parsed)
        units = comparable.pop('COMFYUI_SYSTEMD_UNITS', '')
        allowed_units = [unit.strip() for unit in units.split(',') if unit.strip()]
        if (len(allowed_units) > 8 or len(set(allowed_units)) != len(allowed_units)
                or any(len(unit) > 128 or not re.fullmatch(r'[a-zA-Z0-9_.@-]+\.service', unit)
                       or unit == 'ollama.service' for unit in allowed_units)):
            raise SetupError('Existing COMFYUI_SYSTEMD_UNITS is invalid; manual review required.')
        if 'AMD_SMI_PATH' in comparable:
            comparable['AMD_SMI_PATH'] = str(Path(comparable['AMD_SMI_PATH']).resolve())
        if 'MANAGED_OLLAMA_ORIGIN' in comparable:
            comparable['MANAGED_OLLAMA_ORIGIN'] = validate_origin(comparable['MANAGED_OLLAMA_ORIGIN'])
        if comparable != expected:
            raise SetupError('Existing helper configuration differs from this installation. It was not overwritten; review it manually.')
        return previous
    return '# Created by the intermediary host-only installer. No secrets are stored here.\n' + ''.join(
        f'{key}={value}\n' for key, value in expected.items())


def validate_compose_change(before, after, gid):
    """Only the selected service's three env keys, helper group and socket change."""
    original = json.loads(json.dumps(before))
    candidate = json.loads(json.dumps(after))
    try:
        if 'ai-intermediary' not in original['services']:
            raise ValueError()
        old = original['services']['ai-intermediary']
        new = candidate['services']['ai-intermediary']
        expected_env = {'HOST_HELPER_ENABLED': 'true', 'HOST_HELPER_SOCKET_PATH': RUNTIME + '/control.sock',
                        'AUTO_RECOVERY_ENABLED': 'false'}
        if any(new.get('environment', {}).get(k) != v for k, v in expected_env.items()):
            raise ValueError()
        mounts = [v for v in new.get('volumes', []) if v.get('target') == RUNTIME]
        if len(mounts) != 1 or mounts[0].get('type') != 'bind' or mounts[0].get('source') != RUNTIME or mounts[0].get('read_only') is not True:
            raise ValueError()
        old_groups = [str(v) for v in old.get('group_add', [])]
        new_groups = [str(v) for v in new.get('group_add', [])]
        if set(new_groups) != set(old_groups + [str(gid)]):
            raise ValueError()
        for obj in (old, new):
            obj.pop('group_add', None)
            for key in ('HOST_HELPER_ENABLED', 'HOST_HELPER_SOCKET_PATH', 'AUTO_RECOVERY_ENABLED'):
                obj.get('environment', {}).pop(key, None)
            if obj.get('environment') == {}:
                obj.pop('environment', None)
            obj['volumes'] = [v for v in obj.get('volumes', []) if v.get('target') != RUNTIME]
            if not obj['volumes']:
                obj.pop('volumes')
        if original != candidate:
            raise ValueError()
    except (KeyError, TypeError, AttributeError, ValueError):
        raise SetupError('Compose validation found unrelated deployment changes. Nothing was replaced; use the manual guide.') from None


def validate_account():
    try:
        user = pwd.getpwnam(ACCOUNT)
    except KeyError:
        return None
    if user.pw_uid == 0 or user.pw_shell not in ('/usr/sbin/nologin', '/sbin/nologin'):
        raise SetupError('The helper account already exists but is not the expected restricted account.')
    group = grp.getgrgid(user.pw_gid)
    memberships = set(os.getgrouplist(ACCOUNT, user.pw_gid))
    if group.gr_name != ACCOUNT or any(grp.getgrnam(name).gr_gid not in memberships for name in ('render', 'video')):
        raise SetupError('Existing helper account groups differ; review them manually rather than changing another account.')
    return user.pw_gid


def validate_host_target(target):
    # Never follow a pre-existing symlink or install root code through a
    # user-writable parent. Missing helper directories will be created by install.
    for item in [Path(target), *Path(target).parents]:
        if item.is_symlink():
            raise SetupError('A host installation path is a symlink; manual review required.')
        if item.exists():
            info = item.stat()
            if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
                raise SetupError('Existing host installation paths must be root-owned and not group/world writable.')


class Installer:
    def __init__(self, project, amd):
        self.project = Path(project).resolve()
        self.source = Path(__file__).resolve().parent
        self.amd = amd
        self.override = self.project / 'docker-compose.override.yml'
        self.backup = None
        self.service = 'ai-intermediary'

    def compose(self, *args, candidate=None, timeout=30):
        files = ['-f', str(self.project / 'docker-compose.yml')]
        if candidate is not None or self.override.exists():
            files += ['-f', str(candidate or self.override)]
        return run(['docker', 'compose', *files, *args], cwd=self.project, timeout=timeout)

    def container(self, payload):
        code = (self.source / 'installer-compose.mjs').read_text()
        raw = run(['docker', 'compose', 'exec', '-T', self.service, 'node',
                   '--input-type=module', '-e', code, '--', '--host-install'], cwd=self.project,
                  data=json.dumps(payload), timeout=20)
        try:
            return json.loads(raw)
        except ValueError:
            raise SetupError('Intermediary preflight returned an invalid response.') from None

    def preflight(self):
        if not sys.platform.startswith('linux') or not Path('/run/systemd/system').is_dir():
            raise SetupError('Run this on the Ubuntu/Linux VM that runs native ollama.service, not inside Docker or on the Frigate host.')
        if os.geteuid() == 0:
            raise SetupError('Run as your normal Docker-capable user, without sudo. The script asks for sudo after confirmation.')
        if os.environ.get('COMPOSE_FILE'):
            raise SetupError('Custom COMPOSE_FILE is set; use the manual guide to preserve your deployment layout.')
        for name in ('docker', 'sudo', 'systemctl', 'python3', 'ip'):
            if not shutil.which(name):
                raise SetupError(f'Required command is missing: {name}')
        for name in ('render', 'video'):
            try:
                grp.getgrnam(name)
            except KeyError:
                raise SetupError(f'Required GPU group is missing: {name}') from None
        for name in ('docker-compose.yml', 'config.yml', 'secrets.env'):
            if not (self.project / name).is_file():
                raise SetupError(f'Expected existing source deployment file is missing: {name}')
        if self.override.is_symlink() or any((self.project / name).exists() for name in ('compose.yml', 'compose.yaml', 'docker-compose.yaml', 'docker-compose.override.yaml')):
            raise SetupError('Nonstandard/symlinked Compose layout; use the manual guide.')
        dotenv = self.project / '.env'
        if dotenv.exists() and re.search(r'^\s*(?:export\s+)?COMPOSE_FILE\s*=', dotenv.read_text(), re.M):
            raise SetupError('COMPOSE_FILE in .env requires manual setup; it was not changed.')
        endpoint = os.environ.get('DOCKER_HOST')
        if not endpoint:
            context = json.loads(run(['docker', 'context', 'inspect']))[0]
            endpoint = context['Endpoints']['docker']['Host']
        if not endpoint.startswith('unix://'):
            raise SetupError('The Docker engine must be local to this VM, not an SSH/TCP context.')
        self.before = json.loads(self.compose('config', '--format', 'json'))
        if self.service not in self.before.get('services', {}):
            raise SetupError('Expected the ai-intermediary Compose service; use the manual guide for a custom deployment.')
        container = run(['docker', 'compose', 'ps', '--quiet', self.service], cwd=self.project).strip()
        if not container or '\n' in container:
            raise SetupError('Start the updated intermediary container before running setup.')
        inspect = json.loads(run(['docker', 'inspect', container]))[0]
        labels = inspect['Config'].get('Labels', {})
        expected = [str(self.project / 'docker-compose.yml')]
        if self.override.exists():
            expected.append(str(self.override))
        actual = labels.get('com.docker.compose.project.config_files', '').split(',')
        if actual != expected or labels.get('com.docker.compose.project.working_dir') != str(self.project):
            raise SetupError('The running container uses different Compose files/project directory. Preserve that layout using the manual guide.')
        self.original = self.override.read_text() if self.override.exists() else None
        if self.original is not None and len(self.original) > 1024 * 1024:
            raise SetupError('Compose override is unusually large; manual review required.')
        self.origin = validate_runtime(self.container({'mode': 'inspect'}))
        resolved = self.container({'mode': 'resolve', 'origin': self.origin})['addresses']
        interfaces = json.loads(run(['ip', '-j', 'address', 'show']))
        validate_local_origin(self.origin, resolved, interfaces)
        candidate = self.amd or shutil.which('amd-smi') or '/opt/rocm/bin/amd-smi'
        self.amd = secure_executable(candidate)
        service = SystemHost(self.amd).service()
        if not service['active'] or service['kill_mode'] != 'control-group':
            raise SetupError('ollama.service must be active and use KillMode=control-group; the installer will not change or restart it.')
        validate_no_conflicting_helper()
        self.gid = validate_account()
        for target in [*ARTIFACTS.values(), ENV_PATH]:
            validate_host_target(target)
        self.helper_state = run(['systemctl', 'show', SERVICE, '--property=LoadState,ActiveState'], allowed_exit=(0, 1)).strip()
        if not self.helper_state:
            self.helper_state = 'No helper unit state returned; setup will install the reviewed unit.'
        self.prepare_override(self.gid if self.gid is not None else 99999)

    def prepare_override(self, gid):
        merged = self.container({'mode': 'merge', 'yaml': self.original or '', 'gid': gid, 'service': self.service})['yaml']
        with tempfile.TemporaryDirectory(prefix='ai-compose-check-') as directory:
            candidate = Path(directory) / 'override.yml'
            candidate.write_text(merged)
            after = json.loads(self.compose('config', '--format', 'json', candidate=candidate))
        validate_compose_change(self.before, after, gid)
        return merged

    def still_paused(self):
        if validate_runtime(self.container({'mode': 'inspect'})) != self.origin:
            raise SetupError('Ollama URL changed during setup; rerun the checks.')

    def install(self):
        # Keep sudo's own password prompt visible; all subsequent command output
        # is captured/redacted. Credentials never enter Python or process args.
        try:
            subprocess.run(['sudo', '-v'], check=True, timeout=120)
        except (subprocess.SubprocessError, OSError):
            raise SetupError('sudo authorization failed; no installation performed.') from None
        self.still_paused()
        validate_no_conflicting_helper()
        for target in [*ARTIFACTS.values(), ENV_PATH]:
            validate_host_target(target)
        # Refuse customized persistent locations rather than resetting journals.
        previous = run(['sudo', '/usr/bin/test', '-e', ENV_PATH]) if Path(ENV_PATH).exists() else None
        if previous is not None:
            previous = run(['sudo', '/usr/bin/cat', ENV_PATH])
        env_text = environment_text(self.origin, self.amd, previous)
        backup_root = Path.home() / '.local' / 'state' / 'ai-intermediary-installer'
        backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.backup = Path(tempfile.mkdtemp(prefix='backup-', dir=backup_root))
        for target in [*ARTIFACTS.values(), ENV_PATH]:
            if Path(target).is_symlink():
                raise SetupError('An existing host artifact is a symlink; manual review required.')
            if Path(target).exists():
                content = run(['sudo', '/usr/bin/cat', target])
                (self.backup / Path(target).name).write_text(content)
        if self.original is not None:
            (self.backup / 'docker-compose.override.yml').write_text(self.original)
        if self.gid is None:
            run(['sudo', '/usr/sbin/useradd', '--system', '--user-group', '--no-create-home',
                 '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', '--groups', 'render,video', ACCOUNT])
            self.gid = validate_account()
        merged = self.prepare_override(self.gid)
        # Check AMD access as the dedicated account. Failure never grants broader sudo.
        for args in (['metric', '--mem-usage', '--usage', '--temperature', '--power', '--json'], ['process', '--json']):
            run(['sudo', '-u', ACCOUNT, self.amd, *args], timeout=20)
        run(['sudo', '/usr/sbin/visudo', '-cf', str(self.source / (ACCOUNT + '.sudoers'))])
        run(['sudo', '/usr/bin/install', '-d', '-o', 'root', '-g', 'root', '-m', '0755', '/opt/ai-intermediary-host'])
        for name, target in ARTIFACTS.items():
            mode = '0440' if name.endswith('.sudoers') else '0644'
            run(['sudo', '/usr/bin/install', '-o', 'root', '-g', 'root', '-m', mode, str(self.source / name), target])
        with tempfile.TemporaryDirectory(prefix='ai-host-environment-') as directory:
            temporary = Path(directory) / 'host.env'
            temporary.write_text(env_text)
            run(['sudo', '/usr/bin/install', '-o', 'root', '-g', 'root', '-m', '0640', str(temporary), ENV_PATH])
        run(['sudo', '/usr/sbin/visudo', '-c'])
        self.still_paused()
        validate_no_conflicting_helper()
        run(['sudo', '/usr/bin/systemctl', 'daemon-reload'])
        run(['sudo', '/usr/bin/systemctl', 'enable', SERVICE])
        run(['sudo', '/usr/bin/systemctl', 'restart', SERVICE], timeout=30)  # helper only, NOT Ollama
        # Read-only request as the socket's owner. No restart endpoint is called.
        probe = """import http.client,json,socket,time
for attempt in range(10):
 try:
  sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); sock.settimeout(20)
  sock.connect('/run/ai-intermediary-host/control.sock')
  conn=http.client.HTTPConnection('localhost'); conn.sock=sock
  conn.request('GET','/v1/status'); reply=conn.getresponse()
  if reply.status!=200: raise RuntimeError()
  print(reply.read(524288).decode()); conn.close(); break
 except OSError:
  if attempt==9: raise
  time.sleep(0.5)
"""
        status = json.loads(run(['sudo', '-u', ACCOUNT, '/usr/bin/python3', '-c', probe], timeout=30))
        validate_helper_status(status, self.origin)
        self.still_paused()
        current = self.override.read_text() if self.override.exists() else None
        if current != self.original:
            raise SetupError('Compose override changed during setup. It was not replaced; rerun setup.')
        if json.loads(self.compose('config', '--format', 'json')) != self.before:
            raise SetupError('Effective Compose configuration changed during setup; it was not replaced.')
        # Atomic replacement; retain private backups, never touch config/secrets/state.
        descriptor, filename = tempfile.mkstemp(prefix='.host-helper-override-', dir=self.project)
        try:
            with os.fdopen(descriptor, 'w') as stream:
                stream.write(merged); stream.flush(); os.fsync(stream.fileno())
            os.replace(filename, self.override)
        finally:
            if os.path.exists(filename):
                os.unlink(filename)
        self.compose('config', '--quiet')
        self.compose('up', '-d', '--no-deps', '--force-recreate', self.service, timeout=240)
        deadline = time.monotonic() + 60
        while True:
            try:
                verified = self.container({'mode': 'verify'})
                validate_runtime(verified)
                if verified.get('origin') != self.origin or verified.get('telemetry_verified') is not True:
                    raise SetupError('Container could not verify the installed helper; recovery remains disabled.')
                break
            except SetupError:
                if time.monotonic() >= deadline:
                    raise SetupError('Container verification did not succeed after recreation. '
                                     'Check intermediary/helper logs; do not enable recovery yet.') from None
                time.sleep(2)


def validate_helper_status(status, origin):
    telemetry = status.get('telemetry', {})
    gpus = telemetry.get('gpus', [])
    if (status.get('protocol') != 'ollama-intermediary-host-v1'
            or status.get('managed_ollama_origin') != origin
            or status.get('service', {}).get('active') is not True
            or telemetry.get('available') is not True or not gpus
            or any(gpu.get('processes_known') is not True or gpu.get('vram_total_bytes') is None for gpu in gpus)):
        raise SetupError('Helper did not report usable AMD telemetry and the expected Ollama service. '
                         'Inspect journalctl -u ai-intermediary-host.service; recovery remains disabled.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Read-only preflight; never install or recreate anything.')
    parser.add_argument('--project-dir', default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument('--amd-smi', help='Root-owned AMD SMI executable if not on PATH.')
    args = parser.parse_args()
    installer = Installer(args.project_dir, args.amd_smi)
    try:
        installer.preflight()
        print(f'Checks passed. Ollama origin: {installer.origin}\nAMD SMI: {installer.amd}')
        print('Current helper unit: ' + installer.helper_state.replace('\n', ', '))
        print('Plan: install/update the restricted host helper and its Ollama-only sudoers rule;\n'
              'back up existing files; merge the socket/group into your Compose override;\n'
              'verify telemetry; recreate only the paused intermediary container.\n'
              'Automatic recovery stays OFF until you enable it in Settings.\n'
              'No Ollama restart, GPU reset, reboot, driver install, or state deletion is performed.')
        if args.check:
            print('Read-only check complete. No installation performed.')
            return 0
        if not sys.stdin.isatty() or input('Type INSTALL to proceed: ').strip() != 'INSTALL':
            print('Cancelled. No installation performed.')
            return 0
        installer.install()
        print('Helper installed and Compose updated. Refresh the dashboard.\n'
              'In Settings → Host telemetry & automatic recovery, enable Host GPU monitoring\n'
              'if needed, verify fresh metrics, then enable Automatic Ollama recovery.\n'
              'Your manual pause remains; use Check recovery now for an existing lock, then Resume separately.')
        print(f'Private backups: {installer.backup}')
        return 0
    except (SetupError, SafeError, OSError, ValueError, KeyError) as error:
        message = str(error) if isinstance(error, SetupError) else 'A host prerequisite or validation failed; setup stopped without exposing private output.'
        print('STOP: ' + message, file=sys.stderr)
        if installer.backup:
            print(f'Partial installation may remain. Backups: {installer.backup}. '
                  'Do not delete recovery journals or broaden permissions; resolve the error before retrying.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

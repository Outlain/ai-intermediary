#!/usr/bin/env python3
"""Provision ComfyUI's machine credential without copying a human password.

Run on the Linux host as root. This does not install or restart any service.
The systemd unit must use EnvironmentFile=/etc/ai-intermediary/comfy.env.
"""

import argparse
import datetime
import json
import os
import re
import secrets
import stat
import subprocess
import sys


DIRECTORY = "ai-intermediary"
FILENAME = "comfy.env"
ENV_KEY = "AI_INTERMEDIARY_COMFY_TOKEN"
MAX_ENV_BYTES = 1024 * 1024
MAX_TOKEN_BYTES = 4096
DOCKER_PROGRAM = r"""
const crypto = require('node:crypto');
const admin = process.env.ADMIN_TOKEN || '';
if (!admin.trim() || admin.trim() !== admin || admin.length > 4096 || /[^\x20-\x7e]/.test(admin)) process.exit(2);
const token = crypto.createHmac('sha256', admin)
  .update('ai-intermediary/comfyui-bridge/v1').digest('hex');
process.stdout.write(JSON.stringify({mode: 'derived', token}));
"""


class SetupError(Exception):
    """An operator-facing error that never contains a credential."""


def validate_container(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value):
        raise SetupError("Invalid container name.")
    return value


def read_bridge_token(container, runner=None):
    """The secret travels in a private pipe, never in argv or subprocess env."""
    validate_container(container)
    runner = runner or subprocess.run
    try:
        result = runner(
            ["docker", "exec", container, "node", "-e", DOCKER_PROGRAM],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            check=False, timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        raise SetupError("Could not read authentication configuration from the running container.") from None
    if result.returncode != 0 or not isinstance(result.stdout, bytes) or len(result.stdout) > 32768:
        raise SetupError("The running container has no usable ADMIN_TOKEN.")
    try:
        payload = json.loads(result.stdout)
        token = payload["token"]
        mode = payload["mode"]
        if not isinstance(token, str) or not token.strip() or len(token.encode("utf-8")) > MAX_TOKEN_BYTES:
            raise ValueError()
        if any(ord(character) < 32 or ord(character) == 127 for character in token):
            raise ValueError()
        if mode != "derived" or not re.fullmatch(r"[0-9a-f]{64}", token):
            raise ValueError()
    except (KeyError, TypeError, ValueError, UnicodeError):
        raise SetupError("Container returned an invalid machine credential; nothing was written.") from None
    return token


def environment_text(previous, token):
    # systemd EnvironmentFile double quotes recognize backslash escapes. Escape
    # all characters with special meaning rather than accepting shell syntax.
    if not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{64}", token):
        raise SetupError("Invalid machine credential.")
    escaped = token.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$").replace("`", "\\`")
    setting = f'{ENV_KEY}="{escaped}"\n'
    matcher = re.compile(r"^[ \t]*(?:export[ \t]+)?" + ENV_KEY + r"[ \t]*=")
    output = []
    replaced = False
    for line in previous.splitlines(keepends=True):
        if matcher.match(line):
            if not replaced:
                output.append(setting)
                replaced = True
        else:
            output.append(line)
    if not replaced:
        if output and not output[-1].endswith(("\n", "\r")):
            output.append("\n")
        output.append(setting)
    return "".join(output)


def _check_directory(fd, expected_uid):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != expected_uid or info.st_mode & 0o022:
        raise SetupError("Configuration parent must be owned by root and not writable by other users.")


def _open_parent(anchor, expected_uid, create):
    """Use anchored, no-follow descriptors; production anchor is fixed /etc."""
    anchor_fd = os.open(anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        _check_directory(anchor_fd, expected_uid)
        try:
            parent_fd = os.open(DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=anchor_fd)
        except FileNotFoundError:
            if not create:
                return None
            os.mkdir(DIRECTORY, 0o700, dir_fd=anchor_fd)
            os.fsync(anchor_fd)
            parent_fd = os.open(DIRECTORY, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=anchor_fd)
        try:
            _check_directory(parent_fd, expected_uid)
        except BaseException:
            os.close(parent_fd)
            raise
        return parent_fd
    finally:
        os.close(anchor_fd)


def _read_existing(parent_fd, expected_uid):
    try:
        fd = os.open(FILENAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
    except FileNotFoundError:
        return b"", None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != expected_uid or info.st_mode & 0o022 or info.st_nlink != 1:
            raise SetupError("Existing ComfyUI environment file must be a root-owned, regular, unshared file.")
        if info.st_size > MAX_ENV_BYTES:
            raise SetupError("Existing environment file exceeds the size limit.")
        data = b""
        while len(data) <= MAX_ENV_BYTES:
            chunk = os.read(fd, min(65536, MAX_ENV_BYTES + 1 - len(data)))
            if not chunk:
                break
            data += chunk
        if len(data) > MAX_ENV_BYTES:
            raise SetupError("Existing environment file exceeds the size limit.")
        return data, info
    finally:
        os.close(fd)


def preflight(*, anchor="/etc", expected_uid=0):
    parent_fd = None
    try:
        parent_fd = _open_parent(anchor, expected_uid, create=False)
        if parent_fd is not None:
            _read_existing(parent_fd, expected_uid)
    except OSError:
        raise SetupError("Unsafe or inaccessible ComfyUI configuration path; nothing was written.") from None
    finally:
        if parent_fd is not None:
            os.close(parent_fd)


def _write_private(parent_fd, filename, data):
    fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
    try:
        os.fchmod(fd, 0o600)
        remaining = memoryview(data)
        while remaining:
            written = os.write(fd, remaining)
            if written <= 0:
                raise OSError("Short write")
            remaining = remaining[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def write_configuration(token, *, anchor="/etc", expected_uid=0):
    """Write only this configuration; return private backup basename or None."""
    parent_fd = None
    temporary = None
    try:
        parent_fd = _open_parent(anchor, expected_uid, create=True)
        previous, original = _read_existing(parent_fd, expected_uid)
        try:
            updated = environment_text(previous.decode("utf-8"), token).encode("utf-8")
        except UnicodeError:
            raise SetupError("Existing environment file is not UTF-8; nothing was replaced.") from None
        if len(updated) > MAX_ENV_BYTES:
            raise SetupError("Updated environment file would exceed the size limit.")
        if previous == updated and original is not None and stat.S_IMODE(original.st_mode) == 0o600:
            return None
        backup = None
        if original is not None:
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup = f"{FILENAME}.backup-{stamp}-{secrets.token_hex(6)}"
            _write_private(parent_fd, backup, previous)
            os.fsync(parent_fd)
        temporary = f".{FILENAME}.tmp-{secrets.token_hex(12)}"
        _write_private(parent_fd, temporary, updated)
        try:
            current = os.stat(FILENAME, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            current = None
        if (original is None) != (current is None) or (original is not None and _identity(original) != _identity(current)):
            raise SetupError("Configuration changed during setup; refusing to overwrite it.")
        os.replace(temporary, FILENAME, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        temporary = None
        os.fsync(parent_fd)
        return backup
    except OSError:
        raise SetupError("Could not safely update ComfyUI authentication; check configuration ownership and disk space.") from None
    finally:
        if parent_fd is not None:
            if temporary is not None:
                try:
                    os.unlink(temporary, dir_fd=parent_fd)
                except FileNotFoundError:
                    pass
            os.close(parent_fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", default="ai-intermediary", help="Running intermediary container (default: ai-intermediary)")
    parser.add_argument("--yes", action="store_true", help="Confirm the private host configuration update without a prompt")
    parser.add_argument("--check", action="store_true", help="Read and validate prerequisites without creating or changing files")
    args = parser.parse_args(argv)
    try:
        if os.geteuid() != 0:
            raise SetupError("Run this command with sudo; the credential belongs in a root-owned private environment file.")
        validate_container(args.container)
        preflight()
        token = read_bridge_token(args.container)
        if args.check:
            print("Authentication and host path checks passed. No files changed.")
            return 0
        if not args.yes:
            if not sys.stdin.isatty():
                raise SetupError("Confirmation required. Run interactively or supply --yes.")
            answer = input("Update /etc/ai-intermediary/comfy.env (private backup if it exists)? [y/N] ")
            if answer.strip().lower() not in ("y", "yes"):
                print("Cancelled. No files changed.")
                return 0
        backup = write_configuration(token)
        print("ComfyUI machine authentication configured in /etc/ai-intermediary/comfy.env (root-only, mode 0600).")
        if backup:
            print("Previous configuration preserved in the same private directory as " + backup + ".")
        print("No services were installed or restarted. Configure the ComfyUI systemd unit to read this EnvironmentFile.")
        return 0
    except (SetupError, KeyboardInterrupt) as error:
        message = str(error) if isinstance(error, SetupError) else "Cancelled."
        print("Setup stopped: " + message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Validate and import ONE owned MP4 without generation, deletion or GPU recovery.

Run on the Linux ComfyUI host after deploying the matching intermediary update.
Requires Docker access, ffmpeg/ffprobe and read access to ComfyUI's output folder.
The administrator credential stays inside the container; originals are read-only.
"""
import argparse
import contextlib
import hashlib
import json
import math
import os
from pathlib import PurePosixPath
import re
import stat
import subprocess
import sys

MAX_FILE = 512 * 1024 * 1024
MAX_LEDGER = 8 * 1024 * 1024
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")


class RecoveryError(Exception):
    pass


def validate_names(job, filename, node, container):
    if not UUID.fullmatch(job):
        raise RecoveryError("Job must be a lower-case UUID.")
    if (not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", node)
            or node in {"__proto__", "prototype", "constructor"}
            or not re.fullmatch(r"node-[A-Za-z0-9_.-]+_\d+_?\.mp4", filename)
            or not filename.startswith(f"node-{node.replace(':', '-')}_")):
        raise RecoveryError("Filename must be the saved MP4 for the supplied node ID.")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", container):
        raise RecoveryError("Invalid container name.")


def directory_fd(absolute):
    """Walk every directory component without following any symlinks."""
    path = PurePosixPath(absolute)
    if not path.is_absolute() or ".." in path.parts:
        raise RecoveryError("Output directory must be an absolute path without '..'.")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open("/", flags)
    try:
        for component in path.parts[1:]:
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextlib.contextmanager
def owned_file(output_directory, job, filename):
    with contextlib.ExitStack() as stack:
        root = directory_fd(output_directory)
        stack.callback(os.close, root)
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        namespace = os.open("ai-intermediary", flags, dir_fd=root)
        stack.callback(os.close, namespace)
        ledger_fd = os.open(".broker-owned-jobs.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=namespace)
        ledger = stack.enter_context(os.fdopen(ledger_fd, "rb"))
        info = os.fstat(ledger_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_LEDGER:
            raise RecoveryError("Invalid ownership ledger; nothing was changed.")
        saved = json.loads(ledger.read(MAX_LEDGER + 1))
        if (not isinstance(saved, dict) or saved.get("schema_version") != 1
                or not isinstance(saved.get("prompt_ids"), list)
                or len(saved["prompt_ids"]) > 100000 or job not in saved["prompt_ids"]):
            raise RecoveryError("Job is not in the bridge ownership ledger. Do not edit the ledger.")
        job_fd = os.open(job, flags, dir_fd=namespace)
        stack.callback(os.close, job_fd)
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=job_fd)
        file = stack.enter_context(os.fdopen(fd, "rb"))
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= MAX_FILE:
            raise RecoveryError("MP4 must be a regular, nonempty file of at most 512 MiB.")
        yield file


def fingerprint(file):
    info = os.fstat(file.fileno())
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def validate_video(file, runner=subprocess.run):
    fd = file.fileno()
    source = f"/proc/self/fd/{fd}"
    info = os.fstat(fd)
    # When sudo was needed to read the private folder, decode as its owner.
    identity = {"user": info.st_uid, "group": info.st_gid, "extra_groups": []} if os.geteuid() == 0 else {}
    probe = runner(["ffprobe", "-v", "error", "-f", "mov", "-select_streams", "v:0", "-show_entries",
                    "stream=width,height:format=duration", "-of", "json", source],
                   pass_fds=(fd,), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, **identity)
    if probe.returncode or len(probe.stdout) > 65536:
        raise RecoveryError("ffprobe could not read the MP4. Original preserved.")
    info = json.loads(probe.stdout)
    stream = (info.get("streams") or [{}])[0]
    duration = float(info.get("format", {}).get("duration", 0))
    if (not math.isfinite(duration) or not 0 < duration <= 3600
            or not 0 < stream.get("width", 0) <= 16384 or not 0 < stream.get("height", 0) <= 16384):
        raise RecoveryError("MP4 has no usable video stream/duration. Original preserved.")
    # Software decode only, two CPU threads, bounded duration and no output file.
    decode = runner(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-hwaccel", "none", "-threads", "2",
                     "-f", "mov", "-i", source, "-map", "0:v:0", "-f", "null", "-"], pass_fds=(fd,),
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300, **identity)
    if decode.returncode:
        raise RecoveryError("Video decode failed. Original preserved; no import attempted.")
    return {"width": stream["width"], "height": stream["height"], "duration_seconds": duration}


NODE_CLIENT = r"""
const [mode, job, filename, node, size, digest] = process.argv.slice(1);
try {
  const token = process.env.ADMIN_TOKEN;
  if (!token) throw new Error('ADMIN_TOKEN is not configured');
  const base = 'http://127.0.0.1:11434/_intermediary/v1/';
  const headers = { Authorization: `Bearer ${token}` };
  async function read(path) {
    const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Preflight HTTP ${response.status}`);
    return response.json();
  }
  if (mode === 'check') {
    const status = await read('status');
    const record = await read(`media/jobs/${job}`);
    if (!status.maintenance?.paused || record.state !== 'uncertain')
      throw new Error('Pause inference in the dashboard; the job must still be uncertain');
    console.log('Preflight passed; no GPU work will be submitted.');
  } else {
    const query = new URLSearchParams({ filename, node_id: node });
    const response = await fetch(`${base}media/jobs/${job}/recover-output?${query}`, {
      method: 'POST', duplex: 'half', body: process.stdin, signal: AbortSignal.timeout(120000),
      headers: { ...headers, 'Content-Type': 'video/mp4', 'Content-Length': size,
        'X-Output-SHA256': digest, 'X-Confirm-Output-Validated': 'true' }
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`Import HTTP ${response.status}: ${body.code || 'check pause, output and request size limits'}`);
    if (!body.recovered) throw new Error('Import was not confirmed');
    console.log('Output imported. Refresh ComfyUI and open Assets → Generated.');
    console.log('Original preserved. GPU recovery is STILL REQUIRED; inference has not been resumed.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
"""


def client(container, mode, job, filename, node, file=None, digest="", runner=subprocess.run):
    size = str(os.fstat(file.fileno()).st_size) if file else "0"
    command = ["docker", "exec", "-i", container, "node", "--input-type=module", "-e", NODE_CLIENT,
               mode, job, filename, node, size, digest]
    result = runner(command, stdin=file if file else subprocess.DEVNULL, timeout=150)
    if result.returncode:
        raise RecoveryError("Intermediary did not confirm this step. Original preserved; do not clear the GPU lock.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job_id")
    parser.add_argument("filename")
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--container", default="ai-intermediary")
    parser.add_argument("--output-directory", default="/opt/ComfyUI/output")
    args = parser.parse_args()
    try:
        validate_names(args.job_id, args.filename, args.node_id, args.container)
        client(args.container, "check", args.job_id, args.filename, args.node_id)
        with owned_file(args.output_directory, args.job_id, args.filename) as file:
            before = fingerprint(file)
            details = validate_video(file)
            file.seek(0)
            digest = hashlib.file_digest(file, "sha256").hexdigest()
            if fingerprint(file) != before:
                raise RecoveryError("MP4 changed during validation. Wait for all writing to finish.")
            print("Video decoded successfully:", json.dumps(details), flush=True)
            file.seek(0)
            client(args.container, "import", args.job_id, args.filename, args.node_id, file, digest)
    except (RecoveryError, OSError, ValueError, TypeError, subprocess.TimeoutExpired) as error:
        print(f"STOP: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Download and hash-check the exact public sources used by bridge tests."""

import argparse
import hashlib
from pathlib import Path
import urllib.request

from apply_bridge import HASHES, SOURCE_REF


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    args.destination.mkdir(parents=True, exist_ok=True)
    for index, (path, expected) in enumerate(HASHES.items()):
        url = f"https://raw.githubusercontent.com/blakeblackshear/frigate/{SOURCE_REF}/{path}"
        with urllib.request.urlopen(url, timeout=30) as response:
            content = response.read()
        if hashlib.sha256(content).hexdigest() != expected:
            raise SystemExit(f"Source verification failed: {path}")
        (args.destination / f"{index}.py").write_bytes(content)
    print(f"Verified {len(HASHES)} upstream sources at {SOURCE_REF}.")


if __name__ == "__main__":
    main()

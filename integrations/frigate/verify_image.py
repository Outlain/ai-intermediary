"""Check installed image sources and imports without running Frigate or inference."""

import hashlib
import importlib
import os
from pathlib import Path

from apply_bridge import HASHES, transform


def main():
    root = Path("/opt/frigate")
    fixtures = Path(os.environ["FRIGATE_BRIDGE_SOURCE_FIXTURES"])
    for index, (relative, expected) in enumerate(HASHES.items()):
        original = (fixtures / f"{index}.py").read_bytes()
        if hashlib.sha256(original).hexdigest() != expected:
            raise RuntimeError(f"Invalid upstream fixture: {relative}")
        installed = (root / relative).read_text()
        if installed != transform(relative, original.decode()):
            raise RuntimeError(f"Installed patch differs from tested patch: {relative}")
        compile(installed, relative, "exec")
    if (root / "frigate/intermediary_bridge.py").read_bytes() != Path(__file__).with_name("bridge.py").read_bytes():
        raise RuntimeError("Installed bridge differs from tested bridge")

    # Use the image's actual dependencies. Import checks catch missing enum
    # members, native names, and annotation dependencies that AST stubs cannot.
    for module in (
        "frigate.api.event", "frigate.api.review", "frigate.embeddings",
        "frigate.embeddings.maintainer", "frigate.comms.embeddings_updater",
        "frigate.data_processing.post.object_descriptions",
        "frigate.data_processing.post.review_descriptions", "frigate.genai.plugins.ollama",
    ):
        importlib.import_module(module)
    from frigate.api.review import router
    paths = {route.path: route for route in router.routes}
    for path in ("/intermediary/capabilities", "/review/{review_id}/regenerate_description"):
        if path not in paths or not paths[path].dependencies:
            raise RuntimeError(f"Missing protected bridge route: {path}")
    print("Installed patch, actual Frigate imports, and protected routes verified. No inference was run.")


if __name__ == "__main__":
    main()

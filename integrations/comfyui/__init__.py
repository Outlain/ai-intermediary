"""Install this directory as ComfyUI/custom_nodes/ai_intermediary_bridge."""

import folder_paths
import nodes
from aiohttp import web
from comfy.cli_args import args
import comfy.model_management
from server import PromptServer

from .bridge import install

GUARD = install(
    PromptServer.instance,
    nodes.NODE_CLASS_MAPPINGS,
    folder_paths.get_output_directory(),
    web=web,
    disable_api_nodes=getattr(args, "disable_api_nodes", False),
    memory_manager=comfy.model_management,
)

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

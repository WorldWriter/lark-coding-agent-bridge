#!/usr/bin/env python3
"""Portable, local-only entry point for the existing AgentCore product tools."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

TOOLS = (
    "query_products", "find_products_by_entity", "get_product_kb_status",
    "browse_product_tree", "search_product_knowledge", "grep_product_docs",
    "read_product_doc",
)


def load_config(path):
    config = json.loads(path.read_text(encoding="utf-8"))
    if config.get("schemaVersion") != 1:
        raise ValueError("unsupported config schemaVersion")
    for key in ("python", "agentcore", "snapshot"):
        value = Path(config[key]).expanduser()
        if not value.is_absolute() or not value.exists():
            raise ValueError(f"configured {key} must be an existing absolute path")
        # Preserve a virtualenv interpreter's symlink; resolving it loses the venv.
        config[key] = str(value)
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", config.get("tenant", "")):
        raise ValueError("invalid tenant")
    module = Path(config["agentcore"]) / "src/nexus/agent/tools/product_rag_cli.py"
    if not module.is_file():
        raise ValueError("AgentCore checkout has no product_rag_cli.py")
    snapshot = Path(config["snapshot"])
    stamp = json.loads((snapshot / "snapshot.json").read_text(encoding="utf-8"))
    if stamp.get("status") not in {"complete", "completed", "ok", "partial"}:
        raise ValueError("snapshot is incomplete or has an unsupported status")
    if not (snapshot / "product-lake" / config["tenant"] / "documents/index.sqlite").is_file():
        raise ValueError("document index is missing for configured tenant")
    return config


def execute(config, tool, params):
    if tool not in TOOLS or not isinstance(params, dict):
        raise ValueError("expected a supported tool and a JSON object")
    env = dict(os.environ)
    env.update(
        PYTHONPATH=str(Path(config["agentcore"]) / "src"),
        PYTHONDONTWRITEBYTECODE="1",
        PRODUCT_LAKE_S3_PREFIX="product-lake/",
        PRODUCT_LAKE_LOCAL_DIR=config["snapshot"],
        PRODUCT_LAKE_TENANT=config["tenant"],
        PRODUCT_LAKE_FALLBACK_TENANT="",
        NEXUS_TOOL_AUDIT_ENABLED="0", NEXUS_TOOL_CACHE_ENABLED="0",
    )
    result = subprocess.run(
        [config["python"], "-m", "nexus.agent.tools.product_rag_cli",
         "--snapshot", config["snapshot"], "--tenant", config["tenant"],
         tool, "--args", json.dumps(params, ensure_ascii=False)],
        # Avoid loading an unrelated workspace or AgentCore .env file.
        cwd=Path(__file__).resolve().parent, env=env,
        capture_output=True, text=True, timeout=60,
    )
    try:
        payload = json.loads(result.stdout)
    except ValueError:
        # Do not echo arbitrary startup stderr (which can include environment values).
        raise ValueError(
            f"product tool failed (exit {result.returncode}); check tool parameters "
            "in references/tools.md and the configured Python dependencies"
        ) from None
    if not isinstance(payload, dict):
        raise ValueError("product tool returned a non-object response")
    if payload.get("mode") not in {None, "offline_snapshot"}:
        raise ValueError("refusing a non-local product response")
    return payload, result.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tool", choices=TOOLS)
    parser.add_argument("--args", default="{}", help="JSON object; see references/tools.md")
    args = parser.parse_args()
    try:
        config = load_config(Path(__file__).resolve().parents[1] / "config.local.json")
        payload, code = execute(config, args.tool, json.loads(args.args))
    except (OSError, KeyError, ValueError, subprocess.TimeoutExpired) as exc:
        payload, code = {"status": "unavailable", "reason": str(exc)}, 2
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())

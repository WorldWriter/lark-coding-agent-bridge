#!/usr/bin/env python3
"""Install the product-rag skill into one Codex workspace after a local preflight."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--agentcore", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--tenant", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    workspace = args.workspace.expanduser().resolve(strict=True)
    source = Path(__file__).resolve().parents[1] / "skills/product-rag"
    destination = workspace / ".agents/skills/product-rag"
    # Existing skills may contain user edits. Installation is deliberately additive.
    if destination.exists() or destination.is_symlink():
        parser.error("product-rag already exists; review it before replacing or updating")
    config = {
        "schemaVersion": 1,
        "python": os.path.abspath(args.python.expanduser()),
        "agentcore": str(args.agentcore.expanduser().resolve(strict=True)),
        "snapshot": str(args.snapshot.expanduser().resolve(strict=True)),
        "tenant": args.tenant,
    }
    spec = importlib.util.spec_from_file_location("product_rag", source / "scripts/product_rag.py")
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    # Validate and query before placing a discoverable skill in the workspace.
    with tempfile.TemporaryDirectory(prefix="product-rag-install-") as temp:
        config_file = Path(temp) / "config.local.json"
        config_file.write_text(json.dumps(config), encoding="utf-8")
        checked = runner.load_config(config_file)
        status, code = runner.execute(checked, "get_product_kb_status", {})
        if code or status.get("status") != "ok" or status.get("mode") != "offline_snapshot":
            parser.error("local RAG preflight failed; skill was not installed")
        if status.get("tenant") != args.tenant:
            parser.error("RAG tenant mismatch; skill was not installed")
        # Stage the complete skill, then rename it into discovery scope.
        destination.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix=".product-rag-", dir=destination.parent))
        try:
            shutil.copytree(source, stage, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("config.local.json", "__pycache__"))
            (stage / "config.local.json").write_text(
                json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            stage.rename(destination)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    print(json.dumps({"installed": str(destination), "mode": status["mode"],
                      "tenant": status["tenant"], "asOf": status.get("version")},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()

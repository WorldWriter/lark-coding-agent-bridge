"""Exercise installation and subprocess boundaries without an LLM or network."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "skills/product-rag/scripts/product_rag.py"
spec = importlib.util.spec_from_file_location("product_rag", SOURCE)
rag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rag)


class ProductRagSkillTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rag test spaces ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.repo = self.root / "agent core"
        module = self.repo / "src/nexus/agent/tools/product_rag_cli.py"
        module.parent.mkdir(parents=True)
        module.write_text('''import json, sys, os
args = json.loads(sys.argv[sys.argv.index('--args') + 1])
print(json.dumps({'status':'ok','mode':os.getenv('RAG_TEST_MODE','offline_snapshot'),
 'tenant':'bjjg','params':args,'local':os.getenv('PRODUCT_LAKE_LOCAL_DIR'),
 'fallback':os.getenv('PRODUCT_LAKE_FALLBACK_TENANT')}))
''')
        self.snapshot = self.root / "product snapshot"
        self.index = self.snapshot / "product-lake/bjjg/documents/index.sqlite"
        self.index.parent.mkdir(parents=True)
        self.index.touch()
        (self.snapshot / "snapshot.json").write_text('{"status":"partial"}')
        self.config = {"schemaVersion": 1, "python": sys.executable,
                       "agentcore": str(self.repo), "snapshot": str(self.snapshot),
                       "tenant": "bjjg"}
        self.config_path = self.root / "config.json"
        self.config_path.write_text(json.dumps(self.config))

    def install(self, tenant="bjjg"):
        return subprocess.run(
            [sys.executable, str(ROOT / "tools/install-product-rag.py"),
             "--workspace", str(self.workspace), "--agentcore", str(self.repo),
             "--python", sys.executable, "--snapshot", str(self.snapshot),
             "--tenant", tenant], capture_output=True, text=True,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )

    def test_portable_install_and_local_query_with_spaces_and_literal_arguments(self):
        installed = self.install()
        self.assertEqual(installed.returncode, 0, installed.stderr)
        path = Path(json.loads(installed.stdout)["installed"])
        params = {"filters": {"keyword": "基金 $(not-a-command) `literal`"}}
        process = subprocess.run([sys.executable, str(path / "scripts/product_rag.py"),
                                  "query_products", "--args", json.dumps(params)],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        output = json.loads(process.stdout)
        self.assertEqual(output["params"], params)
        self.assertEqual(Path(output["local"]).resolve(), self.snapshot.resolve())
        self.assertEqual(output["fallback"], "")
        self.assertEqual((path / "config.local.json").stat().st_mode & 0o777, 0o600)

    def test_does_not_overwrite_existing_skill(self):
        self.assertEqual(self.install().returncode, 0)
        path = self.workspace / ".agents/skills/product-rag/SKILL.md"
        path.write_text("user customization")
        self.assertNotEqual(self.install().returncode, 0)
        self.assertEqual(path.read_text(), "user customization")

    def test_missing_configuration_fails_closed(self):
        result = subprocess.run([sys.executable, str(SOURCE), "get_product_kb_status"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["status"], "unavailable")

    def test_rejects_incomplete_snapshot(self):
        (self.snapshot / "snapshot.json").write_text('{"status":"building"}')
        with self.assertRaisesRegex(ValueError, "incomplete"):
            rag.load_config(self.config_path)

    def test_rejects_wrong_tenant_without_installing(self):
        other = self.snapshot / "product-lake/other/documents/index.sqlite"
        other.parent.mkdir(parents=True)
        other.touch()
        result = self.install("other")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tenant mismatch", result.stderr)
        self.assertFalse((self.workspace / ".agents/skills/product-rag").exists())

    def test_rejects_nonlocal_response(self):
        from unittest.mock import patch
        with patch.dict(os.environ, {"RAG_TEST_MODE": "s3_snapshot"}):
            with self.assertRaisesRegex(ValueError, "non-local"):
                rag.execute(rag.load_config(self.config_path), "get_product_kb_status", {})

    def test_rejects_unlisted_tool_or_nonobject_arguments(self):
        for tool, params in [("execute", {}), ("query_products", [])]:
            with self.assertRaises(ValueError):
                rag.execute(self.config, tool, params)


if __name__ == "__main__":
    unittest.main()

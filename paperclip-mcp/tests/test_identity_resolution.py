"""Danh tính của run (api key, run id, company id) chỉ đọc từ biến môi trường.

Chạy:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import base64
import inspect
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from paperclip_mcp import server  # noqa: E402

IDENTITY_ENV = ("PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID", "PAPERCLIP_COMPANY_ID")


def make_jwt(claims: dict) -> str:
    def b64(data: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")

    return f"{b64({'alg': 'none'})}.{b64(claims)}.sig"


class IdentityTestCase(unittest.TestCase):
    def setUp(self) -> None:
        env_patch = mock.patch.dict(os.environ, {}, clear=False)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        for name in IDENTITY_ENV:
            os.environ.pop(name, None)
        # Không để giá trị nạp lúc import (từ .env / shell) lọt vào test.
        for attr in ("API_KEY", "COMPANY"):
            patcher = mock.patch.object(server, attr, "")
            patcher.start()
            self.addCleanup(patcher.stop)

    def set_env(self, **values: str) -> None:
        os.environ.update(values)


class IdentityComesFromEnvironment(IdentityTestCase):
    def test_api_key_run_id_company_id_are_read_from_env(self) -> None:
        self.set_env(PAPERCLIP_API_KEY="env-key", PAPERCLIP_RUN_ID="env-run", PAPERCLIP_COMPANY_ID="env-company")
        self.assertEqual(server._api_key(), "env-key")
        self.assertEqual(server._run_id(), "env-run")
        self.assertEqual(server._get_company_id(), "env-company")

    def test_headers_use_env_identity(self) -> None:
        self.set_env(PAPERCLIP_API_KEY="env-key", PAPERCLIP_RUN_ID="env-run")
        headers = server._headers()
        self.assertEqual(headers["Authorization"], "Bearer env-key")
        self.assertEqual(headers["X-Paperclip-Run-Id"], "env-run")

    def test_upload_headers_use_env_identity(self) -> None:
        self.set_env(PAPERCLIP_API_KEY="env-key", PAPERCLIP_RUN_ID="env-run")
        headers = server._upload_headers()
        self.assertEqual(headers["Authorization"], "Bearer env-key")
        self.assertEqual(headers["X-Paperclip-Run-Id"], "env-run")
        self.assertNotIn("Content-Type", headers)

    def test_run_id_and_company_id_fall_back_to_jwt_claims(self) -> None:
        self.set_env(PAPERCLIP_API_KEY=make_jwt({"run_id": "jwt-run", "company_id": "jwt-company"}))
        self.assertEqual(server._run_id(), "jwt-run")
        self.assertEqual(server._get_company_id(), "jwt-company")

    def test_env_beats_jwt_claims(self) -> None:
        self.set_env(
            PAPERCLIP_API_KEY=make_jwt({"run_id": "jwt-run", "company_id": "jwt-company"}),
            PAPERCLIP_RUN_ID="env-run",
            PAPERCLIP_COMPANY_ID="env-company",
        )
        self.assertEqual(server._run_id(), "env-run")
        self.assertEqual(server._get_company_id(), "env-company")

    def test_blank_env_values_are_treated_as_missing(self) -> None:
        self.set_env(PAPERCLIP_API_KEY="   ", PAPERCLIP_RUN_ID="")
        self.assertEqual(server._api_key(), "")
        self.assertEqual(server._run_id(), "")

    def test_nothing_set_gives_empty_values(self) -> None:
        self.assertEqual((server._api_key(), server._run_id(), server._get_company_id()), ("", "", ""))


class ToolsDoNotExposeIdentityParameters(unittest.TestCase):
    def test_no_tool_schema_has_api_key_run_id_or_company_id(self) -> None:
        import asyncio

        exposed = {}
        for tool in asyncio.run(server.mcp.list_tools()):
            props = set((tool.parameters or {}).get("properties", {}))
            leaked = props & {"api_key", "run_id", "company_id"}
            if leaked:
                exposed[tool.name] = sorted(leaked)
        self.assertEqual(exposed, {})

    def test_helpers_take_no_identity_arguments(self) -> None:
        for fn in (server._headers, server._upload_headers, server._get_company_id):
            self.assertEqual(list(inspect.signature(fn).parameters), [], fn.__name__)


class BaseUrlUnchanged(IdentityTestCase):
    def test_api_url_wins_and_gets_api_suffix(self) -> None:
        self.set_env(PAPERCLIP_API_URL="http://127.0.0.1:3100/", PAPERCLIP_BASE_URL="http://other/api")
        self.assertEqual(server._get_base_url(), "http://127.0.0.1:3100/api")


if __name__ == "__main__":
    unittest.main()

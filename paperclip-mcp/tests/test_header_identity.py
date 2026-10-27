"""Danh tính của run lấy từ header x-paperclip-* của request HTTP (MCP chạy chung qua gateway).

Header ưu tiên hơn biến môi trường; không có header (stdio) thì hành vi giữ nguyên.

Chạy:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import httpx  # noqa: E402
from fastmcp import FastMCP  # noqa: E402

from paperclip_mcp import server  # noqa: E402

IDENTITY_ENV = ("PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_TASK_ID")


class HeaderIdentityTestCase(unittest.TestCase):
    def setUp(self) -> None:
        env_patch = mock.patch.dict(os.environ, {}, clear=False)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        for name in IDENTITY_ENV:
            os.environ.pop(name, None)
        for attr in ("API_KEY", "COMPANY"):
            patcher = mock.patch.object(server, attr, "")
            patcher.start()
            self.addCleanup(patcher.stop)

    def with_headers(self, headers: dict[str, str]) -> None:
        patcher = mock.patch.object(server, "get_http_headers", return_value=headers)
        patcher.start()
        self.addCleanup(patcher.stop)


class HeadersAreRead(HeaderIdentityTestCase):
    def test_all_identity_values_come_from_headers(self) -> None:
        self.with_headers({
            "authorization": "Bearer key-from-gateway",
            "x-paperclip-run-id": "run-1",
            "x-paperclip-issue-id": "task-1",
            "x-paperclip-company-id": "company-1",
        })
        self.assertEqual(server._api_key(), "key-from-gateway")
        self.assertEqual(server._run_id(), "run-1")
        self.assertEqual(server._task_id(), "task-1")
        self.assertEqual(server._get_company_id(), "company-1")

    def test_headers_beat_environment(self) -> None:
        os.environ.update(
            PAPERCLIP_API_KEY="env-key", PAPERCLIP_RUN_ID="env-run",
            PAPERCLIP_TASK_ID="env-task", PAPERCLIP_COMPANY_ID="env-company",
        )
        self.with_headers({
            "authorization": "Bearer header-key",
            "x-paperclip-run-id": "header-run",
            "x-paperclip-issue-id": "header-task",
            "x-paperclip-company-id": "header-company",
        })
        self.assertEqual(
            (server._api_key(), server._run_id(), server._task_id(), server._get_company_id()),
            ("header-key", "header-run", "header-task", "header-company"),
        )

    def test_missing_header_falls_back_to_environment(self) -> None:
        os.environ.update(PAPERCLIP_RUN_ID="env-run", PAPERCLIP_TASK_ID="env-task", PAPERCLIP_COMPANY_ID="env-company")
        self.with_headers({"x-paperclip-run-id": "header-run"})
        self.assertEqual(server._run_id(), "header-run")
        self.assertEqual(server._task_id(), "env-task")
        self.assertEqual(server._get_company_id(), "env-company")

    def test_bearer_prefix_is_stripped_case_insensitively(self) -> None:
        for value in ("Bearer abc", "bearer abc", "BEARER   abc"):
            with self.subTest(value=value):
                with mock.patch.object(server, "get_http_headers", return_value={"authorization": value}):
                    self.assertEqual(server._api_key(), "abc")

    def test_blank_header_is_treated_as_missing(self) -> None:
        os.environ.update(PAPERCLIP_RUN_ID="env-run")
        self.with_headers({"x-paperclip-run-id": "   ", "authorization": "Bearer "})
        self.assertEqual(server._run_id(), "env-run")
        self.assertEqual(server._api_key(), "")

    def test_outgoing_headers_use_request_identity(self) -> None:
        self.with_headers({"authorization": "Bearer header-key", "x-paperclip-run-id": "header-run"})
        headers = server._headers()
        self.assertEqual(headers["Authorization"], "Bearer header-key")
        self.assertEqual(headers["X-Paperclip-Run-Id"], "header-run")

    def test_run_id_header_wins_over_jwt_claim(self) -> None:
        from test_identity_resolution import make_jwt

        self.with_headers({
            "authorization": f"Bearer {make_jwt({'run_id': 'jwt-run'})}",
            "x-paperclip-run-id": "header-run",
        })
        self.assertEqual(server._run_id(), "header-run")


class StdioBehaviourUnchanged(HeaderIdentityTestCase):
    """Chạy stdio không có request HTTP: get_http_headers trả {} nên chỉ dùng env như trước."""

    def test_environment_only(self) -> None:
        os.environ.update(
            PAPERCLIP_API_KEY="env-key", PAPERCLIP_RUN_ID="env-run",
            PAPERCLIP_TASK_ID="env-task", PAPERCLIP_COMPANY_ID="env-company",
        )
        self.assertEqual(
            (server._api_key(), server._run_id(), server._task_id(), server._get_company_id()),
            ("env-key", "env-run", "env-task", "env-company"),
        )

    def test_nothing_set_gives_empty_values(self) -> None:
        self.assertEqual(
            (server._api_key(), server._run_id(), server._task_id(), server._get_company_id()),
            ("", "", "", ""),
        )

    def test_header_lookup_failure_is_ignored(self) -> None:
        os.environ.update(PAPERCLIP_RUN_ID="env-run")
        with mock.patch.object(server, "get_http_headers", side_effect=RuntimeError("no request")):
            self.assertEqual(server._run_id(), "env-run")


class ConcurrentRequestsDoNotMix(unittest.IsolatedAsyncioTestCase):
    """Qua HTTP thật của FastMCP: hai request chồng lên nhau, mỗi request chỉ thấy danh tính của nó."""

    async def test_two_overlapping_requests_keep_their_own_identity(self) -> None:
        probe = FastMCP("identity-probe")

        @probe.tool()
        async def whoami() -> dict[str, str]:
            await asyncio.sleep(0.05)  # giữ request mở để request kia chạy xen vào
            return {
                "run": server._run_id(),
                "task": server._task_id(),
                "company": server._get_company_id(),
                "key": server._api_key(),
            }

        async def call(client: httpx.AsyncClient, tag: str) -> dict[str, str]:
            response = await client.post(
                "/mcp",
                headers={
                    "accept": "application/json, text/event-stream",
                    "content-type": "application/json",
                    "authorization": f"Bearer key-{tag}",
                    "x-paperclip-run-id": f"run-{tag}",
                    "x-paperclip-issue-id": f"task-{tag}",
                    "x-paperclip-company-id": f"company-{tag}",
                },
                json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "whoami", "arguments": {}}},
            )
            self.assertEqual(response.status_code, 200)
            data_line = next(line for line in response.text.splitlines() if line.startswith("data:"))
            identity: dict[str, str] = json.loads(data_line[len("data:"):])["result"]["structuredContent"]
            return identity

        app = probe.http_app(path="/mcp", stateless_http=True)
        with mock.patch.dict(os.environ, {}, clear=False):
            for name in IDENTITY_ENV:
                os.environ.pop(name, None)
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                    results = await asyncio.gather(*(call(client, tag) for tag in ("A", "B", "C")))

        for tag, seen in zip(("A", "B", "C"), results):
            self.assertEqual(
                seen,
                {"run": f"run-{tag}", "task": f"task-{tag}", "company": f"company-{tag}", "key": f"key-{tag}"},
            )


if __name__ == "__main__":
    unittest.main()

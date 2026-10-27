"""Agent hay điền thêm api_key/run_id/company_id vào tool không khai báo chúng.

Trước đây FastMCP từ chối cả lời gọi ("Unexpected keyword argument"). Giờ các tham số danh
tính thừa bị bỏ qua, còn tham số lạ khác vẫn bị từ chối. api_request đã bị gỡ.

Chạy:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fastmcp import Client  # noqa: E402
from fastmcp.exceptions import ToolError  # noqa: E402

from paperclip_mcp import server  # noqa: E402


class IgnoreIdentityArgs(unittest.TestCase):
    def setUp(self) -> None:
        self.requests: list[tuple[str, dict | None]] = []

        async def fake_get(path, params=None, headers=None):
            self.requests.append((path, params))
            return [{"id": "i1"}]

        for patcher in (
            mock.patch.object(server, "_get", fake_get),
            mock.patch.dict(os.environ, {"PAPERCLIP_COMPANY_ID": "company-from-env"}, clear=False),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def call(self, tool: str, args: dict):
        async def run():
            async with Client(server.mcp) as client:
                return await client.call_tool(tool, args)

        return asyncio.run(run())

    def test_extra_api_key_on_list_issues_is_ignored(self) -> None:
        result = self.call("list_issues", {"status": "done", "limit": 5, "api_key": "$env:PAPERCLIP_API_KEY"})
        self.assertFalse(result.is_error)
        path, params = self.requests[0]
        self.assertEqual(path, "/companies/company-from-env/issues")
        self.assertEqual(params["status"], "done")

    def test_all_three_identity_args_are_ignored(self) -> None:
        result = self.call(
            "list_issues",
            {"api_key": "x", "run_id": "$env:PAPERCLIP_RUN_ID", "company_id": "$env:PAPERCLIP_COMPANY_ID"},
        )
        self.assertFalse(result.is_error)
        self.assertEqual(self.requests[0][0], "/companies/company-from-env/issues")

    def test_unknown_non_identity_args_are_still_rejected(self) -> None:
        with self.assertRaises(ToolError):
            self.call("list_issues", {"bogus": 1})
        self.assertEqual(self.requests, [])

    def test_delegate_tool_no_longer_declares_identity_args_and_tolerates_them(self) -> None:
        tool = asyncio.run(server.mcp.get_tool("delegate_contract_review"))
        self.assertNotIn("api_key", tool.parameters["properties"])
        kept = server._strip_undeclared_identity_args({"parent_issue_id": "p", "api_key": "k"}, set())
        self.assertEqual(kept, {"parent_issue_id": "p"})

    def test_a_tool_that_declares_the_arg_keeps_it(self) -> None:
        kept = server._strip_undeclared_identity_args({"api_key": "k"}, {"api_key"})
        self.assertEqual(kept, {"api_key": "k"})

    def test_strip_helper_handles_empty_and_clean_arguments(self) -> None:
        self.assertIsNone(server._strip_undeclared_identity_args(None, set()))
        clean = {"status": "todo"}
        self.assertIs(server._strip_undeclared_identity_args(clean, set()), clean)


class ApiRequestIsRemoved(unittest.TestCase):
    def test_tool_is_not_registered(self) -> None:
        names = {t.name for t in asyncio.run(server.mcp.list_tools())}
        self.assertNotIn("api_request", names)
        self.assertIn("list_issues", names)
        self.assertIn("finish_task_and_reply_telegram", names)


if __name__ == "__main__":
    unittest.main()

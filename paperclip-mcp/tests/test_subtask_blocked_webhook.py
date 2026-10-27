"""Task con báo `blocked`: webhook sang n8n mang id task gốc (task có chat_id).

Task con do agent tạo không có JSON chat_id; n8n chỉ nối JSON đó vào task gốc. n8n cần nhận id
task gốc để đưa đúng task đó vào hàng đợi chờ người dùng bổ sung.

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

from paperclip_mcp import server  # noqa: E402

ROOT_ID = "11111111-aaaa-4bbb-8ccc-dddddddddddd"
CHILD_ID = "22222222-aaaa-4bbb-8ccc-dddddddddddd"
GRANDCHILD_ID = "33333333-aaaa-4bbb-8ccc-dddddddddddd"
CONTEXT = '```json:telegram_context\n{"chat_id": 8882960938, "message_id": 53}\n```'


class FakeResponse:
    status_code = 200
    text = "ok"


class FakeAsyncClient:
    posted: list[dict] = []

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self) -> "FakeAsyncClient":
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def post(self, url: str, json: dict | None = None, **kwargs) -> FakeResponse:
        FakeAsyncClient.posted.append(json or {})
        return FakeResponse()


class SubtaskBlockedWebhook(unittest.TestCase):
    def setUp(self) -> None:
        FakeAsyncClient.posted = []
        self.issues: dict[str, dict] = {
            ROOT_ID: {"id": ROOT_ID, "title": "root", "description": f"Yêu cầu\n\n{CONTEXT}", "metadata": None, "parentId": None},
            CHILD_ID: {"id": CHILD_ID, "title": "child", "description": "Yêu cầu: thẩm định", "metadata": None, "parentId": ROOT_ID},
            GRANDCHILD_ID: {"id": GRANDCHILD_ID, "title": "grandchild", "description": "", "metadata": None, "parentId": CHILD_ID},
        }
        self.patched: list[tuple[str, dict]] = []
        self.get_error: Exception | None = None

        async def fake_get(path, params=None, headers=None):
            if self.get_error and path.removeprefix("/issues/") == ROOT_ID:
                raise self.get_error
            if path.endswith("/attachments"):
                return []
            return self.issues[path.removeprefix("/issues/")]

        async def fake_patch(path, body, headers=None):
            self.patched.append((path, body))
            return {}

        async def fake_post(path, body=None, headers=None):
            return {}

        for patcher in (
            mock.patch.object(server, "_get", fake_get),
            mock.patch.object(server, "_patch", fake_patch),
            mock.patch.object(server, "_post", fake_post),
            mock.patch.object(server.httpx, "AsyncClient", FakeAsyncClient),
            mock.patch.object(server, "API_KEY", ""),
            mock.patch.dict(os.environ, {}, clear=False),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        for name in ("PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID", "PAPERCLIP_WAKE_PAYLOAD_JSON", "PAPERCLIP_TASK_PAYLOAD"):
            os.environ.pop(name, None)

    def run_tool(self, task_id: str, **kwargs):
        os.environ["PAPERCLIP_TASK_ID"] = task_id
        tool = server.finish_task_and_reply_telegram
        return asyncio.run(getattr(tool, "fn", tool)(**kwargs))

    def test_blocked_child_reports_root_task_to_n8n(self) -> None:
        result = self.run_tool(CHILD_ID, message="Cần thêm file", status="blocked")
        self.assertEqual(len(FakeAsyncClient.posted), 1)
        payload = FakeAsyncClient.posted[0]
        self.assertEqual(payload["task_id"], ROOT_ID)
        self.assertEqual(payload["leaf_task_id"], CHILD_ID)
        self.assertEqual(payload["chat_id"], 8882960938)
        self.assertEqual(payload["message_id"], 53)
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(result["chat_source"], "parent:description_json")
        self.assertFalse(result["telegram_skipped"])

    def test_only_the_child_is_patched_to_blocked(self) -> None:
        self.run_tool(CHILD_ID, message="Cần thêm file", status="blocked")
        self.assertEqual(self.patched, [(f"/issues/{CHILD_ID}", {"status": "blocked"})])

    def test_blocked_grandchild_walks_up_to_the_root(self) -> None:
        self.run_tool(GRANDCHILD_ID, message="Cần thêm file", status="blocked")
        payload = FakeAsyncClient.posted[0]
        self.assertEqual(payload["task_id"], ROOT_ID)
        self.assertEqual(payload["leaf_task_id"], GRANDCHILD_ID)

    def test_done_child_does_not_message_the_user(self) -> None:
        result = self.run_tool(CHILD_ID, message="Xong phần việc", status="done")
        self.assertEqual(FakeAsyncClient.posted, [])
        self.assertTrue(result["telegram_skipped"])
        self.assertEqual(result["task_status"], "done")

    def test_cancelled_child_does_not_message_the_user(self) -> None:
        result = self.run_tool(CHILD_ID, message="Hủy", status="cancelled")
        self.assertEqual(FakeAsyncClient.posted, [])
        self.assertTrue(result["telegram_skipped"])

    def test_unreadable_parent_falls_back_to_skipping_telegram(self) -> None:
        self.get_error = RuntimeError("HTTP 500")
        result = self.run_tool(CHILD_ID, message="Cần thêm file", status="blocked")
        self.assertEqual(FakeAsyncClient.posted, [])
        self.assertTrue(result["telegram_skipped"])

    def test_child_with_its_own_chat_id_keeps_its_own_task_id(self) -> None:
        self.issues[CHILD_ID]["description"] = CONTEXT
        self.run_tool(CHILD_ID, message="Cần thêm file", status="blocked")
        payload = FakeAsyncClient.posted[0]
        self.assertEqual(payload["task_id"], CHILD_ID)
        self.assertNotIn("leaf_task_id", payload)

    def test_task_without_parent_and_without_chat_id_is_skipped(self) -> None:
        self.issues[ROOT_ID]["description"] = "task tạo tay"
        result = self.run_tool(ROOT_ID, message="Cần thêm file", status="blocked")
        self.assertEqual(FakeAsyncClient.posted, [])
        self.assertTrue(result["telegram_skipped"])

    def test_parent_cycle_does_not_loop_forever(self) -> None:
        self.issues[ROOT_ID]["description"] = "không có chat"
        self.issues[ROOT_ID]["parentId"] = CHILD_ID
        result = self.run_tool(CHILD_ID, message="Cần thêm file", status="blocked")
        self.assertTrue(result["telegram_skipped"])


if __name__ == "__main__":
    unittest.main()

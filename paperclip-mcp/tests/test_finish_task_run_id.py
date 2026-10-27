"""finish_task_and_reply_telegram gửi run_id sang webhook n8n.

n8n dùng run_id làm header X-Paperclip-Run-Id khi comment/đóng task, để Paperclip tính
comment đó là của run và không tạo run bàn giao mới.

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

RUN_ID = "11111111-2222-4333-8444-555555555555"
TASK_ID = "99999999-aaaa-4bbb-8ccc-dddddddddddd"


class FakeResponse:
    status_code = 200
    text = "ok"


class FakeAsyncClient:
    """Thay httpx.AsyncClient: ghi lại payload gửi tới webhook n8n."""

    posted: list[tuple[str, dict]] = []

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self) -> "FakeAsyncClient":
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def post(self, url: str, json: dict | None = None, **kwargs) -> FakeResponse:
        FakeAsyncClient.posted.append((url, json or {}))
        return FakeResponse()


class FinishTaskRunId(unittest.TestCase):
    def setUp(self) -> None:
        FakeAsyncClient.posted = []
        self.calls: list[tuple[str, str, dict | None, dict | None]] = []

        async def fake_get(path, params=None, headers=None):
            self.calls.append(("GET", path, None, headers))
            return {"id": TASK_ID, "companyId": "c1", "title": "t", "description": "", "metadata": {"chat_id": 8882960938, "message_id": 53}}

        async def fake_patch(path, body, headers=None):
            self.calls.append(("PATCH", path, body, headers))
            return {}

        async def fake_post(path, body=None, headers=None):
            self.calls.append(("POST", path, body, headers))
            return {}

        patches = [
            mock.patch.object(server, "_get", fake_get),
            mock.patch.object(server, "_patch", fake_patch),
            mock.patch.object(server, "_post", fake_post),
            mock.patch.object(server.httpx, "AsyncClient", FakeAsyncClient),
            mock.patch.object(server, "API_KEY", ""),
            mock.patch.dict(os.environ, {}, clear=False),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        for name in ("PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID", "PAPERCLIP_TASK_ID", "PAPERCLIP_MCP_ENV_FIRST", "PAPERCLIP_WAKE_PAYLOAD_JSON"):
            os.environ.pop(name, None)

    def run_tool(self, **kwargs):
        # FastMCP bọc hàm thành FunctionTool; lấy hàm gốc để gọi trực tiếp.
        tool = server.finish_task_and_reply_telegram
        fn = getattr(tool, "fn", tool)
        return asyncio.run(fn(**kwargs))

    def test_run_id_from_environment_is_sent_to_the_webhook_and_returned(self) -> None:
        os.environ["PAPERCLIP_RUN_ID"] = RUN_ID
        os.environ["PAPERCLIP_TASK_ID"] = TASK_ID
        result = self.run_tool(message="Xong rồi", status="done")

        self.assertEqual(len(FakeAsyncClient.posted), 1)
        _url, payload = FakeAsyncClient.posted[0]
        self.assertEqual(payload["run_id"], RUN_ID)
        self.assertEqual(payload["task_id"], TASK_ID)
        self.assertEqual(payload["chat_id"], 8882960938)
        self.assertEqual(result["run_id"], RUN_ID)

    def test_existing_payload_fields_are_unchanged(self) -> None:
        os.environ["PAPERCLIP_RUN_ID"] = RUN_ID
        os.environ["PAPERCLIP_TASK_ID"] = TASK_ID
        self.run_tool(message="Xong rồi", status="done")
        _url, payload = FakeAsyncClient.posted[0]
        for key in ("chat_id", "message_id", "task_id", "status", "message", "file_path", "fileName", "downloadPath", "attachmentId"):
            self.assertIn(key, payload)

    def test_run_id_is_taken_from_the_jwt_when_the_environment_has_none(self) -> None:
        import base64
        import json

        def b64(data: dict) -> str:
            return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")

        os.environ["PAPERCLIP_API_KEY"] = f"{b64({'alg': 'none'})}.{b64({'run_id': RUN_ID})}.sig"
        os.environ["PAPERCLIP_TASK_ID"] = TASK_ID
        self.run_tool(message="Xong rồi")
        self.assertEqual(FakeAsyncClient.posted[0][1]["run_id"], RUN_ID)

    def test_comment_is_posted_with_the_run_header_so_the_run_is_satisfied(self) -> None:
        os.environ["PAPERCLIP_RUN_ID"] = RUN_ID
        os.environ["PAPERCLIP_TASK_ID"] = TASK_ID
        self.run_tool(message="Xong rồi")
        comment_calls = [c for c in self.calls if c[0] == "POST" and c[1].endswith("/comments")]
        self.assertEqual(len(comment_calls), 1)
        self.assertEqual(comment_calls[0][3].get("X-Paperclip-Run-Id"), RUN_ID)

    def test_run_id_is_empty_not_missing_when_it_cannot_be_resolved(self) -> None:
        os.environ["PAPERCLIP_TASK_ID"] = TASK_ID
        self.run_tool(message="Xong rồi")
        self.assertEqual(FakeAsyncClient.posted[0][1]["run_id"], "")


if __name__ == "__main__":
    unittest.main()

"""finish_task_and_reply_telegram trả danh sách `steps` các bước đã chạy.

stderr của MCP không đi qua ACP nên transcript không thấy log. Danh sách này nằm trong kết quả
(và trong thông báo lỗi) để người xem run biết tool đã chạy tới đâu.

Chạy:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from paperclip_mcp import server  # noqa: E402

TASK_ID = "99999999-aaaa-4bbb-8ccc-dddddddddddd"
LABELED = '```json:telegram_context\n{"chat_id": 8882960938, "message_id": 53}\n```'


class FakeResponse:
    def __init__(self, status_code: int = 200, text: str = "ok") -> None:
        self.status_code = status_code
        self.text = text


class FakeAsyncClient:
    webhook_status = 200
    posted: list[dict] = []

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self) -> "FakeAsyncClient":
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def post(self, url: str, json: dict | None = None, **kwargs) -> FakeResponse:
        FakeAsyncClient.posted.append(json or {})
        return FakeResponse(FakeAsyncClient.webhook_status, "n8n loi" if FakeAsyncClient.webhook_status >= 400 else "ok")


class FinishSteps(unittest.TestCase):
    def setUp(self) -> None:
        FakeAsyncClient.posted = []
        FakeAsyncClient.webhook_status = 200
        self.description = LABELED
        self.patch_error: Exception | None = None
        self.comment_error: Exception | None = None

        async def fake_get(path, params=None, headers=None):
            if path.endswith("/attachments"):
                return []
            return {"id": TASK_ID, "companyId": "c1", "title": "t", "description": self.description, "metadata": None}

        async def fake_patch(path, body, headers=None):
            if self.patch_error:
                raise self.patch_error
            return {}

        async def fake_post(path, body=None, headers=None):
            if self.comment_error:
                raise self.comment_error
            return {}

        async def fake_upload(file_path, issue_id):
            return {
                "id": "f7074f2c-0fdc-476c-b947-cca696c450cc",
                "originalFilename": os.path.basename(file_path),
                "downloadPath": "/api/attachments/f7074f2c/content?download=1",
            }

        for patcher in (
            mock.patch.object(server, "_get", fake_get),
            mock.patch.object(server, "_patch", fake_patch),
            mock.patch.object(server, "_post", fake_post),
            mock.patch.object(server, "_upload_file_to_issue", fake_upload),
            mock.patch.object(server.httpx, "AsyncClient", FakeAsyncClient),
            mock.patch.object(server, "API_KEY", ""),
            mock.patch.dict(os.environ, {}, clear=False),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        for name in ("PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID", "PAPERCLIP_WAKE_PAYLOAD_JSON", "PAPERCLIP_TASK_PAYLOAD"):
            os.environ.pop(name, None)
        os.environ["PAPERCLIP_TASK_ID"] = TASK_ID

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.local_file = os.path.join(tmp.name, "bao_cao.md")
        Path(self.local_file).write_text("noi dung", encoding="utf-8")
        self.missing_file = os.path.join(tmp.name, "khong_ton_tai.md")

    def run_tool(self, **kwargs):
        tool = server.finish_task_and_reply_telegram
        return asyncio.run(getattr(tool, "fn", tool)(**kwargs))

    def test_success_returns_every_main_step_in_order(self) -> None:
        result = self.run_tool(message="Xong", status="done")
        steps = result["steps"]
        self.assertIsInstance(steps, list)
        joined = "\n".join(steps)
        for expected in (
            f"[Step 1/5 SUCCESS] Xác định được Task ID: {TASK_ID}",
            "[Step 1/5 SUCCESS] Đã đọc thông tin task từ Paperclip API",
            "[Step 2/5 SUCCESS] Trích xuất thành công: chat_id=8882960938, message_id=53 (nguồn: description_json)",
            "[Step 3/5 SUCCESS] Gửi Webhook sang n8n thành công (HTTP 200)",
            "[Step 4/5 SUCCESS] Đã cập nhật trạng thái task sang 'done' trên Paperclip",
            "[Step 5/5 SUCCESS] Đã ghi comment báo cáo vào task",
        ):
            self.assertIn(expected, joined)
        order = [joined.index(x) for x in ("[Step 1/5", "[Step 2/5", "[Step 3/5", "[Step 4/5", "[Step 5/5")]
        self.assertEqual(order, sorted(order))

    def test_skipped_telegram_is_recorded(self) -> None:
        self.description = "task tạo tay"
        result = self.run_tool(message="Xong")
        joined = "\n".join(result["steps"])
        self.assertIn("[Step 2/5 SKIPPED] Không tìm thấy chat_id: bỏ qua gửi Telegram", joined)
        self.assertNotIn("Gửi Webhook sang n8n", joined)

    def test_uploaded_file_is_recorded(self) -> None:
        result = self.run_tool(message="Xong", file_path=self.local_file)
        joined = "\n".join(result["steps"])
        self.assertIn("[Step 3/5 SUCCESS] Đã tự động upload file 'bao_cao.md' lên Paperclip (attachment f7074f2c)", joined)

    def test_failed_status_and_comment_calls_are_recorded_without_failing(self) -> None:
        self.patch_error = RuntimeError("HTTP 500 khi PATCH")
        self.comment_error = RuntimeError("HTTP 500 khi comment")
        result = self.run_tool(message="Xong")
        joined = "\n".join(result["steps"])
        self.assertIn("[Step 4/5 WARNING] Không thể cập nhật trạng thái task trên Paperclip: HTTP 500 khi PATCH", joined)
        self.assertIn("[Step 5/5 WARNING] Không thể ghi comment vào task: HTTP 500 khi comment", joined)

    def test_failed_status_and_comment_calls_are_not_reported_as_success(self) -> None:
        self.patch_error = RuntimeError("HTTP 401 khi PATCH")
        self.comment_error = RuntimeError("HTTP 401 khi comment")
        with self.assertLogs(server.log, level="WARNING") as logs:
            result = self.run_tool(message="Xong")
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "partial_failure")
        self.assertFalse(result["task_status_updated"])
        self.assertFalse(result["comment_saved"])
        self.assertTrue(result["message_sent_to_telegram"])
        self.assertIn("Tin Telegram đã gửi", result["warning"])
        self.assertIn("cập nhật trạng thái task và ghi comment vào task", result["warning"])
        self.assertIn("KHÔNG gọi lại tool này", result["warning"])
        output = "\n".join(logs.output)
        self.assertIn("HOÀN TẤT CÓ LỖI", output)
        self.assertNotIn("HOÀN TẤT THÀNH CÔNG", output)

    def test_only_the_failed_part_is_named(self) -> None:
        self.comment_error = RuntimeError("HTTP 500 khi comment")
        result = self.run_tool(message="Xong")
        self.assertFalse(result["ok"])
        self.assertTrue(result["task_status_updated"])
        self.assertFalse(result["comment_saved"])
        self.assertIn("Chưa ghi comment vào task", result["warning"])
        self.assertNotIn("cập nhật trạng thái", result["warning"])

    def test_full_success_stays_ok(self) -> None:
        result = self.run_tool(message="Xong")
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "success")
        self.assertTrue(result["task_status_updated"])
        self.assertTrue(result["comment_saved"])
        self.assertNotIn("warning", result)

    def test_file_error_message_lists_the_steps_that_ran(self) -> None:
        with self.assertRaises(server.ToolError) as ctx:
            self.run_tool(message="Xong", file_path=self.missing_file)
        text = str(ctx.exception)
        self.assertIn("Các bước đã chạy:", text)
        self.assertIn(f"- [Step 1/5 SUCCESS] Xác định được Task ID: {TASK_ID}", text)
        self.assertIn("không có trên máy chạy MCP", text)

    def test_webhook_error_message_lists_the_steps_that_ran(self) -> None:
        FakeAsyncClient.webhook_status = 500
        with self.assertRaises(server.ToolError) as ctx:
            self.run_tool(message="Xong")
        text = str(ctx.exception)
        self.assertIn("HTTP 500", text)
        self.assertIn("Các bước đã chạy:", text)
        self.assertIn("chat_id=8882960938", text)

    def test_steps_never_contain_the_message_body(self) -> None:
        secret_marker = "NOI_DUNG_RIENG_TU_XYZ"
        result = self.run_tool(message=f"Báo cáo {secret_marker}")
        self.assertNotIn(secret_marker, "\n".join(result["steps"]))

    def test_existing_result_fields_are_unchanged(self) -> None:
        result = self.run_tool(message="Xong")
        for key in (
            "ok", "status", "chat_id", "message_id", "chat_source", "task_id", "run_id",
            "task_status", "message_sent_to_telegram", "telegram_skipped", "message_preview",
        ):
            self.assertIn(key, result)


if __name__ == "__main__":
    unittest.main()

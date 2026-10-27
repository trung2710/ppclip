"""Chọn đúng file đính kèm khi gửi kết quả về Telegram.

- File có trên máy: upload đúng một lần, không tra danh sách attachment.
- File không có trên máy / upload lỗi: tìm attachment theo originalFilename, không bao giờ
  lấy attachment cuối cùng của task (có thể là file người dùng gửi).
- Không tìm được file: báo lỗi trước khi gọi webhook.

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


def attachment(att_id: str, name: str, created: str, key: str = "originalFilename") -> dict:
    return {
        "id": att_id,
        key: name,
        "createdAt": created,
        "downloadPath": f"/api/attachments/{att_id}/content?download=1",
    }


class PickAttachmentByName(unittest.TestCase):
    def test_matches_original_filename(self) -> None:
        items = [attachment("a1", "yeu_cau.docx", "2026-10-15T01:00:00Z"), attachment("a2", "bao_cao.md", "2026-10-15T02:00:00Z")]
        self.assertEqual(server._pick_attachment_by_name(items, "bao_cao.md")["id"], "a2")

    def test_never_falls_back_to_the_last_attachment(self) -> None:
        items = [attachment("a1", "bao_cao.md", "2026-10-15T01:00:00Z"), attachment("a2", "file_nguoi_dung.pdf", "2026-10-15T02:00:00Z")]
        self.assertIsNone(server._pick_attachment_by_name(items, "khac.md"))

    def test_case_insensitive_and_uses_base_name_of_a_path(self) -> None:
        items = [attachment("a1", "Bao_Cao.MD", "2026-10-15T01:00:00Z")]
        self.assertEqual(server._pick_attachment_by_name(items, "C:\\data\\reports\\bao_cao.md")["id"], "a1")
        self.assertEqual(server._pick_attachment_by_name(items, "/tmp/bao_cao.md")["id"], "a1")

    def test_accepts_the_legacy_filename_key(self) -> None:
        items = [attachment("a1", "bao_cao.md", "2026-10-15T01:00:00Z", key="filename")]
        self.assertEqual(server._pick_attachment_by_name(items, "bao_cao.md")["id"], "a1")

    def test_same_name_picks_the_newest(self) -> None:
        items = [
            attachment("old", "bao_cao.md", "2026-10-15T01:00:00Z"),
            attachment("new", "bao_cao.md", "2026-10-15T03:00:00Z"),
            attachment("mid", "bao_cao.md", "2026-10-15T02:00:00Z"),
        ]
        self.assertEqual(server._pick_attachment_by_name(items, "bao_cao.md")["id"], "new")

    def test_same_name_without_timestamps_picks_the_later_in_the_list(self) -> None:
        items = [{"id": "first", "originalFilename": "a.md"}, {"id": "second", "originalFilename": "a.md"}]
        self.assertEqual(server._pick_attachment_by_name(items, "a.md")["id"], "second")

    def test_bad_inputs_return_none(self) -> None:
        self.assertIsNone(server._pick_attachment_by_name(None, "a.md"))
        self.assertIsNone(server._pick_attachment_by_name([], "a.md"))
        self.assertIsNone(server._pick_attachment_by_name([attachment("a1", "a.md", "x")], ""))
        self.assertIsNone(server._pick_attachment_by_name(["not-a-dict", None], "a.md"))


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


class FinishToolAttachments(unittest.TestCase):
    def setUp(self) -> None:
        FakeAsyncClient.posted = []
        self.attachments: list[dict] = []
        self.attachment_lookups = 0
        self.uploads: list[str] = []
        self.upload_error: Exception | None = None
        self.writes: list[tuple[str, str]] = []

        async def fake_get(path, params=None, headers=None):
            if path.endswith("/attachments"):
                self.attachment_lookups += 1
                return list(self.attachments)
            return {"id": TASK_ID, "companyId": "c1", "title": "t", "description": LABELED, "metadata": None}

        async def fake_upload(file_path, issue_id):
            if self.upload_error is not None:
                raise self.upload_error
            self.uploads.append(file_path)
            return {
                "id": "uploaded-1",
                "originalFilename": os.path.basename(file_path),
                "downloadPath": "/api/attachments/uploaded-1/content?download=1",
            }

        async def fake_patch(path, body, headers=None):
            self.writes.append(("PATCH", path))
            return {}

        async def fake_post(path, body=None, headers=None):
            self.writes.append(("POST", path))
            return {}

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

    def test_local_file_is_uploaded_once_without_listing_attachments(self) -> None:
        self.run_tool(message="Xong", file_path=self.local_file)
        self.assertEqual(self.uploads, [self.local_file])
        self.assertEqual(self.attachment_lookups, 0)
        payload = FakeAsyncClient.posted[0]
        self.assertEqual(payload["attachmentId"], "uploaded-1")
        self.assertEqual(payload["downloadPath"], "/api/attachments/uploaded-1/content?download=1")
        self.assertEqual(payload["fileName"], "bao_cao.md")

    def test_missing_local_file_uses_the_attachment_with_the_same_name(self) -> None:
        self.attachments = [
            attachment("mine", "khong_ton_tai.md", "2026-10-15T01:00:00Z"),
            attachment("user-file", "tai_lieu_khach_gui.pdf", "2026-10-15T09:00:00Z"),
        ]
        self.run_tool(message="Xong", file_path=self.missing_file)
        self.assertEqual(self.uploads, [])
        payload = FakeAsyncClient.posted[0]
        self.assertEqual(payload["attachmentId"], "mine")
        self.assertEqual(payload["fileName"], "khong_ton_tai.md")

    def test_upload_failure_falls_back_to_the_attachment_with_the_same_name(self) -> None:
        self.upload_error = RuntimeError("HTTP 500")
        self.attachments = [attachment("already", "bao_cao.md", "2026-10-15T01:00:00Z")]
        self.run_tool(message="Xong", file_path=self.local_file)
        self.assertEqual(FakeAsyncClient.posted[0]["attachmentId"], "already")

    def test_no_matching_attachment_fails_before_the_webhook(self) -> None:
        self.attachments = [attachment("user-file", "tai_lieu_khach_gui.pdf", "2026-10-15T09:00:00Z")]
        with self.assertRaises(server.ToolError) as ctx:
            self.run_tool(message="Xong", file_path=self.missing_file)
        self.assertIn("tai_lieu_khach_gui.pdf", str(ctx.exception))
        self.assertEqual(FakeAsyncClient.posted, [])
        self.assertEqual(self.writes, [])

    def test_upload_failure_with_nothing_to_fall_back_on_fails_before_the_webhook(self) -> None:
        self.upload_error = RuntimeError("mat ket noi")
        with self.assertRaises(server.ToolError) as ctx:
            self.run_tool(message="Xong", file_path=self.local_file)
        self.assertIn("mat ket noi", str(ctx.exception))
        self.assertEqual(FakeAsyncClient.posted, [])

    def test_without_file_path_there_is_no_attachment_lookup(self) -> None:
        self.attachments = [attachment("user-file", "tai_lieu_khach_gui.pdf", "2026-10-15T09:00:00Z")]
        self.run_tool(message="Chỉ trả lời văn bản")
        self.assertEqual(self.attachment_lookups, 0)
        payload = FakeAsyncClient.posted[0]
        self.assertEqual((payload["downloadPath"], payload["attachmentId"], payload["fileName"]), ("", "", ""))

    def test_payload_keys_are_unchanged_for_n8n(self) -> None:
        self.run_tool(message="Xong", file_path=self.local_file)
        for key in ("chat_id", "message_id", "task_id", "run_id", "status", "message", "file_path", "fileName", "downloadPath", "attachmentId"):
            self.assertIn(key, FakeAsyncClient.posted[0])


if __name__ == "__main__":
    unittest.main()

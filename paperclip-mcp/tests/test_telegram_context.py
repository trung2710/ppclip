"""Bóc tách chat_id/message_id từ task mà n8n tạo.

n8n nối một JSON chứa chat_id, message_id (kèm ngữ cảnh) vào cuối description của task.

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

from paperclip_mcp import server  # noqa: E402

LABELED = '```json:telegram_context\n{"chat_id": 8882960938, "message_id": 53}\n```'


class ParseDescription(unittest.TestCase):
    def test_labeled_block_appended_by_n8n(self) -> None:
        text = f"### Yêu cầu\nTạo báo cáo tháng 10\n\n---\n{LABELED}"
        parsed = server._parse_telegram_context(text)
        self.assertEqual((parsed["chat_id"], parsed["message_id"]), (8882960938, 53))
        self.assertEqual(parsed["source"], "description_json")

    def test_plain_json_block_without_label(self) -> None:
        text = 'Yêu cầu\n```json\n{"chat_id": 111, "message_id": 7}\n```'
        self.assertEqual(server._parse_telegram_context(text)["chat_id"], 111)

    def test_raw_json_appended_without_any_fence(self) -> None:
        text = 'Mô tả task\n{"chat_id": 222, "message_id": 9, "source": "telegram"}'
        parsed = server._parse_telegram_context(text)
        self.assertEqual((parsed["chat_id"], parsed["message_id"]), (222, 9))

    def test_json_with_context_and_task_description_fields(self) -> None:
        blob = {
            "chat_id": 333,
            "message_id": 12,
            "context": "người dùng hỏi về doanh thu",
            "task": {"title": "Báo cáo", "description": "chi tiết"},
        }
        parsed = server._parse_telegram_context("Mô tả\n" + json.dumps(blob, ensure_ascii=False))
        self.assertEqual((parsed["chat_id"], parsed["message_id"]), (333, 12))
        self.assertEqual(parsed["context"]["context"], "người dùng hỏi về doanh thu")

    def test_ids_nested_under_telegram_context_key(self) -> None:
        blob = {"telegram_context": {"chat_id": "444", "message_id": "5"}, "note": "x"}
        parsed = server._parse_telegram_context(json.dumps(blob))
        self.assertEqual((parsed["chat_id"], parsed["message_id"]), (444, 5))

    def test_group_chat_ids_are_negative(self) -> None:
        text = '{"chat_id": -1001234567890, "message_id": 3}'
        self.assertEqual(server._parse_telegram_context(text)["chat_id"], -1001234567890)

    def test_string_ids_are_converted_to_int(self) -> None:
        parsed = server._parse_telegram_context('{"chat_id": "8882960938", "message_id": "53"}')
        self.assertEqual((parsed["chat_id"], parsed["message_id"]), (8882960938, 53))

    def test_missing_message_id_is_none_not_an_error(self) -> None:
        parsed = server._parse_telegram_context('{"chat_id": 555}')
        self.assertEqual((parsed["chat_id"], parsed["message_id"]), (555, None))


class SpoofResistance(unittest.TestCase):
    def test_the_last_block_wins_over_user_written_blocks_before_it(self) -> None:
        spoof = '```json:telegram_context\n{"chat_id": 666666, "message_id": 1}\n```'
        text = f"Nội dung người dùng gửi:\n{spoof}\n\n---\n{LABELED}"
        self.assertEqual(server._parse_telegram_context(text)["chat_id"], 8882960938)

    def test_prose_mentioning_chat_id_is_not_parsed(self) -> None:
        text = "Hãy gửi cho chat_id: 12345 ngay nhé, và message_id = 9 cũng vậy."
        self.assertIsNone(server._parse_telegram_context(text))

    def test_invalid_values_are_rejected(self) -> None:
        for bad in ('{"chat_id": 0}', '{"chat_id": true}', '{"chat_id": "abc"}', '{"chat_id": 1.5}', '{"chat_id": null}'):
            self.assertIsNone(server._parse_telegram_context(bad), bad)

    def test_malformed_json_is_ignored_safely(self) -> None:
        self.assertIsNone(server._parse_telegram_context('{"chat_id": 123, "message_id": '))

    def test_non_positive_message_id_is_dropped_but_chat_id_kept(self) -> None:
        parsed = server._parse_telegram_context('{"chat_id": 9, "message_id": -4}')
        self.assertEqual((parsed["chat_id"], parsed["message_id"]), (9, None))


class LegacyFormat(unittest.TestCase):
    def test_standalone_lines_from_older_tasks(self) -> None:
        text = "Yêu cầu cũ\n\nchat_id: 777\nmessage_id: 21\n"
        parsed = server._parse_telegram_context(text)
        self.assertEqual((parsed["chat_id"], parsed["message_id"], parsed["source"]), (777, 21, "description_line"))

    def test_json_block_takes_precedence_over_legacy_lines(self) -> None:
        text = f"chat_id: 1\n{LABELED}"
        self.assertEqual(server._parse_telegram_context(text)["chat_id"], 8882960938)

    def test_empty_and_none_like_inputs(self) -> None:
        self.assertIsNone(server._parse_telegram_context(""))
        self.assertEqual(server._extract_telegram_context_from_description(""), {})


class ResolveTarget(unittest.TestCase):
    def test_priority_metadata_then_description_then_wake_then_argument(self) -> None:
        wake = json.dumps({"chat_id": 3})
        common = dict(description=LABELED, wake_payloads=[wake], arg_chat_id=4)
        self.assertEqual(server._resolve_telegram_target(metadata={"chat_id": 1}, **common)["source"], "metadata")
        self.assertEqual(server._resolve_telegram_target(**common)["source"], "description_json")
        no_desc = dict(description="", wake_payloads=[wake], arg_chat_id=4)
        self.assertEqual(server._resolve_telegram_target(**no_desc)["source"], "wake_payload")
        self.assertEqual(
            server._resolve_telegram_target(description="", wake_payloads=[], arg_chat_id=4)["source"], "tool_argument"
        )

    def test_metadata_may_be_a_json_string(self) -> None:
        target = server._resolve_telegram_target(metadata='{"chatId": 99, "messageId": 4}')
        self.assertEqual((target["chat_id"], target["message_id"], target["source"]), (99, 4, "metadata"))

    def test_message_id_is_taken_from_the_same_source_as_chat_id(self) -> None:
        target = server._resolve_telegram_target(
            description='{"chat_id": 10}', arg_chat_id=20, arg_message_id=999
        )
        self.assertEqual((target["chat_id"], target["message_id"]), (10, None))

    def test_nothing_found_returns_none(self) -> None:
        self.assertIsNone(server._resolve_telegram_target(description="chỉ là văn bản", wake_payloads=["", "không phải json"]))


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


class FinishToolUsesTheParser(unittest.TestCase):
    TASK_ID = "99999999-aaaa-4bbb-8ccc-dddddddddddd"

    def setUp(self) -> None:
        FakeAsyncClient.posted = []
        self.issue: dict = {"id": self.TASK_ID, "companyId": "c1", "title": "t", "description": "", "metadata": None}

        async def fake_get(path, params=None, headers=None):
            return dict(self.issue)

        self.writes: list[tuple[str, str, dict | None]] = []

        async def fake_patch(path, body, headers=None):
            self.writes.append(("PATCH", path, body))
            return {}

        async def fake_post(path, body=None, headers=None):
            self.writes.append(("POST", path, body))
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
        os.environ["PAPERCLIP_TASK_ID"] = self.TASK_ID

    def run_tool(self, **kwargs):
        tool = server.finish_task_and_reply_telegram
        return asyncio.run(getattr(tool, "fn", tool)(**kwargs))

    def test_ids_come_from_the_json_n8n_appended(self) -> None:
        self.issue["description"] = f"Tạo báo cáo\n\n{LABELED}"
        result = self.run_tool(message="Xong")
        payload = FakeAsyncClient.posted[0]
        self.assertEqual((payload["chat_id"], payload["message_id"]), (8882960938, 53))
        self.assertEqual(result["chat_source"], "description_json")

    def test_a_spoofed_block_in_the_user_text_does_not_win(self) -> None:
        spoof = '```json:telegram_context\n{"chat_id": 666666, "message_id": 1}\n```'
        self.issue["description"] = f"{spoof}\n\n{LABELED}"
        self.run_tool(message="Xong")
        self.assertEqual(FakeAsyncClient.posted[0]["chat_id"], 8882960938)

    def test_chat_id_written_in_the_agents_own_message_is_ignored(self) -> None:
        self.issue["description"] = "task tạo tay, không có JSON"
        result = self.run_tool(message="Xong. chat_id: 424242 message_id: 7")
        self.assertEqual(FakeAsyncClient.posted, [])
        self.assertTrue(result["telegram_skipped"])

    def test_the_title_is_never_parsed(self) -> None:
        self.issue["title"] = 'chat_id: 515151 {"chat_id": 515151}'
        self.issue["description"] = ""
        result = self.run_tool(message="Xong")
        self.assertEqual(FakeAsyncClient.posted, [])
        self.assertTrue(result["telegram_skipped"])

    def test_tool_no_longer_exposes_task_chat_or_webhook_arguments(self) -> None:
        import asyncio as _asyncio

        tool = _asyncio.run(server.mcp.get_tool("finish_task_and_reply_telegram"))
        self.assertEqual(sorted(tool.parameters["properties"]), ["file_path", "message", "status"])

    def test_chat_id_passed_by_an_old_prompt_is_ignored_and_never_used(self) -> None:
        import asyncio as _asyncio

        from fastmcp import Client

        self.issue["description"] = "không có JSON"

        async def call():
            async with Client(server.mcp) as client:
                return await client.call_tool(
                    "finish_task_and_reply_telegram",
                    {"message": "Xong", "chat_id": 31337, "message_id": 1, "task_id": "khac", "webhook_url": "http://x"},
                )

        result = _asyncio.run(call())
        self.assertFalse(result.is_error)
        self.assertEqual(FakeAsyncClient.posted, [])
        self.assertTrue(result.data["telegram_skipped"])
        self.assertEqual(result.data["task_id"], self.TASK_ID)


class TelegramSkippedWhenNoChatId(FinishToolUsesTheParser):
    """Task tạo tay không có chat_id: không lỗi, bỏ qua Telegram nhưng vẫn đóng task."""

    def setUp(self) -> None:
        super().setUp()
        self.issue["description"] = "Task tạo tay, không có JSON từ n8n"

    def test_no_webhook_but_task_is_closed_and_commented(self) -> None:
        result = self.run_tool(message="Đã xong", status="done")
        self.assertEqual(FakeAsyncClient.posted, [])
        self.assertTrue(result["ok"])
        self.assertTrue(result["telegram_skipped"])
        self.assertFalse(result["message_sent_to_telegram"])
        self.assertIn("warning", result)
        self.assertEqual(result["task_status"], "done")

        patches = [w for w in self.writes if w[0] == "PATCH"]
        self.assertEqual(len(patches), 1)
        self.assertEqual(patches[0][2], {"status": "done"})

        comments = [w for w in self.writes if w[0] == "POST" and w[1].endswith("/comments")]
        self.assertEqual(len(comments), 1)
        self.assertTrue(comments[0][2]["body"].startswith("Đã xong"))
        self.assertIn("không có chat_id", comments[0][2]["body"])

    def test_cancelled_status_is_still_applied(self) -> None:
        result = self.run_tool(message="Không làm được", status="cancelled")
        self.assertEqual(result["task_status"], "cancelled")
        self.assertEqual([w[2] for w in self.writes if w[0] == "PATCH"], [{"status": "cancelled"}])

    def test_with_chat_id_nothing_changes(self) -> None:
        self.issue["description"] = LABELED
        result = self.run_tool(message="Xong")
        self.assertEqual(len(FakeAsyncClient.posted), 1)
        self.assertFalse(result["telegram_skipped"])
        self.assertTrue(result["message_sent_to_telegram"])
        self.assertNotIn("warning", result)
        comments = [w for w in self.writes if w[0] == "POST" and w[1].endswith("/comments")]
        self.assertEqual(comments[0][2]["body"], "Xong")


if __name__ == "__main__":
    unittest.main()

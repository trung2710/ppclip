"""StepLog: ghi các bước của MCP tool vào stderr và vào danh sách `steps` của kết quả.

Chạy:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import logging
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fastmcp.exceptions import ToolError  # noqa: E402

from paperclip_mcp.step_log import StepLog, format_steps  # noqa: E402


class StepLogTest(unittest.TestCase):
    def setUp(self) -> None:
        self.logger = logging.getLogger("test-step-log")
        self.logger.setLevel(logging.DEBUG)

    def make(self) -> StepLog:
        return StepLog("demo_tool", total=3, logger=self.logger)

    def test_prefix_is_generated_for_each_kind(self) -> None:
        steps = self.make()
        with self.assertLogs(self.logger, level="DEBUG"):
            steps.start("Tham số nhận vào: x=1")
            steps.ok(1, "Đọc task OK")
            steps.warn(2, "Upload thất bại")
            steps.skip(2, "Bỏ qua Telegram")
            steps.info(3, "Ghi chú hiển thị", ui=True)
        self.assertEqual(
            steps.items,
            [
                "[Bắt đầu] Tham số nhận vào: x=1",
                "[Step 1/3 SUCCESS] Đọc task OK",
                "[Step 2/3 WARNING] Upload thất bại",
                "[Step 2/3 SKIPPED] Bỏ qua Telegram",
                "[Step 3/3] Ghi chú hiển thị",
            ],
        )

    def test_info_is_stderr_only_by_default(self) -> None:
        steps = self.make()
        with self.assertLogs(self.logger, level="INFO") as captured:
            steps.info(1, "Đang gọi API")
        self.assertEqual(steps.items, [])
        self.assertIn("[demo_tool] [Step 1/3] Đang gọi API", captured.output[0])

    def test_detail_goes_to_stderr_but_not_to_the_ui(self) -> None:
        steps = self.make()
        with self.assertLogs(self.logger, level="INFO") as captured:
            steps.ok(2, "Upload OK", detail="downloadPath=/api/attachments/abc/content")
        self.assertEqual(steps.items, ["[Step 2/3 SUCCESS] Upload OK"])
        self.assertIn("downloadPath=/api/attachments/abc/content", captured.output[0])

    def test_log_levels(self) -> None:
        steps = self.make()
        with self.assertLogs(self.logger, level="DEBUG") as captured:
            steps.ok(1, "a")
            steps.warn(1, "b")
            steps.skip(1, "c")
        self.assertEqual([r.levelname for r in captured.records], ["INFO", "WARNING", "WARNING"])

    def test_fail_raises_tool_error_with_the_steps_that_ran(self) -> None:
        steps = self.make()
        with self.assertLogs(self.logger, level="DEBUG") as captured:
            steps.ok(1, "Đọc task OK")
            with self.assertRaises(ToolError) as ctx:
                steps.fail(2, "Webhook lỗi HTTP 500")
        text = str(ctx.exception)
        self.assertTrue(text.startswith("[LỖI MCP] [demo_tool] [Step 2/3 FAILED] Webhook lỗi HTTP 500"))
        self.assertIn("Các bước đã chạy:\n- [Step 1/3 SUCCESS] Đọc task OK", text)
        self.assertEqual(captured.records[-1].levelname, "ERROR")

    def test_fail_without_previous_steps_has_no_steps_section(self) -> None:
        with self.assertLogs(self.logger, level="ERROR"):
            with self.assertRaises(ToolError) as ctx:
                self.make().fail(1, "Thiếu task_id")
        self.assertNotIn("Các bước đã chạy", str(ctx.exception))

    def test_result_adds_a_copy_of_the_steps(self) -> None:
        steps = self.make()
        with self.assertLogs(self.logger, level="INFO"):
            steps.ok(1, "a")
        result = steps.result({"ok": True})
        self.assertEqual(result, {"ok": True, "steps": ["[Step 1/3 SUCCESS] a"]})
        with self.assertLogs(self.logger, level="INFO"):
            steps.ok(2, "b")
        self.assertEqual(result["steps"], ["[Step 1/3 SUCCESS] a"])

    def test_format_steps(self) -> None:
        self.assertEqual(format_steps([]), "")
        self.assertEqual(format_steps(["a", "b"]), "\nCác bước đã chạy:\n- a\n- b")


if __name__ == "__main__":
    unittest.main()

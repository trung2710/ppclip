"""Ghi các bước của một MCP tool vào hai nơi cùng lúc.

1. stderr của MCP server (như `log.info` trước đây), để đọc log của tiến trình.
2. Danh sách `steps` trả trong kết quả của tool (và đính vào thông báo lỗi), vì stderr không đi qua
   ACP nên transcript của run không thấy được; chỉ kết quả tool mới hiện trên giao diện.

Dùng trong tool:

    steps = StepLog("finish_task", total=5, logger=log)
    steps.start(f"Tham số nhận vào: status='{status}'")
    steps.info(1, "Đang gọi Paperclip API")              # chỉ ghi stderr
    steps.ok(1, f"Xác định được Task ID: {task_id}")       # stderr + giao diện
    steps.warn(3, f"Upload thất bại: {err}", detail="...") # detail chỉ ghi stderr
    steps.fail(3, "Không có file để gửi")                  # raise ToolError kèm "Các bước đã chạy"
    return steps.result({"ok": True})                      # thêm "steps" vào kết quả

Không đưa secret hay nội dung dài (ví dụ `message` của agent) vào `text`; thông tin nội bộ như URL
webhook hay đường dẫn tải thì để ở `detail` (chỉ ghi stderr).
"""

from __future__ import annotations

import logging
from typing import Any, NoReturn

from fastmcp.exceptions import ToolError


def format_steps(steps: list[str]) -> str:
    """Danh sách các bước đã chạy, để đính vào thông báo lỗi của tool."""
    if not steps:
        return ""
    return "\nCác bước đã chạy:\n" + "\n".join(f"- {item}" for item in steps)


class StepLog:
    def __init__(self, tool: str, total: int, logger: logging.Logger) -> None:
        self.tool = tool
        self.total = total
        self.log = logger
        self.items: list[str] = []

    # ── ghi một dòng ───────────────────────────────────────────────────────────

    def _prefix(self, n: int, label: str) -> str:
        return f"[Step {n}/{self.total} {label}]" if label else f"[Step {n}/{self.total}]"

    def _record(self, level: int, line: str, *, detail: str = "", ui: bool = True) -> None:
        self.log.log(level, "[%s] %s", self.tool, f"{line} | {detail}" if detail else line)
        if ui:
            self.items.append(line)

    # ── các loại bước ──────────────────────────────────────────────────────────

    def start(self, text: str) -> None:
        """Dòng mở đầu, ví dụ tham số nhận vào."""
        self._record(logging.INFO, f"[Bắt đầu] {text}")

    def info(self, n: int, text: str, *, detail: str = "", ui: bool = False) -> None:
        """Bước trung gian ("Đang làm..."). Mặc định chỉ ghi stderr để danh sách không bị gấp đôi."""
        self._record(logging.INFO, f"{self._prefix(n, '')} {text}", detail=detail, ui=ui)

    def ok(self, n: int, text: str, *, detail: str = "") -> None:
        self._record(logging.INFO, f"{self._prefix(n, 'SUCCESS')} {text}", detail=detail)

    def warn(self, n: int, text: str, *, detail: str = "") -> None:
        self._record(logging.WARNING, f"{self._prefix(n, 'WARNING')} {text}", detail=detail)

    def skip(self, n: int, text: str, *, detail: str = "") -> None:
        self._record(logging.WARNING, f"{self._prefix(n, 'SKIPPED')} {text}", detail=detail)

    def fail(self, n: int, text: str) -> NoReturn:
        """Lỗi cứng: ghi stderr rồi raise ToolError kèm danh sách các bước đã chạy."""
        line = f"[{self.tool}] {self._prefix(n, 'FAILED')} {text}"
        self.log.error("[LỖI MCP] %s", line)
        raise ToolError(f"[LỖI MCP] {line}{format_steps(self.items)}")

    # ── kết quả ────────────────────────────────────────────────────────────────

    def result(self, data: dict[str, Any]) -> dict[str, Any]:
        """Kết quả của tool kèm danh sách `steps`."""
        return {**data, "steps": list(self.items)}

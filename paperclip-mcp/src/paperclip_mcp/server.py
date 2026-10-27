#!/usr/bin/env python3
"""
paperclip-mcp — MCP server for the Paperclip AI agent orchestration platform.

Exposes Paperclip's REST API as MCP tools so that AI assistants can manage
issues, agents, goals, approvals, costs, and activity via natural language.

Documentation: https://github.com/paperclipai/paperclip
MCP spec:      https://modelcontextprotocol.io

Configuration (environment variables):
    PAPERCLIP_API_KEY      Agent API key or Bearer JWT token.
                           Can be set statically or injected per run ($env:PAPERCLIP_API_KEY).
    PAPERCLIP_COMPANY_ID   Company UUID shown in the Paperclip UI URL
                           when viewing your company: /companies/{uuid}.
    PAPERCLIP_BASE_URL     Optional. Default: http://localhost:3100/api
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, NoReturn, cast

import httpx
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.middleware import Middleware, MiddlewareContext

try:
    from paperclip_mcp.step_log import StepLog
except ImportError:  # chạy thẳng `python server.py` (cấu hình MCP của Codex): thư mục file nằm trong sys.path
    from step_log import StepLog  # type: ignore[import-not-found, no-redef]

# ── Configuration ──────────────────────────────────────────────────────────────

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv is optional; env vars can be set by the shell

BASE_URL_DEFAULT: str = "http://localhost:3100/api"
API_KEY: str  = os.environ.get("PAPERCLIP_API_KEY", "")
COMPANY: str  = os.environ.get("PAPERCLIP_COMPANY_ID", "")


def _decode_jwt_claims(token: str) -> dict[str, Any]:
    """Extract claims from a JWT token payload without signature verification."""
    if not token or token.count(".") != 2:
        return {}
    try:
        import base64
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * ((4 - len(payload_b64) % 4) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64))
        if isinstance(claims, dict):
            return cast(dict[str, Any], claims)
        return {}
    except Exception:
        return {}


# ── Danh tính của run: đọc từ biến môi trường của tiến trình MCP ───────────────
# Codex chuyển PAPERCLIP_API_KEY / RUN_ID / COMPANY_ID / TASK_ID của đúng run qua `env_vars`
# trong config.toml, nên tool không nhận các giá trị này qua tham số.


def _api_key() -> str:
    return os.environ.get("PAPERCLIP_API_KEY", "").strip() or API_KEY.strip()


def _run_id() -> str:
    """Run id từ PAPERCLIP_RUN_ID, nếu thiếu thì giải mã từ JWT của API key."""
    from_env = os.environ.get("PAPERCLIP_RUN_ID", "").strip()
    if from_env:
        return from_env
    claims = _decode_jwt_claims(_api_key())
    return str(claims.get("run_id") or claims.get("runId") or "").strip()


def _get_base_url() -> str:
    """Dynamically get the Paperclip API base URL from runtime environment.
    Prioritizes PAPERCLIP_API_URL injected per run by Paperclip over static PAPERCLIP_BASE_URL.
    """
    raw = os.environ.get("PAPERCLIP_API_URL") or os.environ.get("PAPERCLIP_BASE_URL") or BASE_URL_DEFAULT
    url = raw.strip().rstrip("/")
    if not url.endswith("/api"):
        url = f"{url}/api"
    return url


def _get_company_id() -> str:
    """Company id từ PAPERCLIP_COMPANY_ID, nếu thiếu thì giải mã từ JWT của API key."""
    from_env = os.environ.get("PAPERCLIP_COMPANY_ID", "").strip()
    if from_env:
        return from_env
    extracted = _decode_jwt_claims(_api_key()).get("company_id")
    if extracted:
        return str(extracted).strip()
    return COMPANY.strip()


# ── Logging ────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] paperclip-mcp %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    stream=sys.stderr,
)
log = logging.getLogger(__name__)

# ── HTTP client ────────────────────────────────────────────────────────────────

_HTTP_TIMEOUT = 30  # seconds


def _headers() -> dict[str, str]:
    """Build per-request headers dynamically from the running Agent's credentials.
    Reads $env:PAPERCLIP_API_KEY and $env:PAPERCLIP_RUN_ID at runtime, or extracts
    run_id directly from the Agent's run JWT claims so mutations are credited to
    the exact Agent running the current turn.
    """
    key = _api_key()
    effective_run_id = _run_id()

    headers: dict[str, str] = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if effective_run_id:
        headers["X-Paperclip-Run-Id"] = effective_run_id

    return headers


def _err(message: str, status: int | None = None) -> NoReturn:
    """Log structured error to stderr and raise ToolError so FastMCP signals isError to the client.

    Luôn raise nên khai báo NoReturn: sau `if x is None: _err(...)` trình kiểm tra kiểu biết x không còn None.
    """
    status_str = f" [HTTP {status}]" if status is not None else ""
    formatted_msg = f"[LỖI MCP{status_str}] {message}"
    log.error("%s", formatted_msg)
    raise ToolError(formatted_msg)


async def _request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    url = f"{_get_base_url()}{path}"
    req_headers = headers if headers is not None else _headers()

    auth_val = req_headers.get("Authorization", "").strip()
    if auth_val == "Bearer" or not auth_val:
        return _err(
            "Missing PAPERCLIP_API_KEY: active agent has no runtime token. "
            "Ensure the run was started by Paperclip (PAPERCLIP_API_KEY is injected per run).",
            status=401,
        )
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            r = await client.request(
                method,
                url,
                headers=req_headers,
                params=params,
                json=body,
            )
            # 409 Conflict on checkout: another agent owns the issue — do not retry.
            if r.status_code == 409:
                return _err(
                    "Conflict (409): resource is already checked out or owned by another agent. "
                    "Do not retry this request.",
                    status=409,
                )
            r.raise_for_status()
            # 204 No Content
            if r.status_code == 204 or not r.content:
                return {"ok": True}
            return r.json()
    except httpx.HTTPStatusError as exc:
        log.error("HTTP %d error on %s %s: %s", exc.response.status_code, method, url, exc.response.text)
        return _err(
            f"HTTP {exc.response.status_code} from Paperclip API: {exc.response.text[:400]}",
            status=exc.response.status_code,
        )
    except httpx.RequestError as exc:
        return _err(
            f"Could not reach Paperclip at {_get_base_url()}. "
            f"Is the server running? Error: {exc}"
        )


async def _get(
    path: str,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    return await _request("GET", path, params=params, headers=headers)


async def _post(
    path: str,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    return await _request("POST", path, body=body, headers=headers)


async def _put(
    path: str,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    return await _request("PUT", path, body=body, headers=headers)


async def _patch(
    path: str,
    body: dict[str, Any],
    headers: dict[str, str] | None = None,
) -> Any:
    return await _request("PATCH", path, body=body, headers=headers)


async def _delete(
    path: str,
    headers: dict[str, str] | None = None,
) -> Any:
    return await _request("DELETE", path, headers=headers)


# ── Startup validation ─────────────────────────────────────────────────────────

def _validate_config() -> None:
    """Log configuration status without hard-crashing if API key is injected dynamically per run."""
    company = _get_company_id()
    if not company:
        log.warning("PAPERCLIP_COMPANY_ID is not set in environment. Tools targeting company endpoints will require this.")
    key = os.environ.get("PAPERCLIP_API_KEY") or API_KEY
    if not key:
        log.info("PAPERCLIP_API_KEY not set statically; will dynamically inherit from agent run environment.")


@asynccontextmanager
async def _lifespan(_server: FastMCP):  # type: ignore[type-arg]
    _validate_config()
    log.info("paperclip-mcp started — base: %s | company: %s", _get_base_url(), _get_company_id())
    yield
    log.info("paperclip-mcp stopped.")


# ── MCP Server ─────────────────────────────────────────────────────────────────

mcp = FastMCP(
    name="paperclip",
    instructions=(
        "Manage a Paperclip AI agent orchestration platform. "
        "Use these tools to create and track issues (tasks), inspect agents, "
        "set goals, handle approvals, and monitor costs. "
        "All operations target a single Paperclip company configured via "
        "PAPERCLIP_COMPANY_ID."
    ),
    lifespan=_lifespan,
)


# ── Tham số danh tính thừa ─────────────────────────────────────────────────────
# Danh tính của run (api key, run id, company id) luôn lấy từ môi trường của tiến trình
# MCP. Agent hay điền thêm các tham số này vào tool không khai báo chúng, và FastMCP sẽ
# từ chối cả lời gọi (Unexpected keyword argument). Bỏ chúng đi thay vì làm hỏng lời gọi;
# tool nào tự khai báo tham số đó vẫn nhận giá trị như cũ, còn tham số lạ khác vẫn bị từ chối.

_IGNORED_IDENTITY_ARGS = frozenset({
    "api_key", "run_id", "company_id",
    # Đã bỏ khỏi finish_task_and_reply_telegram (hệ thống tự xác định); prompt cũ có thể vẫn truyền.
    "task_id", "chat_id", "message_id", "webhook_url", "task_description",
})


def _strip_undeclared_identity_args(
    arguments: dict[str, Any] | None, declared: set[str]
) -> dict[str, Any] | None:
    if not arguments:
        return arguments
    drop = [k for k in arguments if k in _IGNORED_IDENTITY_ARGS and k not in declared]
    if not drop:
        return arguments
    log.info("Bỏ qua tham số danh tính thừa do agent truyền: %s", ", ".join(sorted(drop)))
    return {k: v for k, v in arguments.items() if k not in drop}


class _IgnoreIdentityArgs(Middleware):
    async def on_call_tool(self, context: MiddlewareContext, call_next):  # type: ignore[no-untyped-def]
        message = context.message
        if message.arguments and any(k in _IGNORED_IDENTITY_ARGS for k in message.arguments):
            tool = await mcp.get_tool(message.name)
            declared = set(((getattr(tool, "parameters", None) or {}).get("properties") or {}))
            message.arguments = _strip_undeclared_identity_args(message.arguments, declared)
        return await call_next(context)


mcp.add_middleware(_IgnoreIdentityArgs())


# ── ISSUES ─────────────────────────────────────────────────────────────────────

@mcp.tool()
async def list_issues(
    status: str = "todo,in_progress",
    assignee_agent_id: str = "",
    project_id: str = "",
    label: str = "",
    limit: int = 50,
) -> Any:
    """List issues (tasks) in the active company.

    Args:
        status: Comma-separated issue statuses to include.
                Allowed values: todo, in_progress, blocked, done, cancelled.
                Default: "todo,in_progress"
        assignee_agent_id: UUID of the agent to filter by. Leave empty for all agents.
        project_id: UUID of the project to filter by. Leave empty for all projects.
        label: Label name to filter by. Leave empty to skip label filtering.
        limit: Maximum number of results to return (1–200). Default: 50.
    """
    company_id = _get_company_id()
    if not company_id:
        return _err("PAPERCLIP_COMPANY_ID is not configured.")
    params: dict[str, Any] = {"status": status, "limit": max(1, min(limit, 200))}
    if assignee_agent_id:
        params["assigneeAgentId"] = assignee_agent_id
    if project_id:
        params["projectId"] = project_id
    if label:
        params["label"] = label
    return await _get(f"/companies/{company_id}/issues", params)


@mcp.tool()
async def get_issue(issue_id: str) -> Any:
    """Get the full details of a single issue.

    Args:
        issue_id: Issue UUID or human-readable identifier (e.g. "CY-42").
    """
    if not issue_id.strip():
        return _err("issue_id is required.")
    return await _get(f"/issues/{issue_id.strip()}")


@mcp.tool()
async def create_issue(
    title: str,
    description: str = "",
    assignee_agent_id: str = "",
    project_id: str = "",
    parent_issue_id: str = "",
    priority: str = "medium",
) -> Any:
    """Create a new issue (task) and optionally assign it to an agent.

    Use this to delegate work to agents, create subtasks, or track action items.

    Args:
        title: Short, imperative task title (e.g. "Search cheese suppliers in Barcelona").
        description: Full instructions or context for the agent (Markdown supported).
        assignee_agent_id: UUID of the agent to assign. Leave empty to leave unassigned.
        project_id: UUID of the project this issue belongs to. Leave empty for no project.
        parent_issue_id: UUID of the parent issue when creating a subtask. Leave empty for top-level.
        priority: Task priority — urgent, high, medium, or low. Default: medium.
    """
    company_id = _get_company_id()
    if not company_id:
        return _err("PAPERCLIP_COMPANY_ID is not configured.")
    body: dict[str, Any] = {"title": title, "priority": priority}
    if description:
        body["description"] = description
    if assignee_agent_id:
        body["assigneeAgentId"] = assignee_agent_id
    if project_id:
        body["projectId"] = project_id
    if parent_issue_id:
        body["parentIssueId"] = parent_issue_id
    return await _post(f"/companies/{company_id}/issues", body)


@mcp.tool()
async def update_issue(
    issue_id: str,
    title: str = "",
    description: str = "",
    status: str = "",
    assignee_agent_id: str = "",
    priority: str = "",
    comment: str = "",
    blocked_by_issue_ids: list[str] | None = None,
) -> Any:
    """Update an existing issue. Only fields you provide are changed.

    Args:
        issue_id: Issue UUID or identifier (e.g. "CY-42").
        title: New title. Leave empty to keep current value.
        description: New description (Markdown). Leave empty to keep current.
        status: New status — todo, in_progress, blocked, done, or cancelled.
                Leave empty to keep current.
        assignee_agent_id: New agent UUID. Leave empty to keep current assignee.
        priority: New priority — urgent, high, medium, or low. Leave empty to keep current.
        comment: Optional markdown comment to post along with this update (e.g. when closing or blocking an issue).
        blocked_by_issue_ids: Optional list of issue UUIDs that block this issue when setting status to blocked.
    """
    if not issue_id.strip():
        return _err("issue_id is required.")
    body: dict[str, Any] = {}
    if title:
        body["title"] = title
    if description:
        body["description"] = description
    if status:
        if status not in {"backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"}:
            return _err(f"Invalid status '{status}'. Allowed: backlog, todo, in_progress, in_review, blocked, done, cancelled.")
        body["status"] = status
    if assignee_agent_id:
        body["assigneeAgentId"] = assignee_agent_id
    if priority:
        if priority not in {"critical", "urgent", "high", "medium", "low"}:
            return _err(f"Invalid priority '{priority}'. Allowed: critical, urgent, high, medium, low.")
        body["priority"] = priority
    if comment:
        body["comment"] = comment
    if blocked_by_issue_ids is not None:
        body["blockedByIssueIds"] = blocked_by_issue_ids
    if not body:
        return _err("No fields to update. Provide at least one field to update.")
    req_headers = _headers()
    return await _patch(f"/issues/{issue_id.strip()}", body, headers=req_headers)


@mcp.tool()
async def checkout_issue(issue_id: str) -> Any:
    """Atomically assign an issue to the current agent and mark it in_progress.

    A 409 Conflict response means another agent already owns this issue — do NOT retry.
    Use release_issue to undo a checkout.

    Args:
        issue_id: Issue UUID or identifier to check out.
    """
    if not issue_id.strip():
        return _err("issue_id is required.")
    return await _post(f"/issues/{issue_id.strip()}/checkout")


@mcp.tool()
async def release_issue(issue_id: str) -> Any:
    """Release an issue: unassign it and revert it to its previous state.

    This is the inverse of checkout_issue. Use when an agent cannot complete a task
    and it should be returned to the queue.

    Args:
        issue_id: Issue UUID or identifier to release.
    """
    if not issue_id.strip():
        return _err("issue_id is required.")
    return await _post(f"/issues/{issue_id.strip()}/release")


@mcp.tool()
async def comment_on_issue(
    issue_id: str,
    body: str,
    reopen: bool = False,
) -> Any:
    """Add a comment to an issue (supports Markdown).

    Args:
        issue_id: Issue UUID or identifier.
        body: Comment text. Markdown is supported.
        reopen: Set to true to reopen the issue when posting this comment.
                Only effective if the issue is currently closed.
    """
    if not issue_id.strip():
        return _err("issue_id is required.")
    if not body.strip():
        return _err("Comment body cannot be empty.")
    payload: dict[str, Any] = {"body": body}
    if reopen:
        payload["reopen"] = True
    req_headers = _headers()
    return await _post(f"/issues/{issue_id.strip()}/comments", payload, headers=req_headers)


def _upload_headers() -> dict[str, str]:
    """Tạo headers chuyên dụng cho upload multipart (không bao gồm Content-Type: application/json)."""
    key = _api_key()
    effective_run_id = _run_id()

    headers: dict[str, str] = {}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    if effective_run_id:
        headers["X-Paperclip-Run-Id"] = effective_run_id

    return headers


async def _upload_file_to_issue(
    file_path: str,
    issue_id: str,
) -> dict[str, Any]:
    """Upload một file từ ổ đĩa máy tính lên làm attachment của Paperclip Issue."""
    clean_path = file_path.strip().strip('"').strip("'")
    if not clean_path:
        raise ValueError("file_path không được để trống.")

    # Tìm đường dẫn file thực tế
    resolved_path = os.path.abspath(clean_path)
    if not os.path.isfile(resolved_path):
        alt_path = os.path.abspath(os.path.join(os.getcwd(), clean_path))
        if os.path.isfile(alt_path):
            resolved_path = alt_path
        else:
            raise FileNotFoundError(f"Không tìm thấy file tại '{clean_path}' (Đã tìm tại '{resolved_path}').")

    effective_company_id = ""
    real_issue_id = issue_id.strip()

    # Truy vấn issue để lấy UUID chuẩn và companyId nếu chưa có
    req_headers = _headers()
    try:
        issue_data = await _get(f"/issues/{real_issue_id}", headers=req_headers)
        if isinstance(issue_data, dict):
            real_issue_id = issue_data.get("id") or real_issue_id
            if not effective_company_id:
                effective_company_id = str(issue_data.get("companyId") or "").strip()
    except Exception as e:
        log.warning("[upload_attachment] Không thể tra cứu trước thông tin issue: %s", e)

    if not effective_company_id:
        effective_company_id = _get_company_id()

    filename = os.path.basename(resolved_path)
    guessed_type, _ = mimetypes.guess_type(resolved_path)
    content_type = guessed_type or "application/octet-stream"

    url = f"{_get_base_url()}/companies/{effective_company_id}/issues/{real_issue_id}/attachments"
    upload_h = _upload_headers()

    log.info("[upload_attachment] Đang upload file '%s' (%s) lên %s...", filename, content_type, url)

    with open(resolved_path, "rb") as f:
        file_bytes = f.read()

    files = {"file": (filename, file_bytes, content_type)}

    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(url, headers=upload_h, files=files)
        if res.status_code >= 400:
            log.error("[upload_attachment] HTTP %d: %s", res.status_code, res.text)
            raise RuntimeError(f"HTTP {res.status_code} khi upload attachment: {res.text[:400]}")
        data = cast(dict[str, Any], res.json())
        log.info("[upload_attachment] Upload thành công: id=%s | downloadPath=%s", data.get("id"), data.get("downloadPath"))
        return data


@mcp.tool()
async def upload_issue_attachment(
    file_path: str,
    issue_id: str = "",
) -> Any:
    """Tải (upload) một file từ ổ đĩa máy tính lên làm tệp đính kèm (attachment) của Paperclip Issue.
    Hỗ trợ mọi định dạng file: .md, .pdf, .docx, .png, .jpg, .xlsx, .csv, .zip...
    Tự động xác định mimetype và gửi multipart/form-data trực tiếp lên Paperclip API mà không cần chạy curl hay PowerShell.

    Args:
        file_path: Đường dẫn tuyệt đối hoặc tương đối đến file trên máy (ví dụ: 'bc10_6_2026.md' hoặc 'C:/data/report.pdf').
        issue_id: Tùy chọn: UUID hoặc mã Task (ví dụ 'KHT-58'). Mặc định lấy từ $env:PAPERCLIP_TASK_ID.
    """
    effective_issue_id = issue_id.strip() or os.environ.get("PAPERCLIP_TASK_ID", "").strip()
    if not effective_issue_id:
        return _err("Thiếu issue_id: Không tìm thấy issue_id trong tham số và không có biến môi trường PAPERCLIP_TASK_ID.")

    try:
        result = await _upload_file_to_issue(
            file_path=file_path,
            issue_id=effective_issue_id,
        )
        return {
            "ok": True,
            "message": f"Đã upload thành công file '{os.path.basename(file_path)}' vào Issue {effective_issue_id}",
            "attachment": result,
        }
    except Exception as e:
        return _err(f"Lỗi khi upload file đính kèm: {e}")


@mcp.tool()
async def upsert_issue_document(
    issue_id: str,
    body: str,
    title: str = "",
    key: str = "summary",
    format: str = "markdown",
    base_revision_id: str = "",
    change_summary: str = "",
) -> Any:
    """Create or update a document attached to an issue (e.g. 'plan', 'summary', 'specs').
    Supports native UTF-8 encoding (no font corruption / mojibake for Vietnamese text).

    Args:
        issue_id: Issue UUID or identifier (e.g. 'KHT-41' or UUID).
        body: The document markdown or text content.
        title: Optional document title.
        key: The unique document key on the issue (e.g. 'summary', 'plan'). Default: 'summary'.
        format: Format of the document ('markdown'). Default: 'markdown'.
        base_revision_id: Optional base revision UUID when updating an existing document.
        change_summary: Optional summary of what changed in this revision.
    """
    if not issue_id.strip():
        return _err("issue_id is required.")
    if not body.strip():
        return _err("Document body cannot be empty.")
    doc_key = key.strip().lower() if key.strip() else "summary"
    payload: dict[str, Any] = {
        "body": body,
        "format": format if format in {"markdown"} else "markdown",
    }
    if title.strip():
        payload["title"] = title.strip()
    if base_revision_id.strip():
        payload["baseRevisionId"] = base_revision_id.strip()
    if change_summary.strip():
        payload["changeSummary"] = change_summary.strip()

    req_headers = _headers()
    return await _put(f"/issues/{issue_id.strip()}/documents/{doc_key}", payload, headers=req_headers)


@mcp.tool()
async def get_issue_document(
    issue_id: str,
    key: str = "summary",
) -> Any:
    """Get an issue document by key (e.g. 'summary', 'plan').

    Args:
        issue_id: Issue UUID or identifier.
        key: Document key (e.g. 'summary', 'plan'). Default: 'summary'.
    """
    if not issue_id.strip():
        return _err("issue_id is required.")
    doc_key = key.strip().lower() if key.strip() else "summary"
    req_headers = _headers()
    return await _get(f"/issues/{issue_id.strip()}/documents/{doc_key}", headers=req_headers)


@mcp.tool()
async def list_issue_documents(
    issue_id: str,
    include_system: bool = False,
) -> Any:
    """List all documents attached to an issue.

    Args:
        issue_id: Issue UUID or identifier.
        include_system: Whether to include system documents. Default: False.
    """
    if not issue_id.strip():
        return _err("issue_id is required.")
    params = {"includeSystem": "true"} if include_system else None
    req_headers = _headers()
    return await _get(f"/issues/{issue_id.strip()}/documents", params=params, headers=req_headers)


@mcp.tool()
async def delete_issue(issue_id: str) -> Any:
    """Permanently delete an issue. This action cannot be undone.

    Args:
        issue_id: Issue UUID or identifier to delete.
    """
    if not issue_id.strip():
        return _err("issue_id is required.")
    return await _delete(f"/issues/{issue_id.strip()}")


# ── AGENTS ─────────────────────────────────────────────────────────────────────

@mcp.tool()
async def list_agents(
) -> Any:
    """List all agents in the active company with their name, role, status, and config.

    Args:
    """
    log.info("[list_agents] [Step 1/2] Đang xác định Company ID...")
    effective_company_id = _get_company_id()
    if not effective_company_id:
        _err(
            "Chưa cấu hình PAPERCLIP_COMPANY_ID trong môi trường hoặc file .env của paperclip-mcp. "
            "Hướng dẫn khắc phục: Điền PAPERCLIP_COMPANY_ID=<uuid-công-ty> vào file paperclip-mcp/.env."
        )
    log.info("[list_agents] [Step 1/2 SUCCESS] Company ID = %s", effective_company_id)

    req_headers = _headers()
    log.info("[list_agents] [Step 2/2] Đang gọi GET /companies/%s/agents...", effective_company_id)
    res = await _get(f"/companies/{effective_company_id}/agents", headers=req_headers)
    count = len(res) if isinstance(res, list) else (len(res.get("items", [])) if isinstance(res, dict) else "N/A")
    log.info("[list_agents] [Step 2/2 SUCCESS] Lấy thành công danh sách agents (Tổng cộng: %s agent)", count)
    return res


@mcp.tool()
async def get_agent(agent_id: str = "me") -> Any:
    """Get details for a specific agent, or the currently authenticated agent.

    Args:
        agent_id: Agent UUID, or the literal string "me" to get the current agent identity.
                  Default: "me"
    """
    if not agent_id.strip():
        return _err("agent_id is required.")
    path = "/agents/me" if agent_id.strip().lower() == "me" else f"/agents/{agent_id.strip()}"
    return await _get(path)


@mcp.tool()
async def invoke_agent_heartbeat(agent_id: str) -> Any:
    """Manually trigger an immediate heartbeat (work cycle) for an agent.

    Use this to wake an idle agent, force it to pick up new assignments,
    or run it outside its normal schedule.

    Args:
        agent_id: UUID of the agent to trigger.
    """
    if not agent_id.strip():
        return _err("agent_id is required.")
    return await _post(f"/agents/{agent_id.strip()}/heartbeat/invoke")


# ── GOALS ──────────────────────────────────────────────────────────────────────

@mcp.tool()
async def list_goals() -> Any:
    """List all strategic goals and projects for the active company."""
    company_id = _get_company_id()
    if not company_id:
        return _err("PAPERCLIP_COMPANY_ID is not configured.")
    return await _get(f"/companies/{company_id}/goals")


@mcp.tool()
async def create_goal(title: str, description: str = "") -> Any:
    """Create a new strategic goal for the active company.

    Goals provide high-level direction to agents. They appear in agent context
    so agents can align their work accordingly.

    Args:
        title: Goal title (e.g. "Reach 300 packs/month in sales by June 2026").
        description: Extended context, success criteria, and constraints (Markdown supported).
    """
    company_id = _get_company_id()
    if not company_id:
        return _err("PAPERCLIP_COMPANY_ID is not configured.")
    body: dict[str, Any] = {"title": title}
    if description:
        body["description"] = description
    return await _post(f"/companies/{company_id}/goals", body)


@mcp.tool()
async def update_goal(
    goal_id: str,
    title: str = "",
    description: str = "",
) -> Any:
    """Update an existing goal's title or description.

    Args:
        goal_id: Goal UUID.
        title: New title. Leave empty to keep current.
        description: New description. Leave empty to keep current.
    """
    if not goal_id.strip():
        return _err("goal_id is required.")
    body: dict[str, Any] = {}
    if title:
        body["title"] = title
    if description:
        body["description"] = description
    if not body:
        return _err("No fields to update. Provide at least one of: title, description.")
    return await _patch(f"/goals/{goal_id.strip()}", body)


# ── APPROVALS ──────────────────────────────────────────────────────────────────

@mcp.tool()
async def list_approvals(status: str = "pending") -> Any:
    """List approval requests in the active company.

    Args:
        status: Filter by status. Allowed values:
                pending, approved, rejected, revision_requested.
                Default: "pending"
    """
    company_id = _get_company_id()
    if not company_id:
        return _err("PAPERCLIP_COMPANY_ID is not configured.")
    allowed = {"pending", "approved", "rejected", "revision_requested"}
    if status not in allowed:
        return _err(f"Invalid status '{status}'. Allowed: {', '.join(sorted(allowed))}.")
    return await _get(f"/companies/{company_id}/approvals", {"status": status})


@mcp.tool()
async def approve(approval_id: str, comment: str = "") -> Any:
    """Approve a pending approval request.

    Args:
        approval_id: Approval UUID.
        comment: Optional approval note to attach (e.g. conditions, context).
    """
    if not approval_id.strip():
        return _err("approval_id is required.")
    body: dict[str, Any] = {}
    if comment:
        body["comment"] = comment
    return await _post(f"/approvals/{approval_id.strip()}/approve", body)


@mcp.tool()
async def reject(approval_id: str, comment: str = "") -> Any:
    """Reject a pending approval request.

    Args:
        approval_id: Approval UUID.
        comment: Reason for rejection — strongly recommended so the agent understands why.
    """
    if not approval_id.strip():
        return _err("approval_id is required.")
    body: dict[str, Any] = {}
    if comment:
        body["comment"] = comment
    return await _post(f"/approvals/{approval_id.strip()}/reject", body)


@mcp.tool()
async def request_approval_revision(approval_id: str, comment: str) -> Any:
    """Request a revision on a pending approval without fully rejecting it.

    The submitting agent will receive the comment and can resubmit.

    Args:
        approval_id: Approval UUID.
        comment: Required. Specific feedback describing what must change before approval.
    """
    if not approval_id.strip():
        return _err("approval_id is required.")
    if not comment.strip():
        return _err("A comment is required when requesting a revision.")
    return await _post(f"/approvals/{approval_id.strip()}/request-revision", {"comment": comment.strip()})


# ── COSTS & MONITORING ─────────────────────────────────────────────────────────

@mcp.tool()
async def get_cost_summary() -> Any:
    """Get aggregate token usage and spend for the active company this billing period.

    Returns total spend, remaining budget, and a per-agent cost breakdown.
    Use this to monitor AI spend and detect runaway agents.
    """
    company_id = _get_company_id()
    if not company_id:
        return _err("PAPERCLIP_COMPANY_ID is not configured.")
    return await _get(f"/companies/{company_id}/costs/summary")


@mcp.tool()
async def get_dashboard() -> Any:
    """Get a high-level health summary for the active company.

    Returns: agent count, open/in-progress/blocked issue counts, stale tasks,
    recent activity digest, and current-period cost totals.
    """
    company_id = _get_company_id()
    if not company_id:
        return _err("PAPERCLIP_COMPANY_ID is not configured.")
    return await _get(f"/companies/{company_id}/dashboard")


@mcp.tool()
async def list_activity(
    agent_id: str = "",
    limit: int = 20,
) -> Any:
    """Retrieve the audit trail of recent actions in the active company.

    Args:
        agent_id: Filter to a specific agent UUID. Leave empty for all agents.
        limit: Maximum number of entries to return (1–100). Default: 20.
    """
    company_id = _get_company_id()
    if not company_id:
        return _err("PAPERCLIP_COMPANY_ID is not configured.")
    params: dict[str, Any] = {"limit": max(1, min(limit, 100))}
    if agent_id:
        params["agentId"] = agent_id.strip()
    return await _get(f"/companies/{company_id}/activity", params)


# ── PROJECTS ───────────────────────────────────────────────────────────────────

@mcp.tool()
async def list_projects() -> Any:
    """List all projects in the active company.

    Returns: Array of projects with their id, name, description, and status.
    """
    company_id = _get_company_id()
    if not company_id:
        return _err("PAPERCLIP_COMPANY_ID is not configured.")
    return await _get(f"/companies/{company_id}/projects")


@mcp.tool()
async def get_project(project_id: str) -> Any:
    """Get details of a specific project.

    Args:
        project_id: UUID or short reference of the project.
    """
    if not project_id.strip():
        return _err("project_id is required.")
    return await _get(f"/projects/{project_id.strip()}")


# ── COMMENTS & DISCUSSION ──────────────────────────────────────────────────────

@mcp.tool()
async def list_comments(
    issue_id: str,
    limit: int = 50,
    order: str = "asc",
) -> Any:
    """List comments in an issue's discussion thread.

    Args:
        issue_id: UUID or identifier of the issue (e.g. 'KHT-23').
        limit: Max comments to return (1–500). Default: 50.
        order: Sort order by creation date ('asc' or 'desc'). Default: 'asc'.
    """
    if not issue_id.strip():
        return _err("issue_id is required.")
    params: dict[str, Any] = {"limit": max(1, min(limit, 500)), "order": order}
    return await _get(f"/issues/{issue_id.strip()}/comments", params=params)


@mcp.tool()
async def get_comment(issue_id: str, comment_id: str) -> Any:
    """Get a specific comment by ID within an issue.

    Args:
        issue_id: UUID or identifier of the issue.
        comment_id: UUID of the comment.
    """
    if not issue_id.strip() or not comment_id.strip():
        return _err("Both issue_id and comment_id are required.")
    return await _get(f"/issues/{issue_id.strip()}/comments/{comment_id.strip()}")


# ── ISSUE DOCUMENTS ────────────────────────────────────────────────────

@mcp.tool()
async def list_issue_documents(issue_id: str) -> Any:
    """List all attached documents (plans, specs, notes) for an issue.

    Args:
        issue_id: UUID or identifier of the issue.
    """
    if not issue_id.strip():
        return _err("issue_id is required.")
    return await _get(f"/issues/{issue_id.strip()}/documents")


@mcp.tool()
async def get_issue_document(issue_id: str, key: str = "plan") -> Any:
    """Get the content of a specific document attached to an issue (e.g. 'plan', 'spec').

    Args:
        issue_id: UUID or identifier of the issue.
        key: Document key identifier (default: 'plan').
    """
    if not issue_id.strip() or not key.strip():
        return _err("Both issue_id and document key are required.")
    return await _get(f"/issues/{issue_id.strip()}/documents/{key.strip()}")


@mcp.tool()
async def upsert_issue_document(
    issue_id: str,
    key: str,
    body: str,
    title: str = "",
    change_summary: str = "",
) -> Any:
    """Create or update a structured markdown document attached to an issue.

    Args:
        issue_id: UUID or identifier of the issue.
        key: Document key (e.g. 'plan', 'architecture', 'spec').
        body: Markdown content of the document.
        title: Optional human-readable title.
        change_summary: Optional brief description of what was changed.
    """
    if not issue_id.strip() or not key.strip() or not body.strip():
        return _err("issue_id, key, and body are required.")
    payload: dict[str, Any] = {
        "key": key.strip(),
        "body": body,
        "format": "markdown",
    }
    if title.strip():
        payload["title"] = title.strip()
    if change_summary.strip():
        payload["changeSummary"] = change_summary.strip()
    return await _put(f"/issues/{issue_id.strip()}/documents/{key.strip()}", body=payload)


# ── ISSUE INTERACTIONS (HUMAN-IN-THE-LOOP UI) ──────────────────────────────────

@mcp.tool()
async def ask_user_questions(
    issue_id: str,
    questions: list[dict[str, Any]],
    title: str = "Clarification Needed",
    summary: str = "",
) -> Any:
    """Create an interactive question card on Paperclip UI for human answers.

    Args:
        issue_id: UUID or identifier of the issue.
        questions: List of question objects, each with 'id', 'question', 'type' (text/choice), and optional 'options'.
        title: Title of the interaction card.
        summary: Optional context explaining why these questions are needed.
    """
    if not issue_id.strip() or not questions:
        return _err("issue_id and at least one question are required.")
    payload = {
        "kind": "ask_user_questions",
        "title": title,
        "summary": summary or None,
        "payload": {"questions": questions},
    }
    return await _post(f"/issues/{issue_id.strip()}/interactions", body=payload)


@mcp.tool()
async def request_confirmation(
    issue_id: str,
    question: str,
    title: str = "Confirmation Required",
    summary: str = "",
) -> Any:
    """Create a confirmation card (Approve/Reject button) on Paperclip UI for human approval.

    Args:
        issue_id: UUID or identifier of the issue.
        question: The confirmation prompt (e.g. 'Proceed with database migration?').
        title: Title of the confirmation card.
        summary: Optional background context.
    """
    if not issue_id.strip() or not question.strip():
        return _err("issue_id and question are required.")
    payload = {
        "kind": "request_confirmation",
        "title": title,
        "summary": summary or None,
        "payload": {"question": question.strip()},
    }
    return await _post(f"/issues/{issue_id.strip()}/interactions", body=payload)


@mcp.tool()
async def suggest_tasks(
    issue_id: str,
    tasks: list[dict[str, Any]],
    title: str = "Suggested Subtasks",
    summary: str = "",
) -> Any:
    """Create a task suggestion card on Paperclip UI allowing human to approve creating subtasks.

    Args:
        issue_id: UUID or identifier of the parent issue.
        tasks: List of task objects with 'title' and optional 'description', 'assigneeAgentId'.
        title: Title of the suggestion card.
        summary: Optional explanation of the task breakdown.
    """
    if not issue_id.strip() or not tasks:
        return _err("issue_id and tasks list are required.")
    payload = {
        "kind": "suggest_tasks",
        "title": title,
        "summary": summary or None,
        "payload": {"tasks": tasks},
    }
    return await _post(f"/issues/{issue_id.strip()}/interactions", body=payload)


# ── DELEGATION & ORCHESTRATION ────────────────────────────────────────────────

@mcp.tool()
async def delegate_contract_review(
    parent_issue_id: str,
    agent_name_keyword: str = "HRR",
    note: str = "",
) -> Any:
    """Tự động tìm ID của Agent phụ trách hợp đồng (HR/n8n) và tạo Sub-task gán cho Agent đó.

    Args:
        parent_issue_id: UUID hoặc mã nhận diện của Task cha đang tiếp nhận yêu cầu.
        agent_name_keyword: Từ khóa tìm tên Agent trong danh sách (mặc định: 'HRR').
        note: Ghi chú hoặc yêu cầu đặc biệt khi thẩm định.
    """
    if not parent_issue_id.strip():
        return _err("parent_issue_id is required.")

    req_headers = _headers()

    # 1. Lấy thông tin task cha để kế thừa tiêu đề và tự động trích xuất companyId nếu thiếu
    parent_issue = await _get(f"/issues/{parent_issue_id.strip()}", headers=req_headers)
    if isinstance(parent_issue, dict) and parent_issue.get("isError"):
        return parent_issue

    # Lấy UUID chuẩn của task cha (phòng trường hợp caller truyền identifier như 'KHT-39')
    parent_uuid = str(parent_issue.get("id") or parent_issue_id.strip()) if isinstance(parent_issue, dict) else parent_issue_id.strip()

    parent_title = "Yêu cầu hợp đồng"
    if isinstance(parent_issue, dict) and "title" in parent_issue:
        parent_title = parent_issue["title"]

    effective_company_id = _get_company_id()
    if not effective_company_id and isinstance(parent_issue, dict) and parent_issue.get("companyId"):
        effective_company_id = parent_issue["companyId"]

    if not effective_company_id:
        return _err("PAPERCLIP_COMPANY_ID is not configured and could not be inferred from agent token or parent issue.")

    # 2. Tìm Agent phù hợp
    agents_res = await _get(f"/companies/{effective_company_id}/agents", headers=req_headers)
    if isinstance(agents_res, dict) and agents_res.get("isError"):
        return agents_res

    agents_list: list[Any] = (
        agents_res
        if isinstance(agents_res, list)
        else (agents_res.get("items", []) if isinstance(agents_res, dict) else [])
    )
    
    kw = (agent_name_keyword or "").strip().lower()
    target_agent = next(
        (
            a for a in agents_list
            if isinstance(a, dict) and (
                kw in (a.get("name") or "").lower()
                or kw in (a.get("title") or "").lower()
                or kw in (a.get("role") or "").lower()
            )
        ),
        None,
    )

    if not target_agent:
        available = [
            f"'{a.get('name')}' (role: {a.get('role') or 'unknown'}, status: {a.get('status') or 'unknown'})"
            for a in agents_list if isinstance(a, dict)
        ]
        return _err(
            f"Không tìm thấy Agent nào khớp với từ khóa '{agent_name_keyword}'. "
            f"Danh sách agent hiện có trong công ty: {', '.join(available) if available else 'Không có agent nào'}"
        )

    target_agent_id = target_agent.get("id")
    target_agent_name = target_agent.get("name")

    # 3. Tạo Sub-task con trên Paperclip với đầy đủ status, priority
    issue_payload = {
        "title": f"[HR-Contract] Thẩm định: {parent_title}",
        "description": f"**Yêu cầu:** Thẩm định hợp đồng từ task cha (`{parent_issue_id.strip()}`)\n\n**Ghi chú:** {note.strip() if note.strip() else 'Không có'}\n\n*Task được tự động tạo và điều phối bởi Agent.*",
        "status": "todo",
        "priority": "critical",
        "parentId": parent_uuid,
        "assigneeAgentId": target_agent_id,
    }
    new_task = await _post(f"/companies/{effective_company_id}/issues", issue_payload, headers=req_headers)
    if isinstance(new_task, dict) and new_task.get("isError"):
        return new_task

    child_issue_id = new_task.get("id") if isinstance(new_task, dict) else None

    # 4. Tự động chuyển Task cha sang 'blocked' và gán ràng buộc blockedByIssueIds (không gửi comment ngầm để tránh tự đánh thức Run thừa)
    parent_patch_payload: dict[str, Any] = {
        "status": "blocked",
    }
    if child_issue_id:
        parent_patch_payload["blockedByIssueIds"] = [child_issue_id]

    patch_res = await _patch(f"/issues/{parent_uuid}", parent_patch_payload, headers=req_headers)
    if isinstance(patch_res, dict) and patch_res.get("isError"):
        return patch_res

    blocked_ids: list[str] = [str(child_issue_id)] if child_issue_id else []
    return {
        "status": "success",
        "parentStatus": "blocked",
        "blockedByIssueIds": blocked_ids,
        "assignedToAgent": target_agent_name,
        "assignedAgentId": target_agent_id,
        "createdTask": new_task,
    }


@mcp.tool()
async def delegate_task_to_agent(
    task_title: str,
    task_description: str,
    target_agent_keyword: str,
    parent_issue_id: str,
    priority: str = "high",
    status: str = "todo",
    notify_parent: bool = False,
    block_parent: bool = True,
) -> Any:
    """Điều phối và tạo Sub-task con gán cho Agent chuyên biệt dựa trên từ khóa tên Agent.

    Args:
        task_title: Tiêu đề task con cần tạo.
        task_description: Nội dung chi tiết yêu cầu công việc.
        target_agent_keyword: Từ khóa tìm tên Agent nhận việc (ví dụ: 'HR', 'Legal', 'QA', 'Dev').
        parent_issue_id: UUID của Task cha.
        priority: Mức độ ưu tiên ('low', 'medium', 'high', 'critical' - mặc định: 'high').
        status: Trạng thái ban đầu của task con ('todo', 'backlog' - mặc định: 'todo').
        notify_parent: Đăng comment thông báo trên Task cha (mặc định: False để tránh trigger thừa).
        block_parent: Tự động chuyển Task cha sang trạng thái 'blocked' kèm ràng buộc blockedByIssueIds (mặc định: True).
    """
    if not task_title.strip() or not parent_issue_id.strip() or not target_agent_keyword.strip():
        return _err("task_title, target_agent_keyword, and parent_issue_id are required.")

    req_headers = _headers()

    # 1. Lấy thông tin task cha để trích xuất UUID chuẩn và companyId
    parent_issue = await _get(f"/issues/{parent_issue_id.strip()}", headers=req_headers)
    if isinstance(parent_issue, dict) and parent_issue.get("isError"):
        return parent_issue

    parent_uuid = str(parent_issue.get("id") or parent_issue_id.strip()) if isinstance(parent_issue, dict) else parent_issue_id.strip()

    effective_company_id = _get_company_id()
    if not effective_company_id and isinstance(parent_issue, dict) and parent_issue.get("companyId"):
        effective_company_id = parent_issue["companyId"]

    if not effective_company_id:
        return _err("PAPERCLIP_COMPANY_ID is not configured and could not be inferred from agent token or parent issue.")

    agents_res = await _get(f"/companies/{effective_company_id}/agents", headers=req_headers)
    if isinstance(agents_res, dict) and agents_res.get("isError"):
        return agents_res

    agents_list: list[Any] = (
        agents_res
        if isinstance(agents_res, list)
        else (agents_res.get("items", []) if isinstance(agents_res, dict) else [])
    )
    
    kw = (target_agent_keyword or "").strip().lower()
    target_agent = next(
        (
            a for a in agents_list
            if isinstance(a, dict) and (
                kw in (a.get("name") or "").lower()
                or kw in (a.get("title") or "").lower()
                or kw in (a.get("role") or "").lower()
            )
        ),
        None,
    )

    if not target_agent:
        available = [
            f"'{a.get('name')}' (role: {a.get('role') or 'unknown'}, status: {a.get('status') or 'unknown'})"
            for a in agents_list if isinstance(a, dict)
        ]
        return _err(
            f"Không tìm thấy Agent nào khớp với từ khóa '{target_agent_keyword}'. "
            f"Danh sách agent hiện có trong công ty: {', '.join(available) if available else 'Không có agent nào'}"
        )

    target_agent_id = target_agent.get("id")
    target_agent_name = target_agent.get("name")

    # 2. Tạo Task con với đầy đủ status và priority
    issue_payload = {
        "title": task_title.strip(),
        "description": f"{task_description.strip()}\n\n*Điều phối tự động bởi Agent.*",
        "status": status.strip() if status.strip() else "todo",
        "priority": priority.strip() if priority.strip() else "high",
        "parentId": parent_uuid,
        "assigneeAgentId": target_agent_id,
    }
    new_task = await _post(f"/companies/{effective_company_id}/issues", issue_payload, headers=req_headers)
    if isinstance(new_task, dict) and new_task.get("isError"):
        return new_task

    child_issue_id = new_task.get("id") if isinstance(new_task, dict) else None

    # 3. Tự động chuyển Task cha sang 'blocked' và gán blockedByIssueIds
    if block_parent:
        parent_patch_payload: dict[str, Any] = {
            "status": "blocked",
        }
        if notify_parent:
            parent_patch_payload["comment"] = (
                f"🔀 Đã chuyển giao công việc **\"{task_title.strip()}\"** "
                f"(Mức độ: `{priority}`, Trạng thái: `{status}`) cho Agent **{target_agent_name}**. "
                f"Task cha chuyển sang trạng thái chờ (`Blocked`)."
            )
        if child_issue_id:
            parent_patch_payload["blockedByIssueIds"] = [child_issue_id]

        patch_res = await _patch(f"/issues/{parent_uuid}", parent_patch_payload, headers=req_headers)
        if isinstance(patch_res, dict) and patch_res.get("isError"):
            return patch_res

    blocked_ids: list[str] = [str(child_issue_id)] if (block_parent and child_issue_id) else []
    return {
        "status": "success",
        "parentStatus": "blocked" if block_parent else "unchanged",
        "blockedByIssueIds": blocked_ids,
        "assignedToAgent": target_agent_name,
        "assignedAgentId": target_agent_id,
        "createdTask": new_task,
    }

# ── ATTACHMENT UPLOAD HELPERS & TOOL ──────────────────────────────────────────

def _upload_headers() -> dict[str, str]:
    headers = _headers()
    headers.pop("Content-Type", None)
    return headers


async def _upload_file_to_issue(
    file_path: str,
    issue_id: str,
) -> dict[str, Any]:
    """Upload a local file as an attachment to a Paperclip issue."""
    path = Path(file_path)
    if not path.is_file():
        raise FileNotFoundError(f"Local file not found: {file_path}")

    cid = _get_company_id()
    if not cid:
        raise ValueError("Cannot upload attachment: company_id is required.")

    req_headers = _upload_headers()
    url = f"{_get_base_url()}/companies/{cid}/issues/{issue_id}/attachments"

    mime_type, _ = mimetypes.guess_type(path.name)
    mime_type = mime_type or "application/octet-stream"

    async with httpx.AsyncClient(timeout=60.0) as client:
        with open(path, "rb") as f:
            files = {"file": (path.name, f, mime_type)}
            r = await client.post(url, headers=req_headers, files=files)
            r.raise_for_status()
            return cast(dict[str, Any], r.json())


@mcp.tool()
async def upload_issue_attachment(
    issue_id: str,
    file_path: str,
) -> Any:
    """Tải lên (Upload) file từ ổ đĩa máy tính vào phần đính kèm (Attachments) của một Task trên Paperclip.

    CRITICAL INSTRUCTIONS FOR AGENT:
    - issue_id: Mã hoặc UUID của task cần đính kèm file (ví dụ: 'KHT-58' hoặc UUID).
    - file_path: Đường dẫn tuyệt đối hoặc tương đối tới file cần upload (ví dụ: 'report.pdf', 'data.csv').
    """
    path = Path(file_path.strip().strip('"').strip("'"))
    if not path.exists():
        return _err(f"Không tìm thấy file tại đường dẫn: {file_path}")
    if not path.is_file():
        return _err(f"Đường dẫn là thư mục, không phải file: {file_path}")

    req_headers = _headers()
    real_uuid = issue_id.strip()
    try:
        issue_info = await _get(f"/issues/{issue_id.strip()}", headers=req_headers)
        if isinstance(issue_info, dict) and issue_info.get("id"):
            real_uuid = issue_info["id"]
    except Exception:
        pass

    try:
        res = await _upload_file_to_issue(
            file_path=str(path),
            issue_id=real_uuid,
        )
        return {
            "status": "success",
            "message": f"Đã upload file '{path.name}' vào task {issue_id} thành công.",
            "attachment": res,
        }
    except Exception as e:
        return _err(f"Lỗi khi upload file lên Paperclip: {e}")


# ── TELEGRAM & N8N INTEGRATION ────────────────────────────────────────────────

_TELEGRAM_NESTED_KEYS = ("telegram_context", "telegram", "context")
_TELEGRAM_ID_RE = re.compile(r"^-?\d{1,20}$")
_MAX_CONTEXT_SCAN_CHARS = 50_000
# Dạng cũ, chỉ chấp nhận khi cả dòng là "chat_id: 123" (không bắt trong câu văn).
_LEGACY_CHAT_LINE_RE = re.compile(
    r"^[ \t>*_-]*chat[_ ]?id[ \t]*[:=][ \t]*(-?\d{1,20})[ \t]*$", re.IGNORECASE | re.MULTILINE
)
_LEGACY_MESSAGE_LINE_RE = re.compile(
    r"^[ \t>*_-]*message[_ ]?id[ \t]*[:=][ \t]*(\d{1,20})[ \t]*$", re.IGNORECASE | re.MULTILINE
)


def _coerce_chat_id(value: Any) -> int | None:
    """chat_id Telegram: số nguyên khác 0 (nhóm/supergroup là số âm). Chấp nhận số hoặc chuỗi số."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and _TELEGRAM_ID_RE.match(value.strip()):
        number = int(value.strip())
    else:
        return None
    return number if number != 0 else None


def _coerce_message_id(value: Any) -> int | None:
    number = _coerce_chat_id(value)
    return number if number is not None and number > 0 else None


def _telegram_ids_from_mapping(obj: Any) -> tuple[int | None, int | None]:
    """Đọc chat_id/message_id từ object, hoặc từ object con telegram_context/telegram/context."""
    if not isinstance(obj, dict):
        return None, None
    for candidate in [obj, *(obj.get(key) for key in _TELEGRAM_NESTED_KEYS)]:
        if not isinstance(candidate, dict):
            continue
        chat = _coerce_chat_id(candidate.get("chat_id", candidate.get("chatId")))
        if chat is not None:
            message = _coerce_message_id(candidate.get("message_id", candidate.get("messageId")))
            return chat, message
    return None, None


def _json_objects_in_text(text: str) -> list[dict[str, Any]]:
    """Mọi object JSON hợp lệ trong văn bản theo thứ tự xuất hiện, kể cả JSON nằm trong khối ``` hoặc nối thô."""
    decoder = json.JSONDecoder()
    tail = text[-_MAX_CONTEXT_SCAN_CHARS:]
    found: list[dict[str, Any]] = []
    index = 0
    while True:
        index = tail.find("{", index)
        if index == -1:
            return found
        try:
            obj, end = decoder.raw_decode(tail, index)
        except ValueError:
            index += 1
            continue
        if isinstance(obj, dict):
            found.append(obj)
            index = end
        else:
            index += 1


def _parse_telegram_context(text: str) -> dict[str, Any] | None:
    """Bóc tách chat_id/message_id từ description của task.

    n8n nối một JSON chứa chat_id, message_id (và ngữ cảnh) vào CUỐI description, dạng khối
    ```json:telegram_context ... ``` hoặc JSON thô. Luôn lấy object CUỐI CÙNG có chat_id hợp lệ để
    nội dung do người dùng viết phía trước không thể giả mạo. Dòng "chat_id: 123" đứng riêng
    chỉ là phương án lùi cho task cũ.
    Trả về {"chat_id", "message_id", "source", "context"} hoặc None.
    """
    if not text:
        return None
    for obj in reversed(_json_objects_in_text(text)):
        chat, message = _telegram_ids_from_mapping(obj)
        if chat is not None:
            return {"chat_id": chat, "message_id": message, "source": "description_json", "context": obj}

    chats = _LEGACY_CHAT_LINE_RE.findall(text)
    if chats:
        chat = _coerce_chat_id(chats[-1])
        if chat is not None:
            messages = _LEGACY_MESSAGE_LINE_RE.findall(text)
            message = _coerce_message_id(messages[-1]) if messages else None
            return {"chat_id": chat, "message_id": message, "source": "description_line", "context": {}}
    return None


def _extract_telegram_context_from_description(description: str) -> dict[str, Any]:
    """Giữ tên cũ: trả {} khi không có, ngược lại {chat_id, message_id, ...}."""
    return _parse_telegram_context(description) or {}


def _resolve_telegram_target(
    *,
    metadata: Any = None,
    description: str = "",
    wake_payloads: list[str] | None = None,
    arg_chat_id: Any = None,
    arg_message_id: Any = None,
) -> dict[str, Any] | None:
    """Chọn chat_id/message_id theo thứ tự từ nguồn tin cậy đến kém tin cậy.

    1. metadata của task  2. JSON nối cuối description  3. wake payload  4. tham số do agent truyền.
    Không bao giờ đọc từ title hay từ `message` do agent viết. message_id luôn lấy cùng nguồn với chat_id.
    """
    meta = metadata
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except ValueError:
            meta = None
    chat, message = _telegram_ids_from_mapping(meta)
    if chat is not None:
        return {"chat_id": chat, "message_id": message, "source": "metadata", "context": meta}

    parsed = _parse_telegram_context(description)
    if parsed is not None:
        return parsed

    for raw in wake_payloads or []:
        if not raw or not raw.strip():
            continue
        try:
            payload = json.loads(raw)
        except ValueError:
            continue
        chat, message = _telegram_ids_from_mapping(payload)
        if chat is not None:
            return {"chat_id": chat, "message_id": message, "source": "wake_payload", "context": payload}

    chat = _coerce_chat_id(arg_chat_id)
    if chat is not None:
        return {
            "chat_id": chat,
            "message_id": _coerce_message_id(arg_message_id),
            "source": "tool_argument",
            "context": {},
        }
    return None


_MAX_ANCESTOR_DEPTH = 10


async def _find_telegram_ancestor(
    issue: dict[str, Any],
    headers: dict[str, str],
) -> tuple[dict[str, Any], str] | None:
    """Đi lên theo parentId từ task con, tìm task tổ tiên gần nhất có ngữ cảnh Telegram.

    Task con do agent tạo không mang JSON chat_id; n8n chỉ nối JSON đó vào task gốc. Trả về
    (target, id UUID của tổ tiên) hoặc None khi không có tổ tiên nào có chat_id. Lỗi đọc task
    cha không làm hỏng tool: coi như không tìm thấy.
    """
    current = issue
    seen: set[str] = set()
    for _ in range(_MAX_ANCESTOR_DEPTH):
        parent_id = str(current.get("parentId") or "").strip()
        if not parent_id or parent_id in seen:
            return None
        seen.add(parent_id)
        try:
            parent = await _get(f"/issues/{parent_id}", headers=headers)
        except Exception as ex:
            log.warning("Không đọc được task cha %s để tìm chat_id: %s", parent_id, ex)
            return None
        if not isinstance(parent, dict) or parent.get("isError"):
            return None
        target = _resolve_telegram_target(
            metadata=parent.get("metadata"),
            description=str(parent.get("description") or ""),
        )
        if target is not None:
            return target, str(parent.get("id") or parent_id)
        current = parent
    return None


async def _resolve_current_task_id() -> str:
    """Tự động suy diễn Task ID từ JWT claims hoặc Heartbeat Run hiện tại."""
    active_run_id = _run_id()

    if active_run_id:
        req_headers = _headers()
        # Cách 1: Gọi GET /heartbeat-runs/{run_id}/issues
        try:
            issues_list = await _get(f"/heartbeat-runs/{active_run_id}/issues", headers=req_headers)
            if isinstance(issues_list, list) and len(issues_list) > 0:
                first_issue = issues_list[0]
                if isinstance(first_issue, dict) and first_issue.get("issueId"):
                    return str(first_issue["issueId"])
        except Exception as ex:
            log.warning("Không thể tra cứu issues qua /heartbeat-runs/%s/issues: %s", active_run_id, ex)

        # Cách 2: Gọi GET /heartbeat-runs/{run_id} để đọc contextSnapshot
        try:
            run_data = await _get(f"/heartbeat-runs/{active_run_id}", headers=req_headers)
            if isinstance(run_data, dict):
                snapshot = run_data.get("contextSnapshot") or {}
                if isinstance(snapshot, dict) and snapshot.get("issueId"):
                    return str(snapshot["issueId"])
                if run_data.get("issueId"):
                    return str(run_data["issueId"])
        except Exception as ex:
            log.warning("Không thể tra cứu run qua /heartbeat-runs/%s: %s", active_run_id, ex)

    # Cách 3: Kiểm tra biến môi trường
    env_task = os.environ.get("PAPERCLIP_TASK_ID", "").strip()
    if env_task:
        return env_task

    return ""


def _pick_attachment_by_name(attachments: Any, file_name: str) -> dict[str, Any] | None:
    """Chọn attachment của task có tên file trùng `file_name` (không phân biệt hoa thường).

    Paperclip trả tên gốc ở `originalFilename` (nhận thêm `filename` cho an toàn). Nhiều file
    trùng tên thì lấy cái tạo gần nhất. Không khớp thì trả None, tuyệt đối không đoán bằng
    attachment cuối cùng vì đó có thể là file người dùng gửi từ Telegram.
    """
    target = os.path.basename((file_name or "").strip().replace("\\", "/")).casefold()
    if not target or not isinstance(attachments, list):
        return None
    matches: list[tuple[str, int, dict[str, Any]]] = []
    for index, item in enumerate(attachments):
        if not isinstance(item, dict):
            continue
        name = str(item.get("originalFilename") or item.get("filename") or "")
        if os.path.basename(name.replace("\\", "/")).casefold() == target:
            matches.append((str(item.get("createdAt") or ""), index, item))
    if not matches:
        return None
    return max(matches, key=lambda m: (m[0], m[1]))[2]


@mcp.tool()
async def finish_task_and_reply_telegram(
    message: str,
    file_path: str = "",
    status: str = "done",
) -> Any:
    """Hoàn thành task, tự động upload file kết quả lên Paperclip (nếu có),
    tự động phát hiện chat_id/message_id và task_id từ phiên làm việc,
    nghiệm thu đóng task và gửi 100% toàn diện thông tin Task về Telegram qua n8n Webhook.

    QUAN TRỌNG DÀNH CHO AGENT:
    - Bạn CHỈ CẦN truyền `message` (câu trả lời cho người dùng), `status` và `file_path` (nếu có file tạo ra).
    - Task, chat_id, message_id, run và URL webhook n8n đều do hệ thống tự xác định, không có tham số để điền.
    - Task không có chat_id (tạo tay, không đến từ Telegram): tool bỏ qua bước gửi Telegram, vẫn ghi comment
      và đóng task; kết quả trả về có `telegram_skipped: true`.

    Args:
        message: CÂU TRẢ LỜI ĐẦY ĐỦ VÀ THỎA ĐÁNG GỬI CHO KHÁCH HÀNG TRÊN TELEGRAM.
                 - Phải giải quyết trọn vẹn câu hỏi/yêu cầu ban đầu của người dùng.
                 - Trình bày lịch sự, văn phong chuyên nghiệp, dễ hiểu.
                 - Nếu thành công: Nêu rõ kết quả, phân tích chi tiết, các lưu ý quan trọng.
                 - Nếu thiếu thông tin/bị hủy: Giải thích cặn kẽ lý do tại sao chưa làm được.
        file_path: Tùy chọn: Đường dẫn đến file kết quả/báo cáo cần gửi cho khách (ví dụ: 'bc10_6_2026.md' hoặc 'C:/data/bao_cao.pdf').
                   Tool sẽ TỰ ĐỘNG upload file này lên Paperclip và gửi link tải trực tiếp sang Telegram, Agent không cần chạy curl/PowerShell.
        status: Trạng thái đóng task: 'done' (mặc định), 'cancelled', 'blocked' hoặc 'failed' (tính như cancelled).
    """
    log.info("[finish_task] ================= BẮT ĐẦU HOÀN THÀNH TASK & PHẢN HỒI TELEGRAM =================")
    # Các mốc chính của lần chạy: ghi stderr và đồng thời đưa vào `steps` của kết quả (stderr không đi
    # qua ACP nên transcript không thấy). Không đưa secret hay nội dung `message` vào đây.
    steps = StepLog("finish_task", total=5, logger=log)
    steps.start(f"Tham số nhận vào: status='{status}', file_path='{file_path}'")

    # 1. Xác định Task ID
    effective_task_id = os.environ.get("PAPERCLIP_TASK_ID", "").strip()
    if not effective_task_id:
        steps.fail(
            1,
            "Thiếu task_id: không có biến môi trường PAPERCLIP_TASK_ID. "
            "Hướng dẫn khắc phục: gọi tool này trong run của một task (Paperclip tự đặt PAPERCLIP_TASK_ID).",
        )
    steps.ok(1, f"Xác định được Task ID: {effective_task_id}")

    # Lấy thông tin task để đọc description, metadata, và giải quyết UUID chuẩn
    req_headers = _headers()
    # Run đang thực thi tool này. n8n gửi lại giá trị này trong header X-Paperclip-Run-Id khi
    # comment/đóng task để Paperclip tính comment đó là của run và không tạo run bàn giao mới.
    effective_run_id = _run_id()
    issue_data: dict[str, Any] = {}
    issue_metadata: Any = None
    real_issue_uuid = effective_task_id

    steps.info(1, f"Đang gọi Paperclip API GET /issues/{effective_task_id} để lấy metadata & description")
    try:
        raw_issue = await _get(f"/issues/{effective_task_id}", headers=req_headers)
        if isinstance(raw_issue, dict):
            issue_data = raw_issue
            real_issue_uuid = issue_data.get("id") or effective_task_id
            issue_metadata = issue_data.get("metadata")
            steps.ok(1, f"Đã đọc thông tin task từ Paperclip API (UUID: {real_issue_uuid})")
    except Exception as e:
        steps.warn(
            1,
            f"Không thể đọc task từ Paperclip API: {str(e)[:120]}",
            detail="Sẽ kiểm tra qua biến môi trường",
        )

    # 2. XÁC ĐỊNH CHAT_ID VÀ MESSAGE_ID, theo thứ tự từ nguồn tin cậy đến kém tin cậy:
    #    metadata của task -> JSON nối cuối description -> wake payload.
    #    Không đọc từ title và không đọc từ `message` do agent viết.
    steps.info(2, "Đang trích xuất chat_id/message_id")
    description_text = str(issue_data.get("description") or "") if issue_data else ""
    target = _resolve_telegram_target(
        metadata=issue_metadata,
        description=description_text,
        wake_payloads=[
            os.environ.get("PAPERCLIP_WAKE_PAYLOAD_JSON", ""),
            os.environ.get("PAPERCLIP_TASK_PAYLOAD", ""),
        ],
    )

    # Task con không có chat_id riêng: chat_id nằm ở task tổ tiên (task gốc do n8n tạo). Chỉ khi
    # task con báo `blocked` (đang chờ người dùng bổ sung) mới chuyển sang n8n, và báo bằng id của
    # task tổ tiên để n8n đưa đúng task đó vào hàng đợi. done/cancelled/failed của task con không
    # gửi Telegram: kết quả cuối do task cha tổng hợp và trả lời.
    ancestor_task_id = ""
    if target is None and issue_data and status.lower().strip() == "blocked":
        ancestor = await _find_telegram_ancestor(issue_data, req_headers)
        if ancestor is not None:
            target, ancestor_task_id = ancestor
            target["source"] = f"parent:{target['source']}"
            steps.info(
                2, f"Task con không có chat_id riêng: lấy chat_id từ task cha {ancestor_task_id[:8]}", ui=True
            )

    # Task tạo tay (không có JSON do n8n nối vào) thì không có nơi để gửi Telegram. Không coi là lỗi:
    # bỏ qua bước gửi, vẫn ghi comment và đóng task để run không bị treo.
    telegram_skipped = target is None
    effective_chat_id: int | None = None
    effective_message_id: int | None = None
    chat_source = "none"
    if target is None:
        steps.skip(
            2,
            "Không tìm thấy chat_id: bỏ qua gửi Telegram, vẫn ghi comment và cập nhật trạng thái task",
            detail=f"task {effective_task_id}; đã kiểm tra metadata, JSON nối cuối description, wake payload",
        )
    else:
        effective_chat_id = target["chat_id"]
        effective_message_id = target["message_id"]
        chat_source = target["source"]
        steps.ok(
            2,
            f"Trích xuất thành công: chat_id={effective_chat_id}, message_id={effective_message_id} "
            f"(nguồn: {chat_source})",
        )

    # 3. Đóng gói Payload & Xử lý File đính kèm
    clean_file_path = file_path.strip().strip('"').strip("'")
    file_name = os.path.basename(clean_file_path) if clean_file_path else ""
    download_path = ""
    attachment_id = ""
    upload_error = ""
    lookup_error = ""
    task_attachment_names: list[str] = []
    is_local_file = False

    # BƯỚC 3A: NẾU CÓ FILE TRÊN MÁY, TỰ ĐỘNG UPLOAD LÊN PAPERCLIP
    if clean_file_path:
        is_local_file = os.path.isfile(clean_file_path) or os.path.isfile(os.path.join(os.getcwd(), clean_file_path))
        if not is_local_file:
            steps.info(3, f"File '{clean_file_path}' không có trên máy chạy MCP", ui=True)
        if is_local_file:
            steps.info(3, f"Phát hiện file '{clean_file_path}' trên máy, đang tự động upload lên Paperclip")
            try:
                upload_res = await _upload_file_to_issue(
                    file_path=clean_file_path,
                    issue_id=real_issue_uuid,
                )
                attachment_id = str(upload_res.get("id") or "")
                download_path = upload_res.get("downloadPath") or f"/api/attachments/{attachment_id}/content?download=1"
                file_name = upload_res.get("originalFilename") or file_name
                steps.ok(
                    3,
                    f"Đã tự động upload file '{file_name}' lên Paperclip (attachment {attachment_id[:8]})",
                    detail=f"downloadPath={download_path}",
                )
            except Exception as e:
                upload_error = str(e)
                steps.warn(
                    3,
                    f"Tự động upload file '{file_name}' thất bại: {upload_error[:120]}",
                    detail="Sẽ kiểm tra attachment có sẵn",
                )

        # BƯỚC 3B: NẾU CHƯA CÓ download_path, TÌM ATTACHMENT CÙNG TÊN ĐÃ CÓ TRÊN TASK
        # Chỉ khớp theo tên file. Không khớp thì không đoán (không lấy attachment cuối cùng).
        if not download_path:
            steps.info(3, f"Đang tra cứu attachment '{file_name}' của task trên Paperclip")
            try:
                attachments_res = await _get(f"/issues/{real_issue_uuid}/attachments", headers=req_headers)
                if isinstance(attachments_res, list):
                    task_attachment_names = [
                        str(a.get("originalFilename") or a.get("filename") or "")
                        for a in attachments_res
                        if isinstance(a, dict)
                    ]
                matched = _pick_attachment_by_name(attachments_res, file_name)
                if not matched:
                    steps.warn(3, f"Không có attachment nào tên '{file_name}' trên task")
                if matched:
                    attachment_id = str(matched.get("id") or "")
                    download_path = matched.get("downloadPath") or f"/api/attachments/{attachment_id}/content?download=1"
                    file_name = str(matched.get("originalFilename") or matched.get("filename") or file_name)
                    steps.ok(
                        3,
                        f"Tìm thấy attachment có sẵn '{file_name}' (attachment {attachment_id[:8]})",
                        detail=f"downloadPath={download_path}",
                    )
            except Exception as e:
                lookup_error = str(e)
                steps.warn(3, f"Không thể tra cứu attachment của task: {lookup_error[:120]}")

        # Agent đã yêu cầu gửi file mà không có link tải thì dừng TRƯỚC khi gửi Telegram, để agent
        # sửa đường dẫn và gọi lại, thay vì gửi một tin hứa "đã đính kèm" mà thiếu file.
        if not download_path:
            known = ", ".join(n for n in task_attachment_names[:10] if n) or "(không có)"
            steps.fail(
                3,
                f"Không có file để gửi cho '{clean_file_path}'. "
                f"File trên máy: {'có' if is_local_file else 'không tìm thấy'}"
                + (f"; upload lỗi: {upload_error[:200]}" if upload_error else "")
                + (f"; tra attachment lỗi: {lookup_error[:200]}" if lookup_error else "")
                + f". Attachment hiện có trên task: {known}. "
                "Hướng dẫn khắc phục: truyền file_path là đường dẫn tuyệt đối của file đã ghi ra ổ đĩa "
                "(không tự upload), hoặc để trống file_path nếu chỉ trả lời văn bản.",
            )

    url = os.environ.get(
        "N8N_TELEGRAM_WEBHOOK_URL",
        "http://host.docker.internal:5678/webhook/reply-telegram"
    )

    valid_status = status.lower().strip()
    if valid_status not in ["done", "cancelled", "blocked", "failed"]:
        valid_status = "done"

    if telegram_skipped:
        steps.info(3, "Không có chat_id nên không gửi Webhook sang n8n")
    else:
        payload: dict[str, Any] = {
            "chat_id": effective_chat_id,
            "message_id": effective_message_id,
            "task_id": ancestor_task_id or effective_task_id,
            "run_id": effective_run_id,
            "status": valid_status,
            "message": message.strip(),
            "file_path": clean_file_path,
            "fileName": file_name,
            "downloadPath": download_path,
            "attachmentId": attachment_id,
        }
        if ancestor_task_id:
            # task_id ở trên là task gốc (để n8n xếp hàng đợi); đây là task con thực sự bị block.
            payload["leaf_task_id"] = real_issue_uuid

        steps.info(
            3,
            "Đang gửi Webhook sang n8n",
            detail=f"URL={url} | chat_id={effective_chat_id}, status={valid_status}, downloadPath='{download_path}'",
        )
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                res = await client.post(url, json=payload)
                if res.status_code >= 400:
                    steps.fail(3, f"Webhook n8n báo lỗi HTTP {res.status_code}: {res.text[:300]}")
                steps.ok(3, f"Gửi Webhook sang n8n thành công (HTTP {res.status_code})")
        except ToolError:
            raise
        except Exception as e:
            steps.fail(3, f"Không thể kết nối tới Webhook n8n tại {url}. Lỗi: {e}")

    # 4. Tự động cập nhật trạng thái của Task trên Paperclip sang done/cancelled/blocked (Non-blocking)
    paperclip_status = "done" if valid_status == "done" else ("cancelled" if valid_status in ["cancelled", "failed"] else "blocked")
    steps.info(4, f"Đang cập nhật trạng thái Task '{real_issue_uuid}' sang '{paperclip_status}' trên Paperclip")
    try:
        await _patch(f"/issues/{real_issue_uuid}", {"status": paperclip_status}, headers=req_headers)
        steps.ok(4, f"Đã cập nhật trạng thái task sang '{paperclip_status}' trên Paperclip")
    except Exception as e:
        steps.warn(4, f"Không thể cập nhật trạng thái task trên Paperclip: {str(e)[:120]}")

    # 5. Lưu luôn một Comment báo cáo hoàn chỉnh vào Task trên Paperclip (Non-blocking)
    steps.info(5, f"Đang ghi Comment báo cáo vào Task '{real_issue_uuid}'")
    try:
        comment_body = message.strip()
        if telegram_skipped:
            comment_body += "\n\n_(Không gửi Telegram: task không có chat_id.)_"
        await _post(f"/issues/{real_issue_uuid}/comments", {"body": comment_body}, headers=req_headers)
        steps.ok(5, "Đã ghi comment báo cáo vào task")
    except Exception as e:
        steps.warn(5, f"Không thể ghi comment vào task: {str(e)[:120]}")

    log.info("[finish_task] ================= HOÀN TẤT THÀNH CÔNG CHO TASK %s =================", effective_task_id)
    result: dict[str, Any] = {
        "ok": True,
        "status": "success",
        "chat_id": effective_chat_id,
        "message_id": effective_message_id,
        "chat_source": chat_source,
        "task_id": effective_task_id,
        "run_id": effective_run_id,
        "task_status": paperclip_status,
        "message_sent_to_telegram": not telegram_skipped,
        "telegram_skipped": telegram_skipped,
        "message_preview": message.strip()[:150] + ("..." if len(message.strip()) > 150 else ""),
    }
    if telegram_skipped:
        result["warning"] = (
            "Task không có chat_id nên không gửi Telegram. Task vẫn đã được ghi comment và cập nhật trạng thái."
        )
    return steps.result(result)


# ── UNIVERSAL FILE READER HELPERS & TOOL ──────────────────────────────────────

def _extract_docx_text(file_bytes: bytes) -> str:
    """Extract plain text from a .docx file using standard zipfile and xml parsing."""
    import io
    import zipfile
    import xml.etree.ElementTree as ET

    try:
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as z:
            if "word/document.xml" not in z.namelist():
                return "Không tìm thấy nội dung văn bản trong file docx."
            xml_data = z.read("word/document.xml")
            tree = ET.fromstring(xml_data)
            paragraphs = []
            for p in tree.iter():
                if p.tag.endswith("p"):
                    texts = [node.text for node in p.iter() if node.text and node.tag.endswith("t")]
                    if texts:
                        paragraphs.append("".join(texts))
            return "\n\n".join(paragraphs) if paragraphs else "File .docx không chứa văn bản."
    except Exception as e:
        return f"Lỗi trích xuất DOCX: {e}"


def _extract_xlsx_preview(file_bytes: bytes, max_rows: int = 50) -> str:
    """Extract table preview from .xlsx file using openpyxl or fallback xml parsing."""
    try:
        import openpyxl  # type: ignore[import-untyped]
        import io
        wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True)
        sheet_names = wb.sheetnames
        lines = [f"Danh sách Sheets: {', '.join(sheet_names)}"]
        for name in sheet_names[:3]:
            ws = wb[name]
            lines.append(f"\n--- Sheet: {name} (Tối đa {max_rows} dòng) ---")
            for r_idx, row in enumerate(ws.iter_rows(values_only=True), 1):
                if r_idx > max_rows:
                    lines.append(f"... [Cắt bớt: Còn {ws.max_row - max_rows} dòng nữa] ...")
                    break
                row_str = " | ".join(str(cell) if cell is not None else "" for cell in row)
                lines.append(row_str)
        return "\n".join(lines)
    except ImportError:
        import io
        import zipfile
        try:
            with zipfile.ZipFile(io.BytesIO(file_bytes)) as z:
                sheets = [n for n in z.namelist() if n.startswith("xl/worksheets/sheet")]
                return f"File Excel (.xlsx) hợp lệ. Chứa {len(sheets)} sheets. (Gợi ý: Cài thêm thư viện 'openpyxl' để xem chi tiết dạng bảng)."
        except Exception as e:
            return f"Lỗi đọc file Excel: {e}"


def _extract_pdf_text(file_bytes: bytes, max_pages: int = 20) -> str:
    """Extract text from PDF using pypdf or pdfplumber if installed."""
    try:
        import pypdf  # type: ignore[import-untyped]
        import io
        reader = pypdf.PdfReader(io.BytesIO(file_bytes))
        total_pages = len(reader.pages)
        pages_to_read = min(total_pages, max_pages)
        extracted = []
        for i in range(pages_to_read):
            page_text = reader.pages[i].extract_text() or ""
            extracted.append(f"--- Trang {i + 1}/{total_pages} ---\n{page_text.strip()}")
        if total_pages > max_pages:
            extracted.append(f"... [Cắt bớt: Còn {total_pages - max_pages} trang nữa] ...")
        return "\n\n".join(extracted)
    except ImportError:
        return f"File PDF ({len(file_bytes)} bytes). Cần cài thêm thư viện 'pypdf' để trích xuất văn bản đầy đủ."


def read_any_file(
    file_path_or_content: str | Path | bytes,
    file_name: str = "",
    max_lines: int = 500,
    max_chars: int = 25000,
) -> str:
    """Đọc đa năng tất cả các loại định dạng file (Text, Code, CSV, JSON, DOCX, XLSX, PDF, ZIP...).
    Tự động nhận diện định dạng, xử lý encoding an toàn và giới hạn độ dài token."""
    raw_bytes: bytes = b""

    if isinstance(file_path_or_content, bytes):
        raw_bytes = file_path_or_content
        ext = Path(file_name).suffix.lower() if file_name else ""
    else:
        resolved_path = Path(file_path_or_content)
        if not resolved_path.exists():
            return f"Lỗi: Không tìm thấy file tại '{resolved_path}'"
        if not resolved_path.is_file():
            return f"Lỗi: Đường dẫn '{resolved_path}' là thư mục, không phải file."
        try:
            raw_bytes = resolved_path.read_bytes()
        except Exception as e:
            return f"Lỗi không thể đọc file '{resolved_path}': {e}"
        ext = resolved_path.suffix.lower()
        if not file_name:
            file_name = resolved_path.name

    size_bytes = len(raw_bytes)
    if size_bytes == 0:
        return f"File '{file_name}' rỗng (0 bytes)."

    # 1. Text / Code / Config / Markdown
    text_extensions = {
        ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".xml", ".html",
        ".css", ".js", ".ts", ".py", ".sh", ".ps1", ".bat", ".sql", ".log",
        ".env", ".ini", ".conf", ".diff", ".patch", ".rst", ".svg", ".tex"
    }

    if ext in text_extensions or ext == "":
        for enc in ("utf-8", "utf-8-sig", "latin-1", "cp1252", "utf-16"):
            try:
                text = raw_bytes.decode(enc)
                lines = text.splitlines()
                truncated_lines = lines[:max_lines]
                result = "\n".join(truncated_lines)
                if len(lines) > max_lines:
                    result += f"\n\n... [Đã hiển thị {max_lines}/{len(lines)} dòng] ..."
                if len(result) > max_chars:
                    result = result[:max_chars] + f"\n\n... [Đã cắt bớt ở {max_chars} ký tự] ..."
                return result
            except UnicodeDecodeError:
                continue
        text = raw_bytes.decode("utf-8", errors="replace")
        return text[:max_chars]

    # 2. CSV / TSV
    if ext in {".csv", ".tsv"}:
        import csv
        import io
        delimiter = "\t" if ext == ".tsv" else ","
        try:
            text = raw_bytes.decode("utf-8", errors="replace")
            reader = csv.reader(io.StringIO(text), delimiter=delimiter)
            rows = []
            for idx, row in enumerate(reader):
                if idx >= max_lines:
                    rows.append(f"... [Cắt bớt ở dòng thứ {max_lines}] ...")
                    break
                rows.append(" | ".join(row))
            return "\n".join(rows)
        except Exception as e:
            return f"Lỗi khi đọc file bảng {ext}: {e}"

    # 3. DOCX (Word)
    if ext == ".docx":
        return _extract_docx_text(raw_bytes)

    # 4. XLSX / XLS (Excel)
    if ext in {".xlsx", ".xls"}:
        return _extract_xlsx_preview(raw_bytes, max_rows=max_lines)

    # 5. PDF
    if ext == ".pdf":
        return _extract_pdf_text(raw_bytes)

    # 6. ZIP / TAR Archive
    if ext in {".zip", ".tar", ".gz", ".tgz"}:
        import io
        import zipfile
        import tarfile
        try:
            if ext == ".zip":
                with zipfile.ZipFile(io.BytesIO(raw_bytes)) as z:
                    infos = z.infolist()
                    lines = [f"Kho lưu trữ ZIP ({len(infos)} files/thư mục):"]
                    for info in infos[:100]:
                        lines.append(f" - {info.filename} ({info.file_size} bytes)")
                    if len(infos) > 100:
                        lines.append(f"... [Còn {len(infos) - 100} file nữa]")
                    return "\n".join(lines)
            elif tarfile.is_tarfile(io.BytesIO(raw_bytes)):
                with tarfile.open(fileobj=io.BytesIO(raw_bytes)) as t:
                    names = t.getnames()
                    return f"Kho lưu trữ TAR ({len(names)} files):\n" + "\n".join(f" - {n}" for n in names[:100])
        except Exception as e:
            return f"Lỗi khi kiểm tra kho lưu trữ {ext}: {e}"

    # 7. Binary / Image fallback
    mime, _ = mimetypes.guess_type(file_name)
    import hashlib
    file_hash = hashlib.sha256(raw_bytes).hexdigest()[:16]
    return (
        f"[File nhị phân: '{file_name}']\n"
        f"- Kích thước: {size_bytes} bytes ({size_bytes / 1024:.1f} KB)\n"
        f"- MIME Type: {mime or 'application/octet-stream'}\n"
        f"- SHA256 Checksum: {file_hash}...\n"
        f"Lưu ý: Không thể hiển thị nội dung dạng text thô cho định dạng này."
    )


async def _download_attachment_content(
    attachment_ref: str,
) -> tuple[bytes, str]:
    """Tải nội dung file đính kèm từ Paperclip Server dựa vào UUID hoặc URL."""
    ref = attachment_ref.strip()
    req_headers = _headers()

    if ref.startswith("http://") or ref.startswith("https://"):
        download_url = ref
    elif ref.startswith("/api/"):
        clean_path = ref[len("/api"):]
        download_url = f"{_get_base_url()}{clean_path}"
    elif "/attachments/" in ref:
        download_url = f"{_get_base_url()}{ref}" if not ref.startswith("http") else ref
    else:
        download_url = f"{_get_base_url()}/attachments/{ref}/content"

    async with httpx.AsyncClient(timeout=45.0) as client:
        r = await client.get(download_url, headers=req_headers)
        r.raise_for_status()
        cd = r.headers.get("content-disposition", "")
        file_name = ""
        if "filename=" in cd:
            import re
            m = re.search(r'filename=["\']?([^"\';]+)["\']?', cd)
            if m:
                file_name = m.group(1).strip()
        if not file_name:
            file_name = ref.split("/")[-1].split("?")[0] or "attachment_file"
        return r.content, file_name


@mcp.tool()
async def read_file_universal(
    file_path: str,
    max_lines: int = 500,
    max_chars: int = 25000,
) -> str:
    """Đọc nội dung đa năng của MỌI định dạng file (Text, Code, Markdown, CSV, Excel, Word, PDF, JSON, Zip...).
    
    Hỗ trợ đọc cả file trên ổ đĩa local lẫn file đính kèm trên Paperclip Server:
    - Text/Code (.py, .js, .txt, .md, .json, .yaml, .sql...): Đọc toàn bộ nội dung với encoding tự động.
    - Bảng tính (.csv, .tsv): Bóc tách và định dạng xem trước theo dòng bảng.
    - Word (.docx): Tự động trích xuất tất cả các đoạn văn bản trong tài liệu.
    - Excel (.xlsx): Xem danh sách sheet và nội dung bảng biểu.
    - PDF (.pdf): Trích xuất văn bản từ các trang.
    - File nén (.zip, .tar): Hiển thị danh sách tệp bên trong.
    - File ảnh/nhị phân (.png, .jpg, .bin): Trả về thông số metadata an toàn, không làm hỏng context.
    - Đính kèm Paperclip: Nếu truyền attachment UUID hoặc URL download, tool tự động tải về và đọc.

    Args:
        file_path: Đường dẫn file trên ổ đĩa local, HOẶC UUID đính kèm, HOẶC URL download.
        max_lines: Số dòng tối đa cần đọc (mặc định: 500 dòng).
        max_chars: Số ký tự tối đa để tránh tràn context LLM (mặc định: 25000 ký tự).
    """
    cleaned_path = file_path.strip().strip('"').strip("'")
    if not cleaned_path:
        return "Lỗi: Tham số file_path không được để trống."

    is_server_attachment = (
        cleaned_path.startswith("http://")
        or cleaned_path.startswith("https://")
        or "/attachments/" in cleaned_path
        or (len(cleaned_path) == 36 and "-" in cleaned_path and not Path(cleaned_path).exists())
    )

    if is_server_attachment:
        try:
            raw_bytes, file_name = await _download_attachment_content(cleaned_path)
            return read_any_file(raw_bytes, file_name=file_name, max_lines=max_lines, max_chars=max_chars)
        except Exception as e:
            return f"Lỗi không thể tải file đính kèm từ Paperclip Server ({cleaned_path}): {e}"

    return read_any_file(cleaned_path, max_lines=max_lines, max_chars=max_chars)


@mcp.tool()
async def get_recent_tasks_by_chat(
    chat_id: int | str = 0,
    limit: int = 3,
) -> Any:
    """Tra cứu danh sách các Task gần nhất của người dùng Telegram (chat_id) trên Paperclip.
    Giúp Agent khôi phục ngữ cảnh hội thoại, xem các kết quả đã làm và danh sách file đính kèm cũ.

    Args:
        chat_id: Telegram Chat ID cần tra cứu (mặc định nếu để 0 sẽ tự tìm từ metadata/task hiện tại).
        limit: Số lượng task gần nhất cần lấy (mặc định: 3, tối đa: 10).
    """
    req_headers = _headers()
    cid = _get_company_id()
    if not cid:
        return _err("PAPERCLIP_COMPANY_ID is not configured.")

    issues_res = await _get(f"/companies/{cid}/issues", headers=req_headers)
    if isinstance(issues_res, dict) and issues_res.get("isError"):
        return issues_res

    all_issues = issues_res if isinstance(issues_res, list) else (issues_res.get("items", []) if isinstance(issues_res, dict) else [])
    target_chat_str = str(chat_id).strip() if chat_id and str(chat_id).strip() != "0" else ""
    matched_issues = []

    for issue in all_issues:
        if not isinstance(issue, dict):
            continue
        meta = issue.get("metadata") or {}
        desc = issue.get("description") or ""

        if target_chat_str:
            meta_str = json.dumps(meta) if isinstance(meta, dict) else str(meta)
            if target_chat_str not in meta_str and target_chat_str not in desc:
                continue

        matched_issues.append(issue)

    matched_issues.sort(key=lambda x: str(x.get("createdAt", "")), reverse=True)
    selected = matched_issues[:max(1, min(limit, 10))]

    summarized_tasks = []
    for issue in selected:
        issue_id = issue.get("id")
        ident = issue.get("identifier") or issue_id
        title = issue.get("title")
        status = issue.get("status")
        created_at = issue.get("createdAt")

        attachments_info = []
        try:
            att_res = await _get(f"/issues/{issue_id}/attachments", headers=req_headers)
            if isinstance(att_res, list):
                for a in att_res:
                    if isinstance(a, dict):
                        attachments_info.append({
                            "id": a.get("id"),
                            "filename": a.get("filename"),
                            "contentType": a.get("contentType"),
                            "downloadPath": a.get("downloadPath") or f"/api/attachments/{a.get('id')}/content",
                        })
        except Exception:
            pass

        last_comment = ""
        try:
            comments_res = await _get(f"/issues/{issue_id}/comments", headers=req_headers)
            if isinstance(comments_res, list) and comments_res:
                last_comment = str(comments_res[-1].get("body") or "")
        except Exception:
            pass

        summarized_tasks.append({
            "task_id": issue_id,
            "identifier": ident,
            "title": title,
            "status": status,
            "created_at": created_at,
            "attachments": attachments_info,
            "last_comment_preview": last_comment[:300] + ("..." if len(last_comment) > 300 else ""),
        })

    return {
        "status": "success",
        "chat_id": chat_id,
        "count": len(summarized_tasks),
        "tasks": summarized_tasks,
    }


# ── PROMPTS ────────────────────────────────────────────────────────────────────

@mcp.prompt("paperclip-assistant")
def paperclip_assistant() -> str:
    """Prompt for Paperclip AI Assistants."""
    return "You are an AI assistant orchestrating Paperclip issues. Use the provided tools to manage issues, agents, and goals."


# ── TEST TOOL ──────────────────────────────────────────────────────────────────

@mcp.tool()
async def test_paperclip_sync() -> str:
    """Test Tool to verify that Paperclip synchronizes new MCP tools immediately."""
    return "The MCP sync is working! You can see this tool in Paperclip."


# ── RESOURCES ──────────────────────────────────────────────────────────────────

@mcp.resource("paperclip://docs/guidelines")
def get_guidelines() -> str:
    """Paperclip Guidelines Resource."""
    return "These are the default guidelines for Paperclip issue orchestration."


# ── ENTRY POINT ────────────────────────────────────────────────────────────────

def main() -> None:
    """CLI entry point — invoked via `paperclip-mcp` or `python -m paperclip_mcp`."""
    import argparse

    parser = argparse.ArgumentParser(
        prog="paperclip-mcp",
        description="MCP server for the Paperclip AI agent orchestration platform.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind address. Use 0.0.0.0 only in trusted local networks.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=9011,
        help="Bind port.",
    )
    parser.add_argument(
        "--transport",
        default="stdio",
        choices=["streamable-http", "sse", "stdio"],
        help=(
            # ASCII: argparse in help ra console Windows (cp1252), ký tự tiếng Việt làm --help lỗi.
            "MCP transport protocol. Default 'stdio': each Codex session gets its own MCP process "
            "with that run's environment. 'streamable-http'/'sse' share one process, so per-agent "
            "identity cannot be told apart."
        ),
    )
    args = parser.parse_args()

    if args.transport == "stdio":
        mcp.run(transport="stdio")
    else:
        log.warning(
            "Transport %s dùng một tiến trình chung: API key/run id/company id lấy từ env của "
            "tiến trình này, không phân biệt từng agent. Dùng --transport stdio cho Codex.",
            args.transport,
        )
        # Thêm stateless_http=True để cho phép Paperclip gọi kiểm tra trực tiếp
        mcp.run(transport=args.transport, host=args.host, port=args.port, stateless_http=True)



if __name__ == "__main__":
    main()

import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_INPUT_LOG_CHARS,
  MAX_TOOL_OUTPUT_LOG_CHARS,
  ToolOutputCarry,
  isEmptyToolUpdate,
  redactToolOutput,
  summarizeToolInputForLog,
  summarizeToolOutputForLog,
} from "./tool-output.js";
import { parseAcpxStdoutLine } from "./ui.js";

describe("summarizeToolOutputForLog", () => {
  it("lấy lỗi MCP từ content dạng ACP", () => {
    const output = summarizeToolOutputForLog({
      text: "tool call (failed)",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "1 validation error for call[list_issues]\napi_key\n  Unexpected keyword argument",
          },
        },
      ],
    });
    expect(output).toContain("Unexpected keyword argument");
    expect(output).toContain("list_issues");
  });

  it("lấy lỗi từ rawOutput dạng chuỗi và dạng object", () => {
    expect(summarizeToolOutputForLog({ rawOutput: "HTTP 403 Agent key cannot access another company" })).toContain(
      "HTTP 403",
    );
    expect(summarizeToolOutputForLog({ rawOutput: { error: "Missing companyId in path" } })).toBe(
      "Missing companyId in path",
    );
    expect(summarizeToolOutputForLog({ rawOutput: { code: 7, detail: "x" } })).toContain('"code":7');
  });

  it("giữ cả content và rawOutput khi khác nhau, không lặp khi trùng", () => {
    expect(
      summarizeToolOutputForLog({ rawOutput: "raw", content: [{ type: "text", text: "from content" }] }),
    ).toBe("from content\nraw");
    expect(
      summarizeToolOutputForLog({
        rawOutput: { formatted_output: "line 1\nline 2" },
        content: [{ type: "content", content: { type: "text", text: "line 1\nline 2" } }],
      }),
    ).toBe("line 1\nline 2");
  });

  it("output lệnh shell: exit code, output chính và stderr", () => {
    const output = summarizeToolOutputForLog({
      rawOutput: { exit_code: 1, formatted_output: "Get-Item: không tìm thấy", stderr: "Access denied" },
    });
    expect(output).toBe("Exit code: 1\nGet-Item: không tìm thấy\nstderr: Access denied");
  });

  it("file tạo mới: đường dẫn, số dòng và trích nội dung", () => {
    const output = summarizeToolOutputForLog({
      text: "tool call (completed)",
      content: [{ type: "diff", path: "C:/ws/nhan_xet.md", oldText: null, newText: "# Nhận xét\n\n## 1. Tóm tắt\n" }],
    });
    expect(output).toBe("Tạo file: C:/ws/nhan_xet.md (3 dòng)\n# Nhận xét\n\n## 1. Tóm tắt");
  });

  it("file bị sửa: số dòng trước/sau, dòng thêm và dòng bớt", () => {
    const output = summarizeToolOutputForLog({
      content: [{ type: "diff", path: "a.md", oldText: "dòng 1\ndòng 2\n", newText: "dòng 1\ndòng 2 mới\ndòng 3\n" }],
    });
    expect(output).toContain("Sửa file: a.md (2 → 3 dòng, +2 −1)");
    expect(output).toContain("- dòng 2");
    expect(output).toContain("+ dòng 2 mới");
    expect(output).toContain("+ dòng 3");
  });

  it("file mới quá dài chỉ trích phần đầu và ghi số dòng còn lại", () => {
    const newText = Array.from({ length: 100 }, (_, i) => `dòng ${i + 1}`).join("\n");
    const output = summarizeToolOutputForLog({ content: [{ type: "diff", path: "big.md", newText }] });
    expect(output).toContain("Tạo file: big.md (100 dòng)");
    expect(output).toContain("dòng 60");
    expect(output).not.toContain("dòng 61\n");
    expect(output).toContain("[còn 40 dòng]");
  });

  it("vị trí file chỉ thêm khi chưa có trong nội dung", () => {
    expect(summarizeToolOutputForLog({ locations: [{ path: "C:/x/a.md", line: 3 }] })).toBe("Vị trí: C:/x/a.md:3");
    const withDiff = summarizeToolOutputForLog({
      content: [{ type: "diff", path: "C:/x/a.md", newText: "x" }],
      locations: [{ path: "C:/x/a.md" }],
    });
    expect(withDiff.match(/C:\/x\/a\.md/g)?.length).toBe(1);
  });

  it("terminal chỉ có id", () => {
    expect(summarizeToolOutputForLog({ content: [{ type: "terminal", terminalId: "term-1" }] })).toBe("Terminal: term-1");
  });

  it("trả chuỗi rỗng khi không có gì để thêm", () => {
    expect(summarizeToolOutputForLog({ text: "tool call (failed)" })).toBe("");
    expect(summarizeToolOutputForLog({ rawOutput: "   ", content: [] })).toBe("");
    expect(summarizeToolOutputForLog({ content: [{ type: "image" }, "x", null] })).toBe("");
  });

  it("không lặp lại nội dung đã nằm sẵn trong text", () => {
    expect(
      summarizeToolOutputForLog({ text: "Read file (completed): hello", rawOutput: "hello" }),
    ).toBe("");
  });

  it("cắt ngắn output quá dài và ghi số ký tự bị cắt", () => {
    const long = "a".repeat(MAX_TOOL_OUTPUT_LOG_CHARS + 500);
    const output = summarizeToolOutputForLog({ rawOutput: long });
    expect(output.startsWith("a".repeat(MAX_TOOL_OUTPUT_LOG_CHARS))).toBe(true);
    expect(output).toContain("[đã cắt 500 ký tự]");
  });
});

describe("summarizeToolInputForLog", () => {
  it("tham số tool MCP được ghi lại, đã che secret", () => {
    const args = summarizeToolInputForLog({
      server: "paperclip",
      tool: "finish_task_and_reply_telegram",
      arguments: { status: "cancelled", file_path: "", api_key: "supersecretvalue123" },
    });
    expect(args).toContain('"status":"cancelled"');
    expect(args).not.toContain("supersecretvalue123");
  });

  it("đầu vào rỗng của tool Codex trả chuỗi rỗng", () => {
    expect(summarizeToolInputForLog({})).toBe("");
    expect(summarizeToolInputForLog("{}")).toBe("");
    expect(summarizeToolInputForLog([])).toBe("");
    expect(summarizeToolInputForLog(undefined)).toBe("");
    expect(summarizeToolInputForLog(null)).toBe("");
  });

  it("chuỗi lệnh được giữ nguyên, quá dài thì cắt", () => {
    expect(summarizeToolInputForLog("Get-ChildItem C:/ws")).toBe("Get-ChildItem C:/ws");
    const long = summarizeToolInputForLog("x".repeat(MAX_TOOL_INPUT_LOG_CHARS + 10));
    expect(long).toContain("[đã cắt 10 ký tự]");
  });
});

describe("redactToolOutput", () => {
  it("che Bearer token, JWT và khóa sk-", () => {
    const jwt = "eyJhbGciOiJub25lIn0.eyJydW5faWQiOiJhYmMifQ.signaturepart";
    const text = `Authorization: Bearer abcdef1234567890xyz và ${jwt} và sk-0123456789abcdefghij`;
    const redacted = redactToolOutput(text);
    expect(redacted).not.toContain("abcdef1234567890xyz");
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain("sk-0123456789abcdefghij");
    expect(redacted).toContain("Bearer ***");
    expect(redacted).toContain("***JWT***");
    expect(redacted).toContain("sk-***");
  });

  it("che giá trị api_key và password trong JSON", () => {
    const redacted = redactToolOutput('{"api_key":"supersecretvalue","password":"hunter2hunter2","name":"ok"}');
    expect(redacted).not.toContain("supersecretvalue");
    expect(redacted).not.toContain("hunter2hunter2");
    expect(redacted).toContain('"name":"ok"');
  });

  it("giữ nguyên văn bản thường", () => {
    expect(redactToolOutput("Không tìm thấy file bao_cao.md")).toBe("Không tìm thấy file bao_cao.md");
  });
});

describe("parseAcpxStdoutLine với output của tool", () => {
  const line = (payload: Record<string, unknown>) => JSON.stringify({ type: "acpx.tool_call", ...payload });

  it("giữ nguyên nội dung cũ khi không có output", () => {
    const entries = parseAcpxStdoutLine(
      line({ name: "mcp.paperclip.list_issues", toolCallId: "t1", status: "failed", text: "tool call (failed)" }),
      "2026-10-15T00:00:00Z",
    );
    const result = entries.find((entry) => entry.kind === "tool_result");
    expect(result).toMatchObject({ kind: "tool_result", content: "tool call (failed)", isError: true });
  });

  it("nối thêm output sau nội dung cũ, không thay thế", () => {
    const entries = parseAcpxStdoutLine(
      line({
        name: "mcp.paperclip.list_issues",
        toolCallId: "t1",
        status: "failed",
        text: "tool call (failed)",
        output: "[LỖI MCP [HTTP 403]] Agent key cannot access another company",
      }),
      "2026-10-15T00:00:00Z",
    );
    const call = entries.find((entry) => entry.kind === "tool_call");
    const result = entries.find((entry) => entry.kind === "tool_result");
    expect(call).toMatchObject({ kind: "tool_call", name: "mcp.paperclip.list_issues" });
    expect(result).toMatchObject({ kind: "tool_result", isError: true });
    expect((result as { content: string }).content).toBe(
      "tool call (failed)\n[LỖI MCP [HTTP 403]] Agent key cannot access another company",
    );
  });

  it("args và kind được nối thêm vào input, không bỏ text/status", () => {
    const entries = parseAcpxStdoutLine(
      line({
        name: "mcp.paperclip.finish_task_and_reply_telegram",
        toolCallId: "t3",
        status: "in_progress",
        text: "mcp.paperclip.finish_task_and_reply_telegram (in_progress)",
        kind: "other",
        args: '{"arguments":{"status":"cancelled"}}',
      }),
      "2026-10-15T00:00:00Z",
    );
    const call = entries.find((entry) => entry.kind === "tool_call") as { input: Record<string, unknown> };
    expect(call.input).toEqual({
      text: "mcp.paperclip.finish_task_and_reply_telegram (in_progress)",
      status: "in_progress",
      kind: "other",
      args: '{"arguments":{"status":"cancelled"}}',
    });
  });

  it("tool đang chạy (in_progress) không sinh tool_result", () => {
    const entries = parseAcpxStdoutLine(
      line({ name: "x", toolCallId: "t2", status: "in_progress", text: "x (in_progress)", output: "partial" }),
      "2026-10-15T00:00:00Z",
    );
    expect(entries.some((entry) => entry.kind === "tool_result")).toBe(false);
  });
});

describe("isEmptyToolUpdate (dữ liệu thật từ file debug)", () => {
  it("cập nhật rỗng 'tool call' bị coi là rỗng", () => {
    expect(
      isEmptyToolUpdate({
        type: "tool_call",
        text: "tool call",
        tag: "tool_call_update",
        title: "tool call",
        toolCallId: "exec-177f8a08",
      }),
    ).toBe(true);
  });

  it("không bỏ sự kiện bắt đầu, sự kiện có trạng thái hoặc có dữ liệu", () => {
    expect(isEmptyToolUpdate({ tag: "tool_call", title: "Read file 'a.md'", toolCallId: "x" })).toBe(false);
    expect(isEmptyToolUpdate({ tag: "tool_call_update", title: "tool call", status: "completed" })).toBe(false);
    expect(isEmptyToolUpdate({ tag: "tool_call_update", title: "tool call", rawOutput: { exit_code: 0 } })).toBe(false);
    expect(isEmptyToolUpdate({ tag: "tool_call_update", title: "tool call", content: [] })).toBe(false);
    expect(isEmptyToolUpdate({ tag: "tool_call_update", title: "Guardian Review" })).toBe(false);
  });
});

describe("ToolOutputCarry", () => {
  it("tạo file: diff ở sự kiện bắt đầu được gắn vào sự kiện completed trống", () => {
    const carry = new ToolOutputCarry();
    const started = summarizeToolOutputForLog({
      content: [
        {
          path: "C:\ws\technical-document-review.md",
          oldText: null,
          newText: "# Báo cáo tổng quan và nhận xét\n\n## 1. Phạm vi tài liệu\n",
          _meta: { kind: "add" },
          type: "diff",
        },
      ],
    });
    expect(carry.resolve("exec-2b14", "in_progress", started)).toBe(started);
    const completed = carry.resolve("exec-2b14", "completed", "");
    expect(completed).toContain("Tạo file: C:\ws\technical-document-review.md (3 dòng)");
    expect(completed).toContain("# Báo cáo tổng quan và nhận xét");
  });

  it("lệnh shell: output lúc kết thúc thay cho terminal id lúc bắt đầu", () => {
    const carry = new ToolOutputCarry();
    carry.resolve("exec-bfba", "in_progress", "Terminal: exec-bfba");
    const done = summarizeToolOutputForLog({ rawOutput: { formatted_output: '{ "Count": 0 }', exit_code: 0 } });
    expect(carry.resolve("exec-bfba", "completed", done)).toBe('Exit code: 0\n{ "Count": 0 }');
  });

  it("đọc file: output kết thúc thay cho vị trí lúc bắt đầu", () => {
    const carry = new ToolOutputCarry();
    carry.resolve("exec-177f", "in_progress", "Vị trí: C:\skills\SKILL.md");
    expect(carry.resolve("exec-177f", "completed", "---\nname: paperclip")).toBe("---\nname: paperclip");
  });

  it("không trộn output giữa các tool call và xoá sau khi kết thúc", () => {
    const carry = new ToolOutputCarry();
    carry.resolve("a", "in_progress", "Tạo file: a.md (1 dòng)\nx");
    expect(carry.resolve("b", "completed", "")).toBe("");
    expect(carry.resolve("a", "completed", "")).toBe("Tạo file: a.md (1 dòng)\nx");
    expect(carry.resolve("a", "completed", "")).toBe("");
  });

  it("không có toolCallId thì trả nguyên output", () => {
    expect(new ToolOutputCarry().resolve(undefined, "completed", "abc")).toBe("abc");
  });
});

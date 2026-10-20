/**
 * Thông tin chi tiết của một tool call ACP (đầu vào, kết quả, file bị sửa), để ghi THÊM vào log
 * của run. Áp dụng cho mọi tool: tool MCP, lệnh shell, đọc file, sửa/tạo file của Codex.
 *
 * acpx đã chuyển tiếp `rawInput`, `rawOutput`, `content`, `locations` trên mỗi sự kiện tool_call,
 * nhưng dòng log `acpx.tool_call` trước đây chỉ mang `text` (ví dụ "tool call (completed)") nên
 * người xem transcript không trace được agent đã làm gì. Các hàm ở đây gom những trường đó thành
 * chuỗi ngắn, đã che secret, để ghi thêm vào log (không thay thế các trường hiện có).
 */

export const MAX_TOOL_OUTPUT_LOG_CHARS = 4000;
export const MAX_TOOL_INPUT_LOG_CHARS = 2000;
export const MAX_DIFF_EXCERPT_LINES = 60;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "***JWT***"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-***"],
  [
    /("?(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)"?\s*[:=]\s*)"?[^\s",}]{6,}"?/gi,
    "$1***",
  ],
];

// Khoá thường chứa nội dung kết quả của lệnh/tool, theo thứ tự ưu tiên.
const OUTPUT_TEXT_KEYS = [
  "formatted_output",
  "aggregated_output",
  "output",
  "stdout",
  "text",
  "message",
  "error",
  "content",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Đếm dòng thêm/bớt theo multiset (gần đúng, đủ để trace; không phải diff đầy đủ). */
function changedLines(oldLines: string[], newLines: string[]): { added: string[]; removed: string[] } {
  const remaining = new Map<string, number>();
  for (const line of oldLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of newLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added.push(line);
  }
  const removed: string[] = [];
  for (const [line, count] of remaining) {
    for (let i = 0; i < count; i += 1) removed.push(line);
  }
  return { added, removed };
}

function describeDiff(item: Record<string, unknown>): string {
  const path = typeof item.path === "string" ? item.path : "(không rõ đường dẫn)";
  const newText = typeof item.newText === "string" ? item.newText : "";
  const oldText = typeof item.oldText === "string" ? item.oldText : null;
  const newLines = splitLines(newText);

  if (oldText === null || oldText === "") {
    const excerpt = newLines.slice(0, MAX_DIFF_EXCERPT_LINES);
    const more = newLines.length > excerpt.length ? `\n[còn ${newLines.length - excerpt.length} dòng]` : "";
    return `Tạo file: ${path} (${newLines.length} dòng)\n${excerpt.join("\n")}${more}`;
  }

  const oldLines = splitLines(oldText);
  const { added, removed } = changedLines(oldLines, newLines);
  const body = [...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)];
  const excerpt = body.slice(0, MAX_DIFF_EXCERPT_LINES);
  const more = body.length > excerpt.length ? `\n[còn ${body.length - excerpt.length} dòng thay đổi]` : "";
  return (
    `Sửa file: ${path} (${oldLines.length} → ${newLines.length} dòng, +${added.length} −${removed.length})` +
    (excerpt.length ? `\n${excerpt.join("\n")}${more}` : "")
  );
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "diff") {
      parts.push(describeDiff(item));
      continue;
    }
    if (item.type === "terminal") {
      if (typeof item.terminalId === "string") parts.push(`Terminal: ${item.terminalId}`);
      continue;
    }
    // Dạng ACP: { type: "content", content: { type: "text", text } } hoặc { type: "text", text }.
    const inner = isRecord(item.content) ? item.content : item;
    const text = inner.text;
    if (typeof text === "string" && text.trim()) {
      parts.push(text);
    } else if (typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

function textFromRawOutput(rawOutput: unknown): string {
  if (typeof rawOutput === "string" || typeof rawOutput === "number" || typeof rawOutput === "boolean") {
    return String(rawOutput);
  }
  if (Array.isArray(rawOutput)) return stringifyValue(rawOutput);
  if (!isRecord(rawOutput)) return "";

  const parts: string[] = [];
  const exitCode = rawOutput.exit_code ?? rawOutput.exitCode;
  if (typeof exitCode === "number" || typeof exitCode === "string") parts.push(`Exit code: ${exitCode}`);

  let mainText = "";
  for (const key of OUTPUT_TEXT_KEYS) {
    const candidate = rawOutput[key];
    if (typeof candidate === "string" && candidate.trim()) {
      mainText = candidate;
      break;
    }
  }
  const stderr = typeof rawOutput.stderr === "string" ? rawOutput.stderr.trim() : "";

  if (mainText) parts.push(mainText);
  if (stderr && !mainText.includes(stderr)) parts.push(`stderr: ${stderr}`);
  if (!mainText && !stderr) return [...parts, stringifyValue(rawOutput)].join("\n");
  return parts.join("\n");
}

function textFromLocations(locations: unknown): string {
  if (!Array.isArray(locations)) return "";
  const paths = locations
    .filter(isRecord)
    .map((loc) => {
      const path = typeof loc.path === "string" ? loc.path : "";
      if (!path) return "";
      return typeof loc.line === "number" ? `${path}:${loc.line}` : path;
    })
    .filter(Boolean);
  return paths.length ? `Vị trí: ${paths.join(", ")}` : "";
}

export function redactToolOutput(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function truncateToolOutput(text: string, limit = MAX_TOOL_OUTPUT_LOG_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[đã cắt ${text.length - limit} ký tự]`;
}

/**
 * Nội dung kết quả của tool (output lệnh, nội dung file đã đọc, file đã sửa/tạo, lỗi), đã che
 * secret và cắt ngắn. Trả "" khi sự kiện không có gì để thêm hoặc nội dung đã nằm sẵn trong `text`.
 */
export function summarizeToolOutputForLog(event: {
  rawOutput?: unknown;
  content?: unknown;
  locations?: unknown;
  text?: unknown;
}): string {
  const fromContent = textFromContent(event.content).trim();
  const fromRaw = textFromRawOutput(event.rawOutput).trim();

  const parts: string[] = [];
  // Lệnh shell thường gửi cùng một output ở cả content và rawOutput: giữ bản đầy đủ hơn.
  if (fromContent && fromRaw) {
    if (fromRaw.includes(fromContent)) parts.push(fromRaw);
    else if (fromContent.includes(fromRaw)) parts.push(fromContent);
    else parts.push(fromContent, fromRaw);
  } else if (fromContent || fromRaw) {
    parts.push(fromContent || fromRaw);
  }

  // Vị trí file (đọc/sửa) chỉ thêm khi chưa xuất hiện trong nội dung ở trên.
  const location = textFromLocations(event.locations);
  if (location) {
    const joined = parts.join("\n");
    const paths = location.slice("Vị trí: ".length).split(", ");
    if (!paths.every((p) => joined.includes(p))) parts.push(location);
  }

  const candidate = parts.join("\n").trim();
  if (!candidate) return "";

  const redacted = redactToolOutput(candidate);
  const existing = typeof event.text === "string" ? event.text : "";
  if (existing && existing.includes(redacted)) return "";
  return truncateToolOutput(redacted);
}

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TOOL_PAYLOAD_KEYS = ["rawInput", "rawOutput", "content", "locations"] as const;

/**
 * Sự kiện cập nhật tool không mang thông tin gì: không trạng thái, không tiêu đề riêng, không
 * input/output/content/locations. codex-acp gửi hàng loạt sự kiện như vậy khi lệnh đang chạy
 * (ví dụ 24 dòng "tool call" cho một lần đọc file); ghi chúng vào log chỉ thêm rác.
 */
export function isEmptyToolUpdate(event: Record<string, unknown>): boolean {
  if (event.tag !== "tool_call_update") return false;
  if (typeof event.status === "string" && event.status.trim()) return false;
  const title = typeof event.title === "string" ? event.title.trim() : "";
  if (title && title !== "tool call") return false;
  return TOOL_PAYLOAD_KEYS.every((key) => event[key] === undefined);
}

/**
 * Mang output của sự kiện đang chạy sang sự kiện kết thúc của cùng tool call.
 *
 * Sửa/tạo file: nội dung diff chỉ có ở sự kiện bắt đầu, sự kiện `completed` trống. Giao diện chỉ
 * hiện output ở dòng kết quả, nên phải giữ lại output trước đó cho tới khi tool kết thúc.
 */
export class ToolOutputCarry {
  private readonly pending = new Map<string, string>();

  resolve(toolCallId: string | undefined, status: string | undefined, output: string): string {
    if (!toolCallId) return output;
    const terminal = typeof status === "string" && TERMINAL_TOOL_STATUSES.has(status);
    if (!terminal) {
      if (output) this.pending.set(toolCallId, output);
      return output;
    }
    const carried = this.pending.get(toolCallId) ?? "";
    this.pending.delete(toolCallId);
    if (!output) return carried;
    // Output lúc bắt đầu chỉ là vị trí/terminal id thì output kết thúc đã đủ; nếu là diff thì giữ cả hai.
    if (carried && /^(Tạo file|Sửa file): /m.test(carried) && !output.includes(carried)) {
      return `${carried}\n${output}`;
    }
    return output;
  }
}

/**
 * Đầu vào của tool (tham số tool MCP, lệnh...), đã che secret và cắt ngắn. Trả "" khi không có
 * (codex-acp gửi `{}` cho các tool nội bộ của Codex; lệnh của chúng nằm trong tiêu đề).
 */
export function summarizeToolInputForLog(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) return "";
  let text = "";
  if (typeof rawInput === "string") {
    text = rawInput.trim();
    if (text === "{}" || text === "[]" || text === '""') return "";
  } else if (isRecord(rawInput)) {
    if (Object.keys(rawInput).length === 0) return "";
    text = stringifyValue(rawInput);
  } else if (Array.isArray(rawInput)) {
    if (rawInput.length === 0) return "";
    text = stringifyValue(rawInput);
  } else {
    text = stringifyValue(rawInput);
  }
  if (!text) return "";
  return truncateToolOutput(redactToolOutput(text), MAX_TOOL_INPUT_LOG_CHARS);
}

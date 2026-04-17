/**
 * Tool-call helpers: icon lookup + one-line summary extraction.
 *
 * ACP tool-call completions carry their payload in either the typed
 * `content[]` array or the free-form `rawOutput` field. This module picks
 * whichever is available, pulls a single usable string out of it, and
 * truncates it for inline rendering next to the tool name.
 */

import type { ToolCallContentText, ToolKind } from "./types.js";
import { KIND_ICONS, TOOL_SUMMARY_MAX_LEN } from "./types.js";

export function kindIcon(kind: ToolKind | undefined): string {
  return kind ? (KIND_ICONS[kind] ?? "🔧") : "🔧";
}

/**
 * Pull a single-line summary out of a tool-call completion payload.
 * Looks at `content[0].text` first (structured), then falls back to
 * `rawOutput` (stringified). Returns null if nothing usable.
 */
export function extractToolSummary(
  content: ToolCallContentText[] | null | undefined,
  rawOutput: unknown,
): string | null {
  const fromContent = extractFromContent(content);
  if (fromContent) return truncateOneLine(fromContent);
  const fromRaw = extractFromRaw(rawOutput);
  if (fromRaw) return truncateOneLine(fromRaw);
  return null;
}

function extractFromContent(content: ToolCallContentText[] | null | undefined): string | null {
  if (!content || content.length === 0) return null;
  for (const entry of content) {
    const direct = typeof entry?.text === "string" ? entry.text : undefined;
    if (direct) return direct;
    const nested = entry?.content?.text;
    if (typeof nested === "string" && nested) return nested;
  }
  return null;
}

function extractFromRaw(rawOutput: unknown): string | null {
  if (rawOutput == null) return null;
  if (typeof rawOutput === "string") return rawOutput;
  if (typeof rawOutput === "number" || typeof rawOutput === "boolean") {
    return String(rawOutput);
  }
  if (typeof rawOutput === "object") {
    const r = rawOutput as { output?: unknown; text?: unknown; message?: unknown };
    for (const v of [r.output, r.text, r.message]) {
      if (typeof v === "string" && v) return v;
    }
    try {
      return JSON.stringify(rawOutput);
    } catch {
      return null;
    }
  }
  return null;
}

function truncateOneLine(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= TOOL_SUMMARY_MAX_LEN) return oneLine;
  return oneLine.slice(0, TOOL_SUMMARY_MAX_LEN - 1) + "…";
}

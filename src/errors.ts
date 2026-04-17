/**
 * Error normalization for channel plugins.
 *
 * Every plugin had an ad-hoc ladder that tried `instanceof Error`, then
 * `typeof error === "object"`, then fell back to `String(error)`. That
 * ladder lived in five slightly-different forms across bot.ts files and
 * drifted over time. Centralize it here.
 */

/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Handles JSON-RPC error shapes (`{ code, message, data }`) by flattening
 * `data` into the output so users see real causes instead of just
 * "Internal error". Prefers `Error.message`, falls back to a non-circular
 * JSON stringify for objects, and finally to `String(e)` for primitives.
 */
export function extractErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;

  if (e instanceof Error) {
    const parts: string[] = [e.message];
    const data = (e as unknown as { data?: unknown }).data;
    const detail = formatDetail(data);
    if (detail) parts.push(detail);
    const cause = (e as unknown as { cause?: unknown }).cause;
    if (cause && cause !== e) {
      const c = extractErrorMessage(cause);
      if (c && c !== e.message) parts.push(`cause: ${c}`);
    }
    return parts.join("\n");
  }

  if (e && typeof e === "object") {
    const obj = e as {
      message?: unknown;
      code?: unknown;
      data?: unknown;
    };
    const parts: string[] = [];
    if (typeof obj.message === "string" && obj.message) {
      parts.push(
        typeof obj.code === "number" || typeof obj.code === "string"
          ? `${obj.message} (code=${obj.code})`
          : obj.message,
      );
    }
    const detail = formatDetail(obj.data);
    if (detail) parts.push(detail);
    if (parts.length > 0) return parts.join("\n");
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }

  return String(e);
}

/**
 * Format a JSON-RPC `data` field into a one-or-two-line detail string.
 * Prefers string fields first (message/details/stack), then falls back
 * to a JSON dump.
 */
function formatDetail(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === "string") return data;
  if (typeof data !== "object") return String(data);

  const d = data as Record<string, unknown>;
  const preferredKeys = ["message", "details", "detail", "description", "stack"];
  const parts: string[] = [];
  for (const k of preferredKeys) {
    const v = d[k];
    if (typeof v === "string" && v) parts.push(v);
  }
  if (parts.length > 0) return parts.join("\n");
  try {
    return JSON.stringify(d);
  } catch {
    return null;
  }
}

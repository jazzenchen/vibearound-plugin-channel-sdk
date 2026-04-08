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
 * Prefers `Error.message`, falls back to a non-circular JSON stringify for
 * objects, and finally to `String(e)` for primitives.
 */
export function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

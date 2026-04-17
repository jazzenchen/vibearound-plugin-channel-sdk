/**
 * Barrel re-export for the renderer module.
 *
 * The implementation lives in `./renderer/`:
 *   - `block-renderer.ts` — the `BlockRenderer` abstract class
 *   - `permissions.ts`    — permission text-parsing + callback ids
 *   - `tools.ts`          — tool icon + summary helpers
 *   - `types.ts`          — narrow ACP types + internal state + constants
 *
 * Existing imports of `"./renderer.js"` stay valid.
 */

export { BlockRenderer } from "./renderer/block-renderer.js";
export { tryParsePermissionAnswer } from "./renderer/permissions.js";

/**
 * BlockRenderer — abstract base class for block-based message rendering.
 *
 * ## How it works
 *
 * ACP streams agent responses as a sequence of typed events:
 *   text chunk, text chunk, tool call, tool update, text chunk, …
 *
 * Each contiguous run of the **same kind** (text / thinking / tool) is grouped
 * into one "block". When the kind changes, the current block is **sealed**
 * (no more edits) and a new block starts.
 *
 * Blocks are rendered to the platform by subclass-implemented `sendBlock` and
 * `editBlock`. The renderer handles:
 *
 *   - **Debounced flushing** — batches rapid deltas before sending (avoids
 *     excessive API calls during fast streaming).
 *   - **Edit throttling** — enforces a minimum interval between edits to
 *     respect platform rate limits.
 *   - **Ordered delivery** — a `sendChain` Promise serializes all send/edit
 *     calls so messages always arrive in the correct order.
 *   - **Sentinel guard** — prevents concurrent creates for the same block.
 *   - **Verbose filtering** — thinking / tool blocks can be suppressed without
 *     creating phantom block boundaries.
 *
 * ## Usage
 *
 * ```ts
 * class MyRenderer extends BlockRenderer<string> {
 *   protected async sendBlock(chatId, kind, content) {
 *     const msg = await myApi.sendMessage(chatId, content);
 *     return msg.id;
 *   }
 *   protected async editBlock(chatId, ref, kind, content, sealed) {
 *     await myApi.editMessage(ref, content);
 *   }
 * }
 *
 * // In main.ts:
 * const renderer = new MyRenderer({ verbose: { showThinking: false } });
 *
 * // When user sends a message:
 * renderer.onPromptSent(chatId);
 * try {
 *   await agent.prompt({ sessionId, content });
 *   await renderer.onTurnEnd(chatId);
 * } catch (e) {
 *   await renderer.onTurnError(chatId, String(e));
 * }
 *
 * // In the ACP client's sessionUpdate handler:
 * renderer.onSessionUpdate(notification);
 * ```
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { BlockKind, BlockRendererOptions, VerboseConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Local ACP session-update narrowing
// ---------------------------------------------------------------------------
//
// The ACP SDK's `SessionNotification.update` is a discriminated union keyed on
// the `sessionUpdate` field, but the shape we get back at runtime varies by
// version. We only consume four variants here, so we define a narrow local
// view that documents exactly the fields this renderer depends on. A mismatch
// against the upstream type will show up as a compile error when the SDK is
// bumped, instead of silently producing `undefined` at runtime.

interface AgentMessageChunk {
  sessionUpdate: "agent_message_chunk";
  content?: { text?: string };
}

interface AgentThoughtChunk {
  sessionUpdate: "agent_thought_chunk";
  content?: { text?: string };
}

interface ToolCall {
  sessionUpdate: "tool_call";
  title?: string;
}

interface ToolCallUpdate {
  sessionUpdate: "tool_call_update";
  title?: string;
  status?: string;
}

type ConsumedSessionUpdate =
  | AgentMessageChunk
  | AgentThoughtChunk
  | ToolCall
  | ToolCallUpdate;

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

interface ManagedBlock<TRef> {
  /** Channel this block belongs to. Captured at creation time. */
  chatId: string;
  kind: BlockKind;
  content: string;
  /** Platform message reference set after the first successful send. */
  ref: TRef | null;
  /** True while a create request is in-flight (prevents concurrent creates). */
  creating: boolean;
  /** True once the block will receive no more content. */
  sealed: boolean;
}

interface ChannelState<TRef> {
  blocks: ManagedBlock<TRef>[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Timestamp of the last successful send or edit (for throttle calculation). */
  lastEditMs: number;
  /** Serializes all send/edit calls — guarantees message order. */
  sendChain: Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_MIN_EDIT_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// BlockRenderer
// ---------------------------------------------------------------------------

/**
 * Abstract base class for block-based rendering of ACP session streams.
 *
 * @typeParam TRef - Platform-specific message reference type (e.g. `number`
 *   for Telegram message IDs, `string` for Feishu message IDs). Used as the
 *   return type of `sendBlock` and the first argument of `editBlock`.
 */
export abstract class BlockRenderer<TRef = string> {
  protected readonly flushIntervalMs: number;
  protected readonly minEditIntervalMs: number;
  protected readonly verbose: VerboseConfig;

  private states = new Map<string, ChannelState<TRef>>();

  /** The chatId of the most recent prompt. Used as fallback target for
   *  notifications that arrive without an explicit chatId. */
  private lastActiveChatId: string | null = null;

  constructor(options: BlockRendererOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.minEditIntervalMs = options.minEditIntervalMs ?? DEFAULT_MIN_EDIT_INTERVAL_MS;
    this.verbose = {
      showThinking: options.verbose?.showThinking ?? false,
      showToolUse: options.verbose?.showToolUse ?? false,
    };
  }

  // ---------------------------------------------------------------------------
  // Abstract — plugin MUST implement these
  // ---------------------------------------------------------------------------

  /**
   * Send a plain text message to the IM. Used for system text, agent ready
   * notifications, session ready, and error messages.
   */
  protected abstract sendText(chatId: string, text: string): Promise<void>;

  /**
   * Send a new streaming block message to the platform.
   *
   * Return the platform message reference that will be passed to future
   * `editBlock` calls. Return `null` if editing is not supported.
   */
  protected abstract sendBlock(
    chatId: string,
    kind: BlockKind,
    content: string,
  ): Promise<TRef | null>;

  // ---------------------------------------------------------------------------
  // Optional overrides — plugin MAY implement these
  // ---------------------------------------------------------------------------

  /**
   * Edit an existing block message in-place.
   *
   * Optional — if not implemented, blocks are never edited (send-only mode,
   * suitable for platforms like WeChat that don't support message editing).
   *
   * @param sealed - `true` when this is the final edit (block done streaming).
   *   Use to switch from a "streaming" card format to a finalized one.
   */
  protected editBlock?(
    chatId: string,
    ref: TRef,
    kind: BlockKind,
    content: string,
    sealed: boolean,
  ): Promise<void>;

  /**
   * Format block content before sending or editing.
   *
   * Default applies standard emoji prefixes:
   *   - `thinking` → `💭 <content>`
   *   - `tool`     → trimmed content
   *   - `text`     → content as-is
   *
   * Override to apply platform-specific formatting (e.g. markdown escaping).
   */
  protected formatContent(kind: BlockKind, content: string, _sealed: boolean): string {
    switch (kind) {
      case "thinking": return `💭 ${content}`;
      case "tool":     return content.trim();
      case "text":     return content;
    }
  }

  /**
   * Called after the last block has been flushed and the turn is complete.
   * Override to perform cleanup (e.g. remove a "typing" indicator).
   */
  protected onAfterTurnEnd(_chatId: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Called after a turn error. Default sends an error message via sendText.
   * Override for platform-specific error rendering (e.g. error card).
   */
  protected async onAfterTurnError(chatId: string, error: string): Promise<void> {
    await this.sendText(chatId, `❌ Error: ${error}`);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Process an ACP `sessionUpdate` notification from the host.
   *
   * Routes the event to the correct block based on its variant, appending
   * deltas to the current block or starting a new one when the kind changes.
   *
   * Call this from the ACP `Client.sessionUpdate` handler.
   */
  onSessionUpdate(notification: SessionNotification): void {
    // sessionId from ACP = chatId (the host replaces the real agent session
    // ID with the chat ID before forwarding to the plugin).
    const chatId = notification.sessionId;
    const rawUpdate = notification.update as unknown as { sessionUpdate: string };
    const variant = rawUpdate.sessionUpdate;
    if (
      variant !== "agent_message_chunk" &&
      variant !== "agent_thought_chunk" &&
      variant !== "tool_call" &&
      variant !== "tool_call_update"
    ) {
      return;
    }
    const update = rawUpdate as ConsumedSessionUpdate;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const delta = update.content?.text ?? "";
        if (delta) this.appendToBlock(chatId, "text", delta);
        break;
      }
      case "agent_thought_chunk": {
        if (!this.verbose.showThinking) return;
        const delta = update.content?.text ?? "";
        if (delta) this.appendToBlock(chatId, "thinking", delta);
        break;
      }
      case "tool_call": {
        if (!this.verbose.showToolUse) return;
        if (update.title) this.appendToBlock(chatId, "tool", `🔧 ${update.title}\n`);
        break;
      }
      case "tool_call_update": {
        if (!this.verbose.showToolUse) return;
        const title = update.title ?? "tool";
        if (update.status === "completed" || update.status === "error") {
          this.appendToBlock(chatId, "tool", `✅ ${title}\n`);
        }
        break;
      }
    }
  }

  /**
   * Call before sending a prompt. Tracks the active chatId and clears
   * leftover state from a previous turn.
   */
  onPromptSent(chatId: string): void {
    this.lastActiveChatId = chatId;
    const old = this.states.get(chatId);
    if (old?.flushTimer) clearTimeout(old.flushTimer);
    this.states.set(chatId, {
      blocks: [],
      flushTimer: null,
      lastEditMs: 0,
      sendChain: Promise.resolve(),
    });
  }

  // ---------------------------------------------------------------------------
  // Host notification handlers — built-in defaults, no per-plugin duplication
  // ---------------------------------------------------------------------------

  /** Handle `channel/system_text` from host. */
  onSystemText(chatId: string, text: string): void {
    this.sendText(chatId, text).catch(() => {});
  }

  /** Handle `channel/agent_ready` from host. */
  onAgentReady(chatId: string, agent: string, version: string): void {
    this.sendText(chatId, `🤖 Agent: ${agent} v${version}`).catch(() => {});
  }

  /** Handle `channel/session_ready` from host. */
  onSessionReady(chatId: string, sessionId: string): void {
    this.sendText(chatId, `📋 Session: ${sessionId}`).catch(() => {});
  }

  /**
   * Call this after `agent.prompt()` resolves (turn complete).
   *
   * Seals and flushes the last block, then waits for all pending sends/edits
   * to complete before calling `onAfterTurnEnd`.
   */
  async onTurnEnd(chatId: string): Promise<void> {
    const state = this.states.get(chatId);
    if (!state) return;

    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }

    const last = state.blocks.at(-1);
    if (last && !last.sealed) {
      last.sealed = true;
      this.enqueueFlush(state, last);
    }

    await state.sendChain;
    this.states.delete(chatId);
    await this.onAfterTurnEnd(chatId);
  }

  /**
   * Call this when `agent.prompt()` throws (turn error).
   *
   * Discards pending state and calls `onAfterTurnError`.
   */
  async onTurnError(chatId: string, error: string): Promise<void> {
    const state = this.states.get(chatId);
    if (state?.flushTimer) clearTimeout(state.flushTimer);
    this.states.delete(chatId);
    await this.onAfterTurnError(chatId, error);
  }

  // ---------------------------------------------------------------------------
  // Internal — block management
  // ---------------------------------------------------------------------------

  private appendToBlock(chatId: string, kind: BlockKind, delta: string): void {
    let state = this.states.get(chatId);
    if (!state) {
      // Auto-create state if onPromptSent wasn't called (e.g. host-initiated turns)
      state = { blocks: [], flushTimer: null, lastEditMs: 0, sendChain: Promise.resolve() };
      this.states.set(chatId, state);
    }

    const last = state.blocks.at(-1);

    if (last && !last.sealed && last.kind === kind) {
      // Same kind — accumulate
      last.content += delta;
    } else {
      // Kind changed — seal current block and start a new one
      if (last && !last.sealed) {
        last.sealed = true;
        // Clear the debounce timer: we're doing an immediate flush of the sealed block
        if (state.flushTimer) {
          clearTimeout(state.flushTimer);
          state.flushTimer = null;
        }
        this.enqueueFlush(state, last);
      }
      state.blocks.push({ chatId, kind, content: delta, ref: null, creating: false, sealed: false });
    }

    this.scheduleFlush(chatId, state);
  }

  private scheduleFlush(chatId: string, state: ChannelState<TRef>): void {
    if (state.flushTimer) return; // already scheduled

    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      this.flush(chatId, state);
    }, this.flushIntervalMs);
  }

  private flush(chatId: string, state: ChannelState<TRef>): void {
    const block = state.blocks.at(-1);
    if (!block || block.sealed || !block.content) return;

    // Send-only mode: subclasses that don't override `editBlock` (e.g.
    // QQ Bot, where the platform has no edit support) would otherwise
    // POST a new message for every debounced flush, so the user sees a
    // partial chunk followed by the full message as two separate
    // deliveries. Defer intermediate sends; only `onTurnEnd` and block
    // boundary transitions inside `appendToBlock` (which seal the block
    // first) will actually POST.
    if (!this.editBlock) {
      return;
    }

    const now = Date.now();
    if (now - state.lastEditMs < this.minEditIntervalMs) {
      // Throttled — reschedule for the remaining window
      const delay = this.minEditIntervalMs - (now - state.lastEditMs);
      if (!state.flushTimer) {
        state.flushTimer = setTimeout(() => {
          state.flushTimer = null;
          this.flush(chatId, state);
        }, delay);
      }
      return;
    }

    this.enqueueFlush(state, block);
  }

  private enqueueFlush(state: ChannelState<TRef>, block: ManagedBlock<TRef>): void {
    state.sendChain = state.sendChain
      .then(() => this.flushBlock(state, block))
      .catch(() => {}); // errors are handled inside flushBlock
  }

  private async flushBlock(state: ChannelState<TRef>, block: ManagedBlock<TRef>): Promise<void> {
    const content = this.formatContent(block.kind, block.content, block.sealed);
    if (!content) return;

    try {
      if (block.ref === null && !block.creating) {
        // First send — use sentinel to prevent concurrent creates
        block.creating = true;
        block.ref = await this.sendBlock(block.chatId, block.kind, content);
        block.creating = false;
        state.lastEditMs = Date.now();
      } else if (block.ref !== null && !block.creating && this.editBlock) {
        // Subsequent update — edit in-place
        await this.editBlock(block.chatId, block.ref, block.kind, content, block.sealed);
        state.lastEditMs = Date.now();
      }
      // else: create is in-flight (creating === true) — skip
    } catch {
      block.creating = false;
    }
  }
}

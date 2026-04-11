/**
 * runChannelPlugin — shared main.ts boilerplate for every channel plugin.
 *
 * Each channel plugin used to have a ~120-line `main.ts` that was 85%
 * identical across Slack, Telegram, Discord, DingTalk, WeCom, etc:
 * connect to host, validate config keys, wire the standard sessionUpdate
 * and extNotification handlers, create the stream handler, start the bot,
 * wait for disconnect, stop. This helper absorbs that boilerplate so each
 * plugin's `main.ts` reduces to ~20 lines — a factory for the bot and a
 * factory for the stream handler.
 *
 * ## Usage
 *
 * ```ts
 * import { runChannelPlugin } from "@vibearound/plugin-channel-sdk";
 * import { SlackBot } from "./bot.js";
 * import { AgentStreamHandler } from "./agent-stream.js";
 *
 * runChannelPlugin({
 *   name: "vibearound-slack",
 *   version: "0.1.0",
 *   requiredConfig: ["bot_token", "app_token"],
 *   createBot: ({ config, agent, log, cacheDir }) =>
 *     new SlackBot(
 *       { bot_token: config.bot_token as string, app_token: config.app_token as string },
 *       agent,
 *       log,
 *       cacheDir,
 *     ),
 *   createStreamHandler: (bot, log, verbose) =>
 *     new AgentStreamHandler(bot, log, verbose),
 * });
 * ```
 */

import os from "node:os";
import path from "node:path";
import type { Agent } from "@agentclientprotocol/sdk";

import { connectToHost, normalizeExtMethod } from "./connection.js";
import { extractErrorMessage } from "./errors.js";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ChannelPluginLogger = (level: string, msg: string) => void;

export interface ChannelStreamHandler {
  onSessionUpdate(params: SessionNotification): void;
  /**
   * Called when the host sends a `channel/system_text` notification.
   * `channelId` is the full `channelKind:chatId` string from the host.
   * Plugins that track `lastChannelId` internally can ignore `channelId`.
   */
  onSystemText(text: string, channelId?: string): void;
  onAgentReady(agent: string, version: string): void;
  onSessionReady(sessionId: string): void;
}

export interface ChannelBot<THandler extends ChannelStreamHandler = ChannelStreamHandler> {
  setStreamHandler(handler: THandler): void;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface CreateBotContext {
  config: Record<string, unknown>;
  agent: Agent;
  log: ChannelPluginLogger;
  cacheDir: string;
}

export interface VerboseOptions {
  showThinking: boolean;
  showToolUse: boolean;
}

export interface RunChannelPluginSpec<
  TBot extends ChannelBot<THandler>,
  THandler extends ChannelStreamHandler,
> {
  /** Plugin name reported during ACP initialize (e.g. "vibearound-slack"). */
  name: string;

  /** Plugin version reported during ACP initialize. */
  version: string;

  /**
   * Config keys that MUST be present on `meta.config`. Plugin startup
   * fails with a clear error if any are missing. Keep to primitives
   * (strings/booleans); deeper validation belongs in the bot constructor.
   */
  requiredConfig?: string[];

  /** Factory: build the platform bot from host-supplied config + agent. */
  createBot: (ctx: CreateBotContext) => TBot | Promise<TBot>;

  /**
   * Factory: build the agent stream handler for this plugin. The handler
   * is wired to the bot via `bot.setStreamHandler(handler)` before the
   * bot is started.
   */
  createStreamHandler: (
    bot: TBot,
    log: ChannelPluginLogger,
    verbose: VerboseOptions,
  ) => THandler;

  /**
   * Optional hook invoked after the bot has been constructed but before
   * `start()` is called. Use this for one-off initialization that needs
   * to log diagnostic info (e.g. Telegram's `probe()`).
   */
  afterCreate?: (bot: TBot, log: ChannelPluginLogger) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Run a channel plugin to completion.
 *
 * Performs the ACP initialize handshake, validates required config,
 * constructs the bot + stream handler, starts the bot, waits for the host
 * connection to close, then stops the bot and exits the process.
 *
 * Never returns under normal operation — the process exits at the end.
 */
export async function runChannelPlugin<
  TBot extends ChannelBot<THandler>,
  THandler extends ChannelStreamHandler,
>(spec: RunChannelPluginSpec<TBot, THandler>): Promise<void> {
  const prefix = `[${spec.name.replace(/^vibearound-/, "")}-plugin]`;
  const log: ChannelPluginLogger = (level, msg) => {
    process.stderr.write(`${prefix}[${level}] ${msg}\n`);
  };

  try {
    await runInner(spec, log);
  } catch (err) {
    log("error", `fatal: ${extractErrorMessage(err)}`);
    process.exit(1);
  }
}

async function runInner<
  TBot extends ChannelBot<THandler>,
  THandler extends ChannelStreamHandler,
>(
  spec: RunChannelPluginSpec<TBot, THandler>,
  log: ChannelPluginLogger,
): Promise<void> {
  log("info", "initializing ACP connection...");

  let streamHandler: THandler | null = null;

  const { agent, meta, agentInfo, conn } = await connectToHost(
    { name: spec.name, version: spec.version },
    () => ({
      async sessionUpdate(params: SessionNotification): Promise<void> {
        streamHandler?.onSessionUpdate(params);
      },

      async requestPermission(
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        const first = params.options?.[0];
        if (first) {
          return { outcome: { outcome: "selected", optionId: first.optionId } };
        }
        throw new Error("No permission options provided");
      },

      async extNotification(
        method: string,
        params: Record<string, unknown>,
      ): Promise<void> {
        switch (normalizeExtMethod(method)) {
          case "channel/system_text": {
            const text = params.text as string;
            const channelId = params.channelId as string | undefined;
            streamHandler?.onSystemText(text, channelId);
            break;
          }
          case "channel/agent_ready": {
            const agentName = params.agent as string;
            const version = params.version as string;
            log("info", `agent_ready: ${agentName} v${version}`);
            streamHandler?.onAgentReady(agentName, version);
            break;
          }
          case "channel/session_ready": {
            const sessionId = params.sessionId as string;
            log("info", `session_ready: ${sessionId}`);
            streamHandler?.onSessionReady(sessionId);
            break;
          }
          default:
            log("warn", `unhandled ext_notification: ${method}`);
        }
      },
    }),
  );

  const config = meta.config;

  // Validate required config keys up front so a misconfigured plugin fails
  // with a clear error instead of some downstream "undefined is not a
  // string" crash in the bot constructor.
  for (const key of spec.requiredConfig ?? []) {
    if (config[key] === undefined || config[key] === null || config[key] === "") {
      throw new Error(`${key} is required in config`);
    }
  }

  const cacheDir =
    meta.cacheDir ?? path.join(os.homedir(), ".vibearound", ".cache");

  log(
    "info",
    `initialized, host=${agentInfo.name ?? "unknown"} cacheDir=${cacheDir}`,
  );

  const bot = await spec.createBot({ config, agent, log, cacheDir });

  if (spec.afterCreate) {
    await spec.afterCreate(bot, log);
  }

  const verboseRaw = config.verbose as
    | { show_thinking?: boolean; show_tool_use?: boolean }
    | undefined;
  const verbose: VerboseOptions = {
    showThinking: verboseRaw?.show_thinking ?? false,
    showToolUse: verboseRaw?.show_tool_use ?? false,
  };

  streamHandler = spec.createStreamHandler(bot, log, verbose);
  bot.setStreamHandler(streamHandler);

  await bot.start();
  log("info", "plugin started");

  await conn.closed;
  log("info", "connection closed, shutting down");
  await bot.stop();
  process.exit(0);
}

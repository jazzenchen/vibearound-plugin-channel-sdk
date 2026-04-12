/**
 * runChannelPlugin — the SDK entry point for every channel plugin.
 *
 * Handles the full ACP lifecycle: connect to host, validate config, create
 * bot + renderer, start the bot, then await disconnect and stop. The plugin
 * only implements platform-specific transport (sendText, sendBlock, editBlock).
 *
 * ## Usage
 *
 * ```ts
 * import { runChannelPlugin } from "@vibearound/plugin-channel-sdk";
 *
 * runChannelPlugin({
 *   name: "vibearound-slack",
 *   version: "0.1.0",
 *   requiredConfig: ["bot_token", "app_token"],
 *   createBot: ({ config, agent, log, cacheDir }) =>
 *     new SlackBot({ ... }, agent, log, cacheDir),
 *   createRenderer: (bot, log, verbose) =>
 *     new SlackRenderer(bot, log, verbose),
 * });
 * ```
 */

import os from "node:os";
import path from "node:path";
import type { Agent } from "@agentclientprotocol/sdk";

import { connectToHost, stripExtPrefix } from "./connection.js";
import { extractErrorMessage } from "./errors.js";
import { BlockRenderer } from "./renderer.js";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ChannelPluginLogger = (level: string, msg: string) => void;

/**
 * The platform bot — handles IM connectivity and message transport.
 *
 * Plugins implement this interface on their bot class. The SDK calls these
 * methods during the plugin lifecycle.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ChannelBot<TRenderer extends BlockRenderer<any> = BlockRenderer<any>> {
  /** Wire the renderer to receive streaming events. */
  setStreamHandler(handler: TRenderer): void;
  /** Connect to the IM platform and start receiving messages. */
  start(): Promise<void> | void;
  /** Disconnect and clean up. */
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
  TBot extends ChannelBot<TRenderer>,
  TRenderer extends BlockRenderer<any>,
> {
  /** Plugin name reported during ACP initialize (e.g. "vibearound-slack"). */
  name: string;

  /** Plugin version reported during ACP initialize. */
  version: string;

  /**
   * Config keys that MUST be present. Plugin fails fast if any are missing.
   */
  requiredConfig?: string[];

  /** Factory: build the platform bot. */
  createBot: (ctx: CreateBotContext) => TBot | Promise<TBot>;

  /**
   * Factory: build the renderer (extends BlockRenderer).
   * Only implements platform-specific sendText/sendBlock/editBlock.
   */
  createRenderer: (
    bot: TBot,
    log: ChannelPluginLogger,
    verbose: VerboseOptions,
  ) => TRenderer;

  /**
   * Optional hook invoked after bot constructed but before start().
   */
  afterCreate?: (bot: TBot, log: ChannelPluginLogger) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Run a channel plugin.
 *
 * Handles the full ACP lifecycle: connect to host, validate config,
 * construct bot + renderer, start the bot, then wait for the host
 * to disconnect before stopping and exiting.
 */
export async function runChannelPlugin<
  TBot extends ChannelBot<TRenderer>,
  TRenderer extends BlockRenderer<any>,
>(spec: RunChannelPluginSpec<TBot, TRenderer>): Promise<void> {
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
  TBot extends ChannelBot<TRenderer>,
  TRenderer extends BlockRenderer<any>,
>(
  spec: RunChannelPluginSpec<TBot, TRenderer>,
  log: ChannelPluginLogger,
): Promise<void> {
  log("info", "initializing ACP connection...");

  let renderer: TRenderer | null = null;

  const { agent, meta, agentInfo, conn } = await connectToHost(
    { name: spec.name, version: spec.version },
    () => ({
      async sessionUpdate(params: SessionNotification): Promise<void> {
        renderer?.onSessionUpdate(params);
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
        const chatId = typeof params.chatId === "string" ? params.chatId : undefined;
        switch (stripExtPrefix(method)) {
          case "va/system_text": {
            const text = typeof params.text === "string" ? params.text : "";
            if (chatId && renderer) {
              renderer.onSystemText(chatId, text);
            }
            break;
          }
          case "va/agent_ready": {
            const agentName = typeof params.agent === "string" ? params.agent : "unknown";
            const version = typeof params.version === "string" ? params.version : "";
            log("info", `agent_ready: ${agentName} v${version}`);
            if (chatId && renderer) {
              renderer.onAgentReady(chatId, agentName, version);
            }
            break;
          }
          case "va/session_ready": {
            const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
            log("info", `session_ready: ${sessionId}`);
            if (chatId && renderer) {
              renderer.onSessionReady(chatId, sessionId);
            }
            break;
          }
          case "va/command_menu": {
            const systemCommands = Array.isArray(params.systemCommands) ? params.systemCommands : [];
            const agentCommands = Array.isArray(params.agentCommands) ? params.agentCommands : [];
            if (chatId && renderer) {
              renderer.onCommandMenu(chatId, systemCommands, agentCommands);
            }
            break;
          }
          default:
            log("warn", `unhandled ext_notification: ${method}`);
        }
      },
    }),
  );

  const config = meta.config;

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

  renderer = spec.createRenderer(bot, log, verbose);
  bot.setStreamHandler(renderer);

  await bot.start();
  log("info", "plugin started");

  await conn.closed;
  log("info", "connection closed, shutting down");
  await bot.stop();
  process.exit(0);
}

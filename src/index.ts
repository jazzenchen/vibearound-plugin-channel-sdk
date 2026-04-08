/**
 * @vibearound/plugin-channel-sdk
 *
 * Base classes and utilities for building VibeAround channel plugins.
 *
 * ## Quick start
 *
 * ```ts
 * import {
 *   connectToHost,
 *   BlockRenderer,
 *   normalizeExtMethod,
 *   type Agent,
 *   type SessionNotification,
 * } from "@vibearound/plugin-channel-sdk";
 *
 * class MyRenderer extends BlockRenderer<string> {
 *   protected async sendBlock(channelId, kind, content) {
 *     const msg = await myPlatform.send(channelId, content);
 *     return msg.id;
 *   }
 *   protected async editBlock(channelId, ref, kind, content, sealed) {
 *     await myPlatform.edit(ref, content);
 *   }
 * }
 *
 * let agent!: Agent;
 * const renderer = new MyRenderer();
 *
 * const { meta, conn } = await connectToHost(
 *   { name: "vibearound-mybot", version: "0.1.0" },
 *   (a) => {
 *     agent = a;
 *     return {
 *       sessionUpdate: async (n) => renderer.onSessionUpdate(n),
 *       requestPermission: async (p) => ({
 *         outcome: { outcome: "selected", optionId: p.options![0].optionId },
 *       }),
 *       extNotification: async (method, params) => {
 *         switch (normalizeExtMethod(method)) {
 *           case "channel/system_text":
 *             await myPlatform.send(params.channelId as string, params.text as string);
 *             break;
 *         }
 *       },
 *     };
 *   },
 * );
 *
 * const botToken = meta.config.bot_token as string;
 * // … start your platform bot …
 * await conn.closed;
 * ```
 */

// Connection helpers
export { connectToHost, normalizeExtMethod, redirectConsoleToStderr } from "./connection.js";
export type { PluginInfo, ConnectResult, AgentInfo } from "./connection.js";

// Error normalization
export { extractErrorMessage } from "./errors.js";

// Plugin runner (absorbs the main.ts boilerplate)
export { runChannelPlugin } from "./run-plugin.js";
export type {
  ChannelBot,
  ChannelPluginLogger,
  ChannelStreamHandler,
  CreateBotContext,
  RunChannelPluginSpec,
  VerboseOptions,
} from "./run-plugin.js";

// Block renderer
export { BlockRenderer } from "./renderer.js";


// Types (re-exports ACP SDK types + SDK-specific types)
export type {
  // ACP SDK
  Agent,
  Client,
  ContentBlock,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  // SDK
  BlockKind,
  VerboseConfig,
  BlockRendererOptions,
  PluginCapabilities,
  PluginManifest,
  PluginInitMeta,
} from "./types.js";

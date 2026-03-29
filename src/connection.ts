/**
 * ACP stdio connection helpers.
 *
 * Handles the boilerplate of wiring Node.js stdio streams to an ACP
 * ClientSideConnection, performing the initialize handshake, and extracting
 * plugin config from the host's _meta response.
 */

import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
} from "@agentclientprotocol/sdk";
import type { PluginInitMeta } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PluginInfo {
  name: string;
  version: string;
}

export interface AgentInfo {
  name?: string;
  version?: string;
}

export interface ConnectResult {
  /** ACP agent reference — call agent.prompt() to send messages. */
  agent: Agent;
  /** Plugin config and cache dir provided by the host at startup. */
  meta: PluginInitMeta;
  /** Info about the host agent (name, version) reported during initialize. */
  agentInfo: AgentInfo;
  /**
   * The ACP connection. Await `conn.closed` to keep the process alive until
   * the host disconnects.
   */
  conn: { readonly closed: Promise<void> };
}

/**
 * Connect to the VibeAround host via stdio ACP.
 *
 * Sets up Node.js stdio streams → ACP transport, calls `initialize`, and
 * returns the agent reference plus plugin config/meta from the host.
 *
 * @param pluginInfo - Name and version reported to the host
 * @param makeClient - Factory called with the Agent; returns the Client
 *   implementation (sessionUpdate, requestPermission, extNotification).
 *   Capture the agent argument here if you need it before this function resolves.
 *
 * @example
 * ```ts
 * let agent!: Agent;
 * const { meta, conn } = await connectToHost(
 *   { name: "vibearound-mybot", version: "0.1.0" },
 *   (a) => { agent = a; return myClient; },
 * );
 * ```
 */
export async function connectToHost(
  pluginInfo: PluginInfo,
  makeClient: (agent: Agent) => Client,
): Promise<ConnectResult> {
  // Keep stdout clean for JSON-RPC — redirect all console output to stderr
  redirectConsoleToStderr();

  const inputStream = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const outputStream = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const stream = ndJsonStream(outputStream, inputStream);

  let capturedAgent!: Agent;
  const wrappedMakeClient = (a: Agent): Client => {
    capturedAgent = a;
    return makeClient(a);
  };

  const conn = new ClientSideConnection(wrappedMakeClient, stream);

  const initResponse = await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: pluginInfo.name, version: pluginInfo.version },
    capabilities: {},
  });

  const rawMeta = (initResponse as Record<string, unknown>)._meta as
    | Record<string, unknown>
    | undefined;

  const meta: PluginInitMeta = {
    config: (rawMeta?.config ?? {}) as Record<string, unknown>,
    cacheDir: rawMeta?.cacheDir as string | undefined,
  };

  const agentInfo: AgentInfo = {
    name: initResponse.agentInfo?.name,
    version: initResponse.agentInfo?.version,
  };

  return { agent: capturedAgent, meta, agentInfo, conn };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Normalize ACP ext notification method names.
 *
 * The ACP SDK prepends "_" to ext method names (e.g. "_channel/system_text").
 * Strip the prefix to get the canonical method name used in plugin.json.
 */
export function normalizeExtMethod(method: string): string {
  return method.startsWith("_") ? method.slice(1) : method;
}

/**
 * Redirect all console.* output to stderr.
 *
 * ACP uses stdout for JSON-RPC framing — any stray console output corrupts
 * the protocol. Call this once at plugin startup (connectToHost does this
 * automatically).
 */
let _consoleRedirected = false;

export function redirectConsoleToStderr(): void {
  if (_consoleRedirected) return;
  _consoleRedirected = true;

  const toStderr = (...args: unknown[]) =>
    process.stderr.write(args.map(String).join(" ") + "\n");

  console.log = toStderr;
  console.info = toStderr;
  console.warn = (...args: unknown[]) =>
    process.stderr.write("[warn] " + args.map(String).join(" ") + "\n");
  console.error = (...args: unknown[]) =>
    process.stderr.write("[error] " + args.map(String).join(" ") + "\n");
  console.debug = (...args: unknown[]) =>
    process.stderr.write("[debug] " + args.map(String).join(" ") + "\n");
}

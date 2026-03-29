# @vibearound/plugin-channel-sdk

Base classes and utilities for building [VibeAround](https://github.com/anthropics/vibearound) channel plugins.

VibeAround channel plugins bridge messaging platforms (Telegram, Feishu, WeChat, etc.) to the VibeAround agent runtime via the [Agent Client Protocol (ACP)](https://github.com/anthropics/agent-client-protocol). This SDK extracts the shared patterns so you can focus on platform integration.

## Install

```bash
npm install @vibearound/plugin-channel-sdk
```

## What it provides

- **`connectToHost()`** — Sets up the ACP stdio connection, performs the initialize handshake, extracts plugin config from the host, and redirects console output to stderr.
- **`BlockRenderer<TRef>`** — Abstract base class that handles block-based message rendering: accumulation of streaming deltas, kind-change detection, debounced flushing, edit throttling, and ordered delivery via a serialized Promise chain.
- **`normalizeExtMethod()`** — Strips the `_` prefix the ACP SDK adds to extension method names.
- **Types** — Re-exports common ACP SDK types (`Agent`, `Client`, `SessionNotification`, etc.) plus SDK-specific types (`BlockKind`, `VerboseConfig`, `PluginManifest`, etc.).

## Quick start

```ts
import {
  connectToHost,
  BlockRenderer,
  normalizeExtMethod,
  type Agent,
  type BlockKind,
  type SessionNotification,
} from "@vibearound/plugin-channel-sdk";

// 1. Implement a renderer for your platform
class MyRenderer extends BlockRenderer<string> {
  protected async sendBlock(channelId: string, kind: BlockKind, content: string) {
    const msg = await myPlatform.send(channelId, content);
    return msg.id; // platform message reference for future edits
  }

  // Optional — omit for platforms that don't support editing
  protected async editBlock(channelId: string, ref: string, kind: BlockKind, content: string, sealed: boolean) {
    await myPlatform.edit(ref, content);
  }
}

// 2. Connect to the VibeAround host
const renderer = new MyRenderer({ minEditIntervalMs: 600 });

const { agent, meta, agentInfo, conn } = await connectToHost(
  { name: "vibearound-myplatform", version: "0.1.0" },
  (_agent) => ({
    async sessionUpdate(params: SessionNotification) {
      renderer.onSessionUpdate(params);
    },
    async requestPermission(params) {
      return { outcome: { outcome: "selected", optionId: params.options![0].optionId } };
    },
    async extNotification(method, params) {
      switch (normalizeExtMethod(method)) {
        case "channel/system_text":
          await myPlatform.send(params.channelId as string, params.text as string);
          break;
      }
    },
  }),
);

// 3. Use the config and start your platform bot
const botToken = meta.config.bot_token as string;
// ... initialize your platform SDK ...

// 4. On each incoming message:
renderer.onPromptSent(channelId);
try {
  await agent.prompt({ sessionId: chatId, prompt: contentBlocks });
  await renderer.onTurnEnd(channelId);
} catch (e) {
  await renderer.onTurnError(channelId, String(e));
}

// 5. Keep alive until host disconnects
await conn.closed;
```

## BlockRenderer

The `BlockRenderer<TRef>` groups streaming ACP events into contiguous blocks by kind (`text`, `thinking`, `tool`), then renders them to your platform via `sendBlock` / `editBlock`.

### Constructor options

| Option | Default | Description |
|---|---|---|
| `flushIntervalMs` | `500` | Debounce interval before flushing an in-progress block |
| `minEditIntervalMs` | `1000` | Minimum gap between consecutive edits (rate limit protection) |
| `verbose.showThinking` | `false` | Render agent thinking/reasoning blocks |
| `verbose.showToolUse` | `false` | Render tool call/result blocks |

### Methods to implement

| Method | Required | Description |
|---|---|---|
| `sendBlock(channelId, kind, content)` | Yes | Send a new message, return a platform ref (or `null` if no editing) |
| `editBlock(channelId, ref, kind, content, sealed)` | No | Edit an existing message in-place |
| `formatContent(kind, content, sealed)` | No | Format block content before send/edit (default: emoji prefixes) |

### Lifecycle hooks

| Hook | Description |
|---|---|
| `onAfterTurnEnd(channelId)` | Cleanup after all blocks are flushed (e.g. remove typing indicator) |
| `onAfterTurnError(channelId, error)` | Send error message to user |
| `sessionIdToChannelId(sessionId)` | Map ACP session ID to your channel ID (default: identity) |

## Plugin manifest

Each channel plugin needs a `plugin.json` at its root:

```json
{
  "id": "my-platform",
  "name": "My Platform Channel",
  "version": "0.1.0",
  "kind": "channel",
  "runtime": "node",
  "entry": "dist/main.js",
  "build": "npm install && npm run build",
  "configSchema": {
    "type": "object",
    "properties": {
      "bot_token": { "type": "string" }
    },
    "required": ["bot_token"]
  },
  "capabilities": {
    "streaming": true,
    "editMessage": true,
    "media": false
  }
}
```

## Examples

See the official channel plugins for real-world usage:

- **Feishu** — Interactive cards, streaming updates, reactions
- **Telegram** — Plain text messages with inline editing
- **WeChat** — Send-only mode (no editing), typing indicators

## License

MIT

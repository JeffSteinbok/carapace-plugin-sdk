# 🦞🐚 carapace-plugin-sdk

[![CI](https://github.com/JeffSteinbok/carapace-plugin-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/JeffSteinbok/carapace-plugin-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/carapace-plugin-sdk?logo=npm)](https://www.npmjs.com/package/carapace-plugin-sdk)

SDK for building [OpenClaw](https://github.com/JeffSteinbok/openclaw) plugins.

Define your tools and config. The SDK generates a fully typed OpenClaw plugin, a standalone CLI, and a plugin manifest — automatically.

## Install

```bash
npm install carapace-plugin-sdk
```

## Quick start

> **New plugin?** Use [carapace-plugin-template](https://github.com/JeffSteinbok/carapace-plugin-template) — it scaffolds the full project structure, CI, and tests in one click.

Here's what you write in `src/plugin.ts`:

```ts
import { definePlugin } from "carapace-plugin-sdk";
import { Type } from "@sinclair/typebox";

// The export must be named `createEntry` — the SDK's build tools look for it by name.
export const createEntry = definePlugin({
  id: "my-plugin",
  name: "My Plugin",
  description: "Does something useful.",

  configSchema: Type.Object({
    apiKey: Type.Optional(Type.String({ description: "API key for the service." })),
  }),

  tools: (tool) => [
    tool({
      name: "do_thing",
      description: "Does the thing.",
      parameters: Type.Object({
        input: Type.String({ description: "Input value." }),
      }),
      execute: async ({ input }, config) => {
        // input: string ✓   config.apiKey: string | undefined ✓
        return { result: input, usingKey: !!config.apiKey };
      },
    }),
  ],
});
```

Run `npm run build` and you get:

| Generated file | What it is |
|----------------|-----------|
| `dist/adapter.js` | OpenClaw plugin adapter |
| `dist/bin/my-plugin.js` | Standalone CLI — each tool is a subcommand |
| `openclaw.plugin.json` | Plugin manifest read by OpenClaw at install time |

Nothing else to write. No registration boilerplate, no result wrapping, no manifest to maintain.

## What the SDK handles for you

| You write | SDK handles |
|-----------|-------------|
| `execute()` returning a plain object | Wrapping in the OpenClaw result format: JSON text in `content` for the model, the structured value in `details` for Code Mode scripts |
| `configSchema` TypeBox schema | JSON Schema for the manifest + OpenClaw settings UI (defaults to an empty object schema if omitted) |
| Tool names | `contracts.tools` list in the manifest — auto-discovered even for raw `register()` plugins |
| `src/plugin.ts` | `dist/adapter.js`, `dist/bin/*.js`, `openclaw.plugin.json` |

### Result grading (v3)

Since v3, the value you return is also the result's `details`. OpenClaw grades a tool call from `details`, so a top-level `error` (truthy), `ok: false`, `success: false`, `timedOut: true`, nonzero `exitCode`, or a failure-word `status` (`"failed"`, `"unavailable"`, `"disabled"`, `"cancelled"`, `"invalid"`, …) marks the call failed. Return those keys only to signal failure; put domain values that use these names under a wrapper key (`{ shipment: { status } }`).

Upgrading from v2 needs no code changes unless a tool returns one of those keys as ordinary data.

## Compact results for the model (v3.2)

Whatever `execute` returns is what the model reads, in full. For tools whose raw output is much bigger than what an
agent needs (a list of every Home Assistant entity with all its attributes, a week of calendar events with full
descriptions), that is wasted context on every call. Add `view` to send the model something smaller:

```ts
tool({
  name: "list_lights",
  description: "List lights and their state.",
  parameters: Type.Object({}),
  execute: async (_params, config) => fetchAllLights(config),          // full objects
  view: (lights) => lights.map((l) => `${l.name}: ${l.state}`).join("\n"),  // what the model reads
}),
```

| | Without `view` | With `view` |
|---|---|---|
| `content` (what the model reads) | `execute`'s result as JSON | `view`'s value (object as JSON, or a string) |
| `details` (Code Mode scripts, result grading) | `execute`'s result | `execute`'s result, unchanged |
| Standalone CLI output | `execute`'s result | `execute`'s result (the CLI prints `details`) |

- Failures (a top-level truthy `error`, `ok: false` or `success: false`) skip the view, so the model always sees the full
  error.
- If `view` throws, the full result is sent and a warning is logged; a bad view never breaks the tool.
- `formatResult(data, view)` takes the same optional second argument for plugins that register tools themselves.

Additive: tools without `view` behave exactly as before.

## Call context and access control (v3.1)

Every tool's `execute` receives a third argument, `ctx`: a small frozen object
built from the trusted context OpenClaw hands to tool factories. It is never
derived from tool arguments.

| Field | Meaning |
|-------|---------|
| `agentId` | Agent running the tool (`"main"`, `"family"`, …) |
| `sessionKey` | Session key of the turn |
| `workspaceDir` | Workspace directory of the agent running the tool |
| `messageChannel` | Inbound channel (`"imessage"`, `"discord"`, …), lowercased |
| `requesterSenderId` | Verified sender id. Absent for cron, CLI and heartbeat turns |
| `senderIsOwner` | Trusted owner bit |
| `accessGroups` | `accessGroups` from the live OpenClaw root config |
| `logger` | The plugin logger, when the host provides one |

Tools that don't declare `ctx` keep working. In the standalone CLI every field is absent.

To support this, `definePlugin` registers each tool as a factory,
`api.registerTool((toolContext) => tool, { name })`. The factory function also
carries the static tool shape (`name`, `description`, `parameters`, `execute`),
so wrappers that read `tool.name` and test harnesses that call
`tool.execute(id, params)` directly don't need changes. A wrapper around
`api.registerTool` should forward the second `opts` argument.

### `checkAccess`

`checkAccess(access, kind, id, op, ctx)` gates one resource against an `access`
block in the plugin's config:

```json
"access": {
  "calendars": {
    "family":   { "read": ["*"], "write": ["*"] },
    "personal": { "read": [{ "agent": "main" }, { "sender": "jeff" }], "write": [{ "agent": "main" }] }
  }
}
```

```ts
import { checkAccess, ACCESS_CONFIG_SCHEMA, type AccessConfig } from "carapace-plugin-sdk";

configSchema: Type.Object({
  access: Type.Optional(Type.Unsafe<AccessConfig>(ACCESS_CONFIG_SCHEMA)),
}),
// ...
execute: async ({ calendar }, config, ctx) => {
  const decision = checkAccess(config.access, "calendars", calendar, "read", ctx);
  if (!decision.allowed) return { error: decision.message };
  // ...
},
```

The rules:

- **No `access` block** (or no `access.<kind>`) allows everything, so existing configs keep working.
- **Default-deny** applies once `access.<kind>` exists. An id that isn't listed, or an op with no list, is denied.
- **A grant** is `"*"` or `{ agent?, sender? }`. Each field takes a string or a list. Every field in a grant must match, and any one matching grant allows the call.
- **`agent`** is compared with `ctx.agentId`, and `"*"` matches any agent.
- **`sender`** names an OpenClaw root-config access group (`type: "message.senders"`). It matches when the sender id is listed for the turn's channel, or under the group's `"*"` key. The special name `"owner"` matches `senderIsOwner === true`.
- **Senderless turns** (cron, CLI) match only grants with no `sender` field.
- **Malformed grants fail closed.** Unknown fields, empty grant objects and unknown group names never match.

Sender ids are normalized on both sides before comparison:

- Text is lowercased, which covers emails.
- Prefixes such as `imessage:`, `discord:` and `tel:` are stripped.
- Formatted phone numbers become E.164 (`+1 (425) 555-0100` becomes `+14255550100`), and so do bare 10- or 11-digit numbers on phone channels.

A denial returns `{ allowed: false, message }` with a message like
`Access denied: agent "family" / sender +14255550100 may not read calendar "nicole"`,
and logs that line once through `ctx.logger`.

Lower-level helpers are also exported: `canAccess`, `matchesGrant`,
`matchesAnyGrant`, `isSenderInGroup`, `normalizeSenderId`,
`isAccessControlled`, `describeCaller` and `buildToolCallContext`.

## Build setup

Add to `package.json`:

```json
{
  "bin": { "my-plugin": "./dist/bin/my-plugin.js" },
  "scripts": {
    "build": "tsup && carapace-generate-cli --entry ./dist/plugin.js --out ./dist/bin"
  }
}
```

The SDK ships shared configs so your project files stay minimal:

**`tsconfig.json`** — one line:
```json
{ "extends": "carapace-plugin-sdk/tsconfig.base.json" }
```

**`tsup.config.ts`** — three lines:
```ts
import { defineConfig } from "tsup";
import { definePluginConfig } from "carapace-plugin-sdk/tsup";

export default defineConfig(definePluginConfig());
```

**`vitest.config.ts`** — not needed. Vitest finds `tests/**/*.test.ts` without configuration.

## CLI — for free

Every plugin is automatically a standalone CLI. After `npm run build`:

```bash
my-plugin --help
my-plugin do-thing "hello"
my-plugin do-thing "hello" --json
MY_PLUGIN_API_KEY=sk-... my-plugin do-thing "hello"
```

Config fields map to environment variables:
`<PLUGIN_ID_SCREAMING_SNAKE>_<FIELD_SCREAMING_SNAKE>`

## Reusable CI/CD workflows

Call the shared GitHub Actions workflows from your plugin repo — no workflow logic to copy:

```yaml
# .github/workflows/ci.yml
jobs:
  ci:
    uses: JeffSteinbok/carapace-plugin-sdk/.github/workflows/plugin-ci.yml@main
```

```yaml
# .github/workflows/release.yml
# Bumps the version, commits + tags, and creates a draft GitHub release.
# Review and edit the draft, then publish it to trigger npm publish.
on:
  workflow_dispatch:
    inputs:
      version-bump:
        type: choice
        options: [patch, minor, major]
      prerelease:
        type: choice
        options: ['', alpha, beta, rc]
jobs:
  release:
    uses: JeffSteinbok/carapace-plugin-sdk/.github/workflows/plugin-release.yml@main
    with:
      version-bump: ${{ inputs.version-bump }}
      prerelease: ${{ inputs.prerelease }}
```

```yaml
# .github/workflows/publish.yml
# Publishes to npm when the draft GitHub release is promoted to published.
on:
  release:
    types: [published]
jobs:
  publish:
    uses: JeffSteinbok/carapace-plugin-sdk/.github/workflows/plugin-publish.yml@main
    secrets:
      npm-token: ${{ secrets.NPM_TOKEN }}
```

## Examples

- [carapace-plugin-template](https://github.com/JeffSteinbok/carapace-plugin-template) — starter template with CI, tests, and build pre-configured
- [carapace-stock-quotes](https://github.com/JeffSteinbok/carapace-stock-quotes) — real plugin with multiple data sources (Yahoo Finance + Finnhub)

## Internals

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the SDK works under the hood — the type machinery behind `definePlugin`, how `carapace-generate-cli` generates artifacts, the CLI runtime, and the adapter pattern.

## License

MIT

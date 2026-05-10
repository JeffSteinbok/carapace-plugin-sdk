# 🦞🐚 Carapace — Architecture

How the SDK works internally. Read this if you're contributing to the SDK, building tooling on top of it, or just curious why things are structured the way they are.

## Overview

Carapace has three moving parts:

| Part | File | What it does |
|------|------|-------------|
| Plugin API | `src/index.ts` | `definePlugin()`, types, `formatResult()`, `createAdapter()` |
| Build-time generator | `src/generate-cli.ts` | Reads `createEntry()`, emits adapter + CLI + manifest |
| CLI runtime | `src/cli.ts` | Turns a plugin into a standalone command-line tool |

---

## `definePlugin()` — the type machinery

### The problem it solves

Plugin authors need two things to flow into `execute()`:

1. **Typed params** — derived from the tool's `parameters` TypeBox schema
2. **Typed config** — derived from the plugin-level `configSchema` TypeBox schema

These are two separate generics (`TSchema` per tool, `TConfig` shared across all tools). TypeScript can infer `TConfig` from `configSchema`, but it needs a way to thread it into each tool's `execute` without losing `TSchema` per tool.

### Why the `tools: (tool) => []` callback

This is the key design decision. If `tools` were a plain array:

```ts
// ❌ Can't thread TConfig into execute — TypeScript has no way to constrain it
tools: [
  { name: "...", execute: async (params, config) => ... }
]
```

By making `tools` a callback that receives a typed factory, TypeScript infers `TConfig` from `configSchema` first, then constructs a `ToolFactory<TConfig>` and passes it in:

```ts
// ✓ TConfig is fixed by definePlugin, TSchema is inferred per tool call
tools: (tool) => [
  tool({ parameters: Type.Object({ ... }), execute: async ({ input }, config) => ... })
]
```

This is the same pattern used by tRPC. The `tool()` factory is identity at runtime — it returns its argument unchanged. All the type magic is compile-time only.

### The type chain

```
definePlugin<TConfigSchema extends TObject>
  → Static<TConfigSchema>  =  TConfig  (e.g. { apiKey?: string })
  → ToolFactory<TConfig>
    → tool<TSchema extends TObject>({ parameters: TSchema, execute(Static<TSchema>, TConfig) })
```

`Static<TSchema>` is TypeBox's utility that extracts the TypeScript type from a schema at compile time. So if `parameters` is `Type.Object({ symbol: Type.String() })`, then `params` in `execute` is `{ symbol: string }` — no casts needed.

### What happens at runtime

The `tool()` factory is literally `(def) => def`. No transformation. The `definePlugin` call collects the tool defs into an array when `createEntry()` is invoked, then `register(api)` iterates them and calls `api.registerTool()` for each one, wrapping `execute` to call `formatResult()` automatically.

---

## `carapace-generate-cli` — build-time generation

Run via `npm run build` after `tsup` compiles `src/plugin.ts`:

```
tsup && carapace-generate-cli --entry ./dist/plugin.js --out ./dist/bin
```

The generator:

1. **Imports** `dist/plugin.js` and calls `createEntry()`
2. **Reads metadata** — `id`, `name`, `description`, `configSchema`, `contracts`, `activation`
3. **Emits three files:**

### `dist/bin/<id>.js` — CLI entry point

```js
// Auto-generated
import { run } from "carapace-plugin-sdk/cli";
import { createEntry } from "../plugin.js";

run(createEntry(), { binName: "my-plugin", envPrefix: "MY_PLUGIN" });
```

The `envPrefix` is derived from the plugin id: `my-plugin` → `MY_PLUGIN`. This is what drives the env var → config field mapping.

### `dist/adapter.js` — OpenClaw adapter

```js
// Auto-generated
import { createAdapter } from "carapace-plugin-sdk";
import { createEntry } from "./plugin.js";

export default createAdapter(createEntry(), import.meta.url);
```

`createAdapter()` tries to load the optional `openclaw` peer dependency. If found, it wraps the entry with the host's `definePluginEntry()`. If not (standalone CLI mode), it returns the raw entry. The `import.meta.url` is passed so the resolution happens relative to the plugin's own `node_modules`, not the SDK's — important in monorepo setups where packages may be hoisted.

### `openclaw.plugin.json` — manifest

Generated from `createEntry()` metadata + `version` from `package.json`. Written to the repo root (not `dist/`) because OpenClaw reads it from the installed package root. The file is gitignored — it's always generated fresh at build time, so it never drifts from `createEntry()`.

---

## CLI runtime (`src/cli.ts`)

The `run()` function receives the plugin entry and options, then:

1. **Calls `register()`** with a mock API to collect tool definitions without side effects
2. **Reads env vars** → builds `pluginConfig` by scanning `configSchema.properties`
3. **Calls `register()` again** with the real config to get fully configured tools
4. **Parses `process.argv`** → command + positional args + flags
5. **Matches the command** to a tool
6. **Builds params** from positional args and flags
7. **Calls `execute()`** and prints the result

### Arg parsing

Parameters can be passed as positional args or `--flags`:

```bash
my-plugin do-thing hello          # positional
my-plugin do-thing --input hello  # flag
my-plugin do-thing --input=hello  # flag= form
```

Array-typed parameters consume all remaining positional args:

```bash
stock-quotes stock-quotes AAPL MSFT QQQ   # symbols = ["AAPL", "MSFT", "QQQ"]
```

### Tool matching

Command strings are matched to tools in order:
1. Exact match (`stock_quote`)
2. Hyphens normalised to underscores (`stock-quote` → `stock_quote`)
3. Suffix match (`quote` matches `stock_quote`)
4. If only one tool exists, it matches regardless of command name

### Config via env vars

Each `configSchema` property maps to an env var:

```
<PLUGIN_ID_SCREAMING_SNAKE>_<FIELD_SCREAMING_SNAKE>
```

Examples:
- Plugin `stock-quotes`, field `finnhubApiKey` → `STOCK_QUOTES_FINNHUB_API_KEY`
- Plugin `my-plugin`, field `apiKey` → `MY_PLUGIN_API_KEY`

Numeric fields are coerced from string (`Number(val)`). All others stay as strings.

---

## Reusable workflows

All workflow logic lives in this repo. Plugin repos call them with one or two lines — no workflow code to copy or maintain.

### `plugin-ci.yml`

Runs on every push. Steps: `npm ci` → `npm run build` → `npm test` → validate `openclaw.plugin.json`.

Manifest validation runs **after build** (not as a separate job) because the manifest is gitignored and only exists after `carapace-generate-cli` runs.

### `plugin-release.yml`

Triggered by `workflow_dispatch`. Runs CI first, then on success: bumps `package.json` version, commits + tags, publishes to npm, creates a draft GitHub release.

Prerelease labels (`alpha`, `beta`, `rc`) publish under that npm dist-tag instead of `latest`, so stable installs are unaffected.

### `plugin-validate.yml`

Standalone manifest validator. Useful when `openclaw.plugin.json` is committed (e.g. in monorepos where it may be source-controlled). Not used in the standard release flow since CI already validates post-build.

---

## Shared tsup config (`src/tsup.plugin.config.ts`)

Exported as `carapace-plugin-sdk/tsup`. Provides `definePluginConfig()` which returns standard tsup settings for a plugin build. The default entry is `["src/plugin.ts"]` — `dist/adapter.js` is generated, not compiled from source.

Plugins override with:

```ts
export default defineConfig(definePluginConfig({ entry: ["src/plugin.ts", "src/extra.ts"] }));
```

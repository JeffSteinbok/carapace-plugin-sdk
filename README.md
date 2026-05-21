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
| `execute()` returning a plain object | Wrapping in the OpenClaw result format |
| `configSchema` TypeBox schema | JSON Schema for the manifest + OpenClaw settings UI (defaults to an empty object schema if omitted) |
| Tool names | `contracts.tools` list in the manifest — auto-discovered even for raw `register()` plugins |
| `src/plugin.ts` | `dist/adapter.js`, `dist/bin/*.js`, `openclaw.plugin.json` |

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

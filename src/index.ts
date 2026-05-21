/**
 * carapace-plugin-sdk — Core types and helpers for OpenClaw plugins.
 *
 * This is the main entry point. Import `definePlugin` to author a plugin
 * with full TypeScript inference — typed config and typed tool parameters
 * with no boilerplate.
 *
 * Quick-start:
 *
 *   src/plugin.ts    — the only file you write; export `createEntry` from `definePlugin`
 *   dist/adapter.js  — auto-generated at build time; do not write by hand
 *
 * @module carapace-plugin-sdk
 */

import { createRequire } from "node:module";
import { type TObject, type Static } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// definePlugin — the primary authoring API
// ---------------------------------------------------------------------------

/**
 * Internal (erased) tool definition stored at runtime.
 * The typed version lives only in TypeScript's type system via ToolFactory<TConfig>.
 */
interface ToolDef {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute(params: Record<string, unknown>, config: unknown): Promise<unknown>;
}

/**
 * Typed tool factory injected into the `tools` callback of `definePlugin`.
 *
 * TConfig is fixed by the enclosing `definePlugin` call, so every tool in the
 * array receives the same config type. TSchema is inferred per tool from the
 * `parameters` field, giving typed `params` in `execute`.
 *
 * You never construct this directly — it is passed to you by `definePlugin`.
 */
type ToolFactory<TConfig> = <TSchema extends TObject>(def: {
  /** Machine-readable name, used as the CLI subcommand. snake_case recommended. */
  name: string;
  /** Human-readable label shown in OpenClaw's UI. Defaults to `name`. */
  label?: string;
  /** One-sentence description shown in --help and OpenClaw's tool inspector. */
  description: string;
  /**
   * TypeBox schema for the tool's parameters.
   * The type is inferred as `Static<TSchema>` in `execute`'s first argument.
   */
  parameters: TSchema;
  /**
   * The tool's implementation.
   *
   * @param params - Typed parameters derived from `parameters` schema. No casts needed.
   * @param config - Typed config derived from `definePlugin`'s `configSchema`. No casts needed.
   * @returns Any JSON-serialisable value. The SDK wraps it in the OpenClaw result format.
   */
  execute(params: Static<TSchema>, config: TConfig): Promise<unknown>;
}) => ToolDef;

/**
 * Define an OpenClaw plugin with full TypeScript inference.
 *
 * Returns a `createEntry` function — export it from your `src/index.ts`.
 * The SDK handles all registration, result wrapping, and config plumbing.
 *
 * Config type is inferred from `configSchema` and flows into every tool's
 * `execute(params, config)` without any manual type annotations.
 *
 * @example
 * // src/index.ts — the entire plugin
 * import { definePlugin } from "carapace-plugin-sdk";
 * import { Type } from "@sinclair/typebox";
 *
 * export const createEntry = definePlugin({
 *   id: "my-plugin",
 *   name: "My Plugin",
 *   configSchema: Type.Object({
 *     apiKey: Type.Optional(Type.String({ description: "API key." })),
 *   }),
 *   tools: (tool) => [
 *     tool({
 *       name: "do_thing",
 *       description: "Does the thing.",
 *       parameters: Type.Object({
 *         input: Type.String({ description: "Input value." }),
 *       }),
 *       execute: async ({ input }, config) => {
 *         // input: string ✓   config.apiKey: string | undefined ✓
 *         return { result: input };
 *       },
 *     }),
 *   ],
 * });
 */
export function definePlugin<TConfigSchema extends TObject = TObject>(def: {
  /** Unique plugin id. Lowercase alphanumeric with hyphens. Used as the CLI binary name. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** One-sentence description of what the plugin does. */
  description?: string;
  /** When to load the plugin. Defaults to `{ onStartup: true }`. */
  activation?: { onStartup?: boolean };
  /**
   * TypeBox schema for the plugin's config block.
   *
   * Used for three things simultaneously:
   *   1. Runtime JSON Schema for the OpenClaw manifest (validated before register())
   *   2. TypeScript type inference for `config` in every tool's `execute`
   *   3. Environment variable mapping for the standalone CLI
   */
  configSchema?: TConfigSchema;
  /**
   * Declare your tools here. Receives a typed `tool()` factory as its argument.
   *
   * Using a callback (rather than a plain array) is what allows TypeScript to
   * thread the config type through to each tool's `execute` function.
   */
  tools: (tool: ToolFactory<Static<TConfigSchema>>) => ToolDef[];
}): () => PluginEntry {
  return () => {
    // The factory is identity at runtime — all type magic is compile-time only.
    const toolFactory = ((toolDef: unknown) => toolDef) as ToolFactory<Static<TConfigSchema>>;
    const toolDefs = def.tools(toolFactory);

    return {
      id: def.id,
      name: def.name,
      description: def.description,
      activation: def.activation ?? { onStartup: true },
      // Derive contracts from the declared tools so the manifest is always accurate.
      contracts: { tools: toolDefs.map((t) => t.name) },
      // TypeBox TObject is valid JSON Schema — pass through for the manifest generator.
      configSchema: def.configSchema as unknown as PluginEntry["configSchema"],
      register(api: PluginApi) {
        // OpenClaw validates pluginConfig against configSchema before calling register(),
        // so this cast is safe. Fall back to empty object if config is not yet set.
        const config = (api.pluginConfig ?? {}) as Static<TConfigSchema>;

        for (const toolDef of toolDefs) {
          api.registerTool({
            name: toolDef.name,
            label: toolDef.label ?? toolDef.name,
            description: toolDef.description,
            parameters: toolDef.parameters,
            // Wrap the result automatically — execute() returns plain values, not formatResult().
            execute: async (_toolCallId: string, params: Record<string, unknown>) =>
              formatResult(await toolDef.execute(params, config)),
          });
        }
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Low-level types — the plugin contract
//
// These are used by the generated adapter and by advanced plugins that need
// more control than definePlugin provides (e.g. dynamic tool registration).
// ---------------------------------------------------------------------------

/**
 * The API object passed to your plugin's `register()` function.
 *
 * When using `definePlugin`, you never see this directly — the SDK handles it.
 * It is exported for advanced use cases and for the generated adapter.
 */
export type PluginApi = {
  /** Register a tool with OpenClaw. Call once per tool inside register(). */
  registerTool: (tool: unknown) => void;
  /**
   * The user's config values for this plugin, keyed by field name.
   * Validated against configSchema by OpenClaw before register() is called.
   * May be undefined if the user has not configured the plugin.
   */
  pluginConfig?: Record<string, unknown>;
};

/**
 * The object returned by `createEntry()` — the plugin's public contract.
 *
 * When using `definePlugin`, this is constructed automatically.
 * Exported for advanced plugins that build it manually.
 */
export interface PluginEntry {
  /** Unique plugin id. Used as the CLI binary name and OpenClaw config key. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** One-sentence description. */
  description?: string;
  /** Tool names this plugin promises to register. Derived automatically by `definePlugin`. */
  contracts?: { tools: string[] };
  /** When to load the plugin. Defaults to `{ onStartup: true }`. */
  activation?: { onStartup?: boolean };
  /**
   * JSON Schema for the plugin's config block.
   * Pass a TypeBox `Type.Object(...)` — it is valid JSON Schema and gives you type inference.
   */
  configSchema?: unknown;
  /** Called once by OpenClaw at startup. Use `definePlugin` instead of implementing this directly. */
  register(api: PluginApi): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a value in the standard OpenClaw tool result format.
 *
 * When using `definePlugin`, you do NOT call this yourself — the SDK calls it
 * automatically after your `execute` function returns.
 *
 * For advanced plugins that implement `register()` directly, wrap your
 * execute return values with this function.
 *
 * @param data - Anything JSON-serialisable, or a plain string.
 * @returns `{ content: [{ type: "text", text: "<json>" }], details: {} }`
 */
export function formatResult(data: unknown) {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else {
    try {
      text = JSON.stringify(data) ?? String(data);
    } catch {
      text = String(data);
    }
  }
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Create the plugin's OpenClaw adapter export.
 *
 * **You never call this yourself.** It is called by the generated `dist/adapter.js`.
 *
 * Attempts to load the optional `openclaw` peer dependency and wrap the plugin
 * entry with the host's `definePluginEntry()`. Falls back to the raw entry if
 * `openclaw` is not installed (standalone CLI mode).
 *
 * @param entry - The object returned by `createEntry()`.
 * @param callerUrl - Pass `import.meta.url` from the generated adapter file.
 */
export function createAdapter(entry: PluginEntry, callerUrl: string): unknown {
  // Ensure contracts.tools is populated even for plugins using raw register().
  // Dry-run register() with a fake API to collect tool names.
  const enriched = ensureContracts(entry);

  const req = createRequire(callerUrl);

  try {
    const sdk = req("openclaw/plugin-sdk/plugin-entry") as {
      definePluginEntry?: (e: unknown) => unknown;
    };

    if (typeof sdk.definePluginEntry !== "function") {
      throw new Error(
        "OpenClaw SDK loaded but did not export `definePluginEntry`. Upgrade the `openclaw` package.",
      );
    }

    return sdk.definePluginEntry(enriched);
  } catch (err: unknown) {
    if (isModuleNotFoundError(err)) return enriched;
    throw err;
  }
}

/**
 * If the entry lacks contracts.tools, dry-run register() to discover tool names.
 */
function ensureContracts(entry: PluginEntry): PluginEntry {
  if (entry.contracts?.tools?.length) return entry;

  try {
    const toolNames: string[] = [];
    const fakeApi: PluginApi = {
      registerTool: (tool: unknown) => {
        if (tool && typeof tool === "object" && "name" in tool) {
          toolNames.push((tool as { name: string }).name);
        }
      },
      pluginConfig: {},
    };
    entry.register(fakeApi);
    if (toolNames.length > 0) {
      entry.contracts = { tools: toolNames };
    }
  } catch {
    // register() may have side effects that fail without a real API — ignore.
  }

  return entry;
}

function isModuleNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    "code" in err &&
    ((err as { code: string }).code === "MODULE_NOT_FOUND" ||
      (err as { code: string }).code === "ERR_MODULE_NOT_FOUND")
  );
}

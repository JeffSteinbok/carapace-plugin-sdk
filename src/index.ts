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
import {
  buildToolCallContext,
  EMPTY_TOOL_CALL_CONTEXT,
  type HostToolContext,
  type ToolCallContext,
  type ToolLogger,
} from "./access.js";

export * from "./access.js";

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
  execute(params: Record<string, unknown>, config: unknown, ctx: ToolCallContext): Promise<unknown>;
  view?(result: unknown, params: Record<string, unknown>): unknown;
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
   * @param ctx - Trusted, frozen per-call context from the OpenClaw runtime (agent id,
   *   message channel, verified sender, owner bit, root-config `accessGroups`). Fields
   *   are absent in the standalone CLI. Use with `checkAccess()`. Optional to declare.
   * @returns Any JSON-serialisable value. The SDK wraps it in the OpenClaw result format.
   */
  execute(params: Static<TSchema>, config: TConfig, ctx: ToolCallContext): Promise<unknown>;
  /**
   * Optional compact view for the model (v3.2).
   *
   * Return what the model needs to read (a smaller object, or a string). The model
   * gets this as the tool result's text; `details` still carries the full result
   * from `execute`, so Code Mode scripts and result grading are unchanged. Use it
   * when a tool's raw output is much larger than what an agent needs, e.g. a list
   * of entities with every attribute. Not applied to failures (a top-level truthy
   * `error` or `ok: false`), so the model always sees the full error.
   */
  view?(result: any, params: Static<TSchema>): unknown;
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

        const logger = api.logger;

        for (const toolDef of toolDefs) {
          api.registerTool(createToolFactory(toolDef, config, logger), { name: toolDef.name });
        }
      },
    };
  };
}

/**
 * Build the value passed to `api.registerTool` for one tool.
 *
 * OpenClaw only hands the trusted runtime context (agent, sender, channel) to
 * tool FACTORIES, so each tool is registered as a factory
 * `(toolContext) => tool` whose `execute` forwards a {@link ToolCallContext}.
 *
 * For backward compatibility the factory function also carries the static tool
 * shape (`name`, `label`, `description`, `parameters`, and an `execute` that
 * runs with an empty context). Hosts that inspect `tool.name`, wrappers that
 * filter registrations by name, the standalone CLI, and test harnesses that
 * call `tool.execute(id, params)` directly all keep working unchanged.
 */
function createToolFactory(toolDef: ToolDef, config: unknown, logger: ToolLogger | undefined) {
  const makeTool = (resolveCtx: () => ToolCallContext) => ({
    name: toolDef.name,
    label: toolDef.label ?? toolDef.name,
    description: toolDef.description,
    parameters: toolDef.parameters,
    // Wrap the result automatically — execute() returns plain values, not formatResult().
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = await toolDef.execute(params, config, resolveCtx());
      return formatResult(result, modelView(toolDef, result, params, logger));
    },
  });

  // The context is resolved per call so accessGroups come from the live runtime config.
  const factory = (toolContext?: HostToolContext) =>
    makeTool(() => buildToolCallContext(toolContext, logger));

  const staticTool = makeTool(() => (logger ? buildToolCallContext(undefined, logger) : EMPTY_TOOL_CALL_CONTEXT));
  for (const [key, value] of Object.entries(staticTool)) {
    // `name` is a read-only (but configurable) Function property, so define rather than assign.
    Object.defineProperty(factory, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return factory as typeof factory & typeof staticTool;
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
  /**
   * Register a tool (or tool factory) with OpenClaw. Call once per tool inside register().
   * `definePlugin` registers factories and passes `{ name }` so the host can match
   * the factory to `contracts.tools`; wrappers should forward `opts` unchanged.
   */
  registerTool: (tool: unknown, opts?: { name?: string; names?: string[]; optional?: boolean }) => void;
  /** Plugin-scoped logger provided by the host, when available. */
  logger?: ToolLogger;
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
 * Both fields carry the result: `content` is the text the model reads on a
 * direct tool call, and `details` is the structured value. OpenClaw Code Mode
 * hands `details` (not `content`) to the calling script, and grades the call
 * from it — so a top-level `ok: false`, truthy `error`, or failure-word
 * `status` (e.g. "failed", "unavailable") marks the call failed.
 *
 * Pass `view` (v3.2) to give the model a compact text while `details` keeps the
 * full `data`. Without it, both carry the same value, as before.
 *
 * @param data - Anything JSON-serialisable, or a plain string.
 * @param view - Optional model-facing value (object or string) to use as `content`.
 * @returns `{ content: [{ type: "text", text: "<json>" }], details: <data> }`
 */
export function formatResult(data: unknown, view?: unknown) {
  const full = serialize(data);
  const text = view === undefined ? full.text : serialize(view).text;
  return {
    content: [{ type: "text" as const, text }],
    details: full.details,
  };
}

function serialize(data: unknown): { text: string; details: unknown } {
  if (typeof data === "string") {
    return { text: data, details: data };
  }
  try {
    const json = JSON.stringify(data);
    if (json === undefined) {
      return { text: String(data), details: {} };
    }
    // Round-trip so details matches content exactly (Dates as strings, no functions).
    return { text: json, details: JSON.parse(json) };
  } catch {
    return { text: String(data), details: {} };
  }
}

/** True for results the SDK treats as failures; those always reach the model in full. */
function isFailure(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return Boolean(r.error) || r.ok === false || r.success === false;
}

/** The tool's model view of `result`, or undefined to send the full result. */
function modelView(
  toolDef: ToolDef,
  result: unknown,
  params: Record<string, unknown>,
  logger: ToolLogger | undefined,
): unknown {
  if (!toolDef.view || isFailure(result)) return undefined;
  try {
    return toolDef.view(result, params);
  } catch (e) {
    // A broken view must never break the tool: fall back to the full result.
    logger?.warn?.(`${toolDef.name}: view() threw, sending the full result: ${(e as Error).message}`);
    return undefined;
  }
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
  // v2: contracts.tools is required — plugins must declare tools via definePlugin
  // or set contracts.tools explicitly. The ensureContracts fallback has been removed.
  if (!entry.contracts?.tools?.length) {
    throw new Error(
      `Plugin "${entry.id ?? entry.name}" is missing contracts.tools. ` +
      `Migrate to definePlugin() from carapace-plugin-sdk — see https://github.com/JeffSteinbok/carapace-plugin-sdk`,
    );
  }

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

    const defined = sdk.definePluginEntry(entry) as Record<string, unknown>;
    // definePluginEntry may strip contracts — preserve them from the entry.
    if (entry.contracts && !defined.contracts) {
      defined.contracts = entry.contracts;
    }
    return defined;
  } catch (err: unknown) {
    if (isModuleNotFoundError(err)) return entry;
    throw err;
  }
}

function isModuleNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    "code" in err &&
    ((err as { code: string }).code === "MODULE_NOT_FOUND" ||
      (err as { code: string }).code === "ERR_MODULE_NOT_FOUND")
  );
}

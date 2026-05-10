/**
 * carapace-plugin-sdk/cli — CLI runtime.
 *
 * Turns any OpenClaw plugin into a standalone command-line tool — for free.
 * You never import this directly. It is called by the generated
 * `dist/bin/<plugin-id>.js` that `carapace-generate-cli` emits at build time.
 *
 * How it works end-to-end:
 *   1. Build time: `carapace-generate-cli` imports your `createEntry()`,
 *      reads the plugin metadata, and writes `dist/bin/<plugin>.js`.
 *   2. Run time: the generated file calls `run(createEntry(), options)`.
 *   3. `run()` calls `register()` with a mock API to collect tool definitions,
 *      maps environment variables → pluginConfig, parses argv, finds the right
 *      tool, builds its params, and calls execute().
 *
 * Config via environment variables:
 *   Each field in configSchema.properties maps to an env var:
 *     <PLUGIN_ID_SCREAMING_SNAKE>_<FIELD_SCREAMING_SNAKE>
 *   Example: plugin `stock-quotes`, field `finnhubApiKey`
 *     → env var `STOCK_QUOTES_FINNHUB_API_KEY`
 *
 * @module carapace-plugin-sdk/cli
 */

import type { PluginEntry } from "./index.js";

// ---------------------------------------------------------------------------
// Internal types
//
// These mirror the public PluginTool/PluginToolSchema types but are kept
// private here so the cli module doesn't re-export them. The runtime only
// needs to read these shapes; it never constructs them.
// ---------------------------------------------------------------------------

/** A single tool parameter schema, as returned by TypeBox or hand-written JSON Schema. */
interface ToolParam {
  type: string;
  description?: string;
  items?: { type: string };
  minItems?: number;
  enum?: string[];
}

/** The full parameter schema for a tool (always an object at the top level). */
interface ToolSchema {
  type: "object";
  properties: Record<string, ToolParam>;
  required?: string[];
}

/** Shape of configSchema.properties entries — used when reading env vars and printing help. */
interface ConfigField {
  type: string;
  description?: string;
}

/** The configSchema shape the CLI reads from PluginEntry. */
interface ConfigSchema {
  properties?: Record<string, ConfigField>;
}

/** Cast an unknown configSchema to the readable shape. Returns null if not usable. */
function asConfigSchema(schema: unknown): ConfigSchema | null {
  if (schema && typeof schema === "object" && "properties" in schema) {
    return schema as ConfigSchema;
  }
  return null;
}

/** A registered tool as captured from register(). */
interface Tool {
  name: string;
  label?: string;
  description?: string;
  parameters?: ToolSchema;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown>;
}

/**
 * Options for the CLI runner.
 * These are set by the generated bin file — plugin authors never pass them manually.
 */
export interface RunOptions {
  /**
   * Prefix used when mapping environment variables to plugin config fields.
   * Generated from the plugin id: "stock-quotes" → "STOCK_QUOTES".
   * Override with `--name` when generating the CLI to use a custom prefix.
   */
  envPrefix?: string;
  /**
   * The binary name shown in --help usage lines and error messages.
   * Defaults to the plugin's `id`.
   */
  binName?: string;
}

// ---------------------------------------------------------------------------
// Env → config mapping
//
// When running as a CLI (outside OpenClaw), config comes from environment
// variables instead of the host's config store. This section converts them.
// ---------------------------------------------------------------------------

/**
 * Build the environment variable name for a given plugin prefix + config field.
 *
 * Converts camelCase field names to SCREAMING_SNAKE_CASE and prepends the prefix.
 *
 * @example
 * envVarName("STOCK_QUOTES", "finnhubApiKey") // → "STOCK_QUOTES_FINNHUB_API_KEY"
 * envVarName("MY_PLUGIN", "defaultName")      // → "MY_PLUGIN_DEFAULT_NAME"
 */
function envVarName(prefix: string, field: string): string {
  const snake = field.replace(/([A-Z])/g, "_$1").toUpperCase();
  return `${prefix}_${snake}`;
}

/**
 * Build a pluginConfig object from environment variables.
 *
 * Reads each field declared in `configSchema.properties` from a corresponding
 * env var. Missing env vars are silently skipped (the plugin's `buildConfig()`
 * is responsible for applying defaults).
 *
 * @param prefix - The SCREAMING_SNAKE_CASE plugin prefix (e.g. "STOCK_QUOTES").
 * @param schema - The plugin's configSchema, used to know which fields to look for.
 */
function buildConfigFromEnv(
  prefix: string,
  schema?: unknown,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const cs = asConfigSchema(schema);
  if (!cs?.properties) return config;

  for (const [field, def] of Object.entries(cs.properties)) {
    const envName = envVarName(prefix, field);
    const val = process.env[envName]?.trim();
    if (val) {
      // Coerce numeric fields so the plugin receives the right type.
      config[field] = def.type === "number" ? Number(val) : val;
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

/** Output of parseArgs(). */
interface ParsedArgs {
  /** The first non-flag argument (the subcommand / tool name). */
  command: string | null;
  /** Remaining non-flag arguments after the command. */
  positional: string[];
  /** --flag and --flag=value pairs. Boolean flags are stored as `true`. */
  flags: Record<string, string | boolean>;
}

/**
 * Minimal argv parser — no external dependencies.
 *
 * Rules:
 *   - `--flag value`  → flags["flag"] = "value"
 *   - `--flag=value`  → flags["flag"] = "value"
 *   - `--flag`        → flags["flag"] = true  (when next arg is another flag or absent)
 *   - First non-flag  → command
 *   - Subsequent non-flags → positional[]
 *
 * @param argv - Typically `process.argv.slice(2)`.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        // --flag=value form
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          // --flag value form
          flags[arg.slice(2)] = next;
          i++; // consume the value token
        } else {
          // Boolean flag: --help, --json, etc.
          flags[arg.slice(2)] = true;
        }
      }
    } else if (!command) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

// ---------------------------------------------------------------------------
// Help generation
// ---------------------------------------------------------------------------

/**
 * Print the --help screen to stdout.
 *
 * Shows:
 *   - Plugin name and description
 *   - Each registered tool as a subcommand with its parameters
 *   - Global options (--json, --help)
 *   - Environment variables (if the plugin has configSchema fields)
 */
function printHelp(entry: PluginEntry, tools: Tool[], binName: string, envPrefix?: string) {
  console.log(`${binName} — ${entry.description ?? entry.name}\n`);
  console.log("Usage:");
  console.log(`  ${binName} <command> [args...] [--json]\n`);
  console.log("Commands:");

  for (const tool of tools) {
    // Build a short param signature like "<city> <units>" or "<symbols...>"
    const params = tool.parameters?.properties
      ? Object.keys(tool.parameters.properties)
          .map((p) => {
            const schema = tool.parameters!.properties[p];
            // Array params consume all remaining positional args → show with "..."
            return schema.type === "array" ? `<${p}...>` : `<${p}>`;
          })
          .join(" ")
      : "";
    // Normalise underscores to hyphens for display (tool names are stored with underscores)
    const cmdName = tool.name.replace(/_/g, "-");
    console.log(`  ${cmdName.padEnd(20)} ${params.padEnd(20)} ${tool.description ?? ""}`);
  }

  console.log("\nOptions:");
  console.log("  --json            Output raw JSON instead of pretty-printed text");
  console.log("  --help, -h        Show this help");

  // Show the env var section only if the plugin actually has config fields.
  const cs = asConfigSchema(entry.configSchema);
  if (envPrefix && cs?.properties) {
    console.log("\nEnvironment:");
    for (const [field, def] of Object.entries(cs.properties)) {
      const envName = envVarName(envPrefix, field);
      console.log(`  ${envName.padEnd(30)} ${def.description ?? ""}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Unwrap a formatResult() envelope and pretty-print its contents.
 *
 * OpenClaw tool results are wrapped as `{ content: [{ type: "text", text: "..." }] }`.
 * This function peels that off and delegates to formatPrettyValue() for human output.
 * When `--json` is used, the caller handles output directly (no pretty printing).
 */
function formatPretty(result: unknown): string {
  if (result == null) return "";

  // Unwrap the standard formatResult() envelope.
  const content = (result as { content?: { text?: string }[] })?.content;
  if (Array.isArray(content) && content[0]?.text) {
    try {
      // The text is usually JSON — parse it for pretty formatting.
      const parsed = JSON.parse(content[0].text);
      return formatPrettyValue(parsed);
    } catch {
      // Not valid JSON — print the raw text.
      return content[0].text;
    }
  }

  // Result wasn't wrapped with formatResult() — format it directly.
  return formatPrettyValue(result);
}

/**
 * Recursively pretty-print a value.
 *
 * Strings are returned as-is. Arrays are printed one item per line.
 * Objects with an `error` key are shown as "Error: <message>".
 * Everything else falls back to JSON.stringify with indentation.
 */
function formatPrettyValue(val: unknown): string {
  if (typeof val === "string") return val;
  if (typeof val !== "object" || val === null) return String(val);
  if ("error" in val) return `Error: ${(val as { error: string }).error}`;
  if (Array.isArray(val)) return val.map((item) => formatPrettyValue(item)).join("\n");
  return JSON.stringify(val, null, 2);
}

// ---------------------------------------------------------------------------
// Tool matching
// ---------------------------------------------------------------------------

/**
 * Find the tool that best matches the given command string.
 *
 * Matching order (first match wins):
 *   1. Exact match on `tool.name`
 *   2. Hyphens normalised to underscores (CLI users prefer hyphens; tool names use underscores)
 *   3. Suffix match — "quote" matches "stock_quote" (convenience shorthand)
 *   4. If there's only one tool, use it regardless of the command name
 *      (lets `my-plugin some-value` work without typing the subcommand)
 */
function matchTool(tools: Tool[], command: string): Tool | undefined {
  const exact = tools.find((t) => t.name === command);
  if (exact) return exact;

  const normalized = command.replace(/-/g, "_");
  const norm = tools.find((t) => t.name === normalized);
  if (norm) return norm;

  const suffix = tools.find((t) => t.name.endsWith(`_${normalized}`));
  if (suffix) return suffix;

  // Single-tool convenience: the user typed anything, just use the only tool.
  if (tools.length === 1) return tools[0];
  return undefined;
}

/**
 * Map positional args and flags onto the tool's declared parameter schema.
 *
 * Parameters are filled in schema order:
 *   1. Flags (`--param-name value` or `--param-name=value`) take priority.
 *   2. Array-typed params consume all remaining positional args.
 *   3. Other params consume positional args left-to-right.
 *
 * Flag names are normalised: `--my-param` matches schema key `myParam` or `my_param`.
 */
function buildParams(tool: Tool, positional: string[], flags: Record<string, string | boolean>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const schema = tool.parameters?.properties;
  if (!schema) return params;

  const paramNames = Object.keys(schema);
  let posIdx = 0; // index into positional[], advanced as we consume args

  for (const name of paramNames) {
    const def = schema[name];
    // Flags can be passed with hyphens even if the schema uses camelCase/underscores.
    const flagName = name.replace(/_/g, "-");
    if (flagName in flags) { params[name] = flags[flagName]; continue; }
    if (name in flags)     { params[name] = flags[name];     continue; }

    if (def.type === "array") {
      // Array param: greedily consume all remaining positional args.
      params[name] = positional.slice(posIdx);
      posIdx = positional.length;
      continue;
    }

    // Scalar param: consume the next positional arg.
    if (posIdx < positional.length) {
      params[name] = positional[posIdx++];
    }
  }

  return params;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Entry point for the generated CLI binary.
 *
 * Call this from the auto-generated `dist/bin/<plugin-id>.js`:
 *
 * ```js
 * import { run } from "carapace-plugin-sdk/cli";
 * import { createEntry } from "../index.js";
 * run(createEntry(), { binName: "my-plugin", envPrefix: "MY_PLUGIN" });
 * ```
 *
 * You never write that file manually — `carapace-generate-cli` emits it.
 *
 * @param entry - The object returned by your plugin's `createEntry()`.
 * @param options - Binary name and env prefix (set by the generated file).
 */
export async function run(entry: PluginEntry, options: RunOptions = {}): Promise<void> {
  const binName  = options.binName  ?? entry.id;
  const envPrefix = options.envPrefix ?? entry.id.replace(/-/g, "_").toUpperCase();

  // Call register() with a lightweight mock API to collect tool definitions.
  // This does NOT invoke any tool logic — it just gathers metadata.
  const tools: Tool[] = [];
  const config = buildConfigFromEnv(envPrefix, entry.configSchema);
  entry.register({
    registerTool: (tool: unknown) => tools.push(tool as Tool),
    pluginConfig: config,
  });

  const argv = process.argv.slice(2);
  const { command, positional, flags } = parseArgs(argv);

  // Show help when explicitly requested or when invoked with no arguments.
  if (flags.help || flags.h || (!command && positional.length === 0)) {
    printHelp(entry, tools, binName, envPrefix);
    process.exit(0);
  }

  const json = !!flags.json;
  // Remove meta-flags so they don't leak into buildParams().
  delete flags.json;
  delete flags.help;
  delete flags.h;

  // Find the matching tool. Error out clearly if not found.
  const tool = matchTool(tools, command ?? "");
  if (!tool) {
    console.error(`Unknown command: ${command}`);
    console.error(`Run \`${binName} --help\` for available commands.`);
    process.exit(1);
  }

  // Single-tool convenience: if the user typed `my-plugin some-value` and the
  // plugin only has one tool, treat "some-value" as the first positional arg
  // rather than the (wrong) command name.
  let effectivePositional = positional;
  if (tools.length === 1 && command && !tools.find((t) => t.name === command.replace(/-/g, "_"))) {
    effectivePositional = [command, ...positional];
  }

  const params = buildParams(tool, effectivePositional, flags);

  try {
    const result = await tool.execute("cli", params);

    if (json) {
      // Raw JSON output — unwrap the formatResult envelope if present.
      const content = (result as { content?: { text?: string }[] })?.content;
      if (Array.isArray(content) && content[0]?.text) {
        try {
          // Re-parse and re-stringify to get consistent indentation.
          console.log(JSON.stringify(JSON.parse(content[0].text), null, 2));
        } catch {
          console.log(content[0].text);
        }
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } else {
      const output = formatPretty(result);
      if (output) console.log(output);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

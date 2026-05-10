/**
 * carapace-plugin-sdk/tsup — Shared tsup configuration factory for OpenClaw plugins.
 *
 * Import this in your plugin's tsup.config.ts to get the standard build
 * settings without repeating them in every plugin:
 *
 * ```ts
 * // tsup.config.ts  (the whole file)
 * import { defineConfig } from "tsup";
 * import { definePluginConfig } from "carapace-plugin-sdk/tsup";
 * export default defineConfig(definePluginConfig());
 * ```
 *
 * Works identically in standalone plugin repos and in workspace monorepos —
 * the configuration is the same in both cases.
 *
 * To add extra entry points or override any setting, pass an overrides object:
 *
 * ```ts
 * export default defineConfig(definePluginConfig({
 *   entry: ["src/plugin.ts", "src/extra.ts"],
 * }));
 * ```
 *
 * @module carapace-plugin-sdk/tsup
 */

/**
 * Options accepted by tsup's defineConfig. Typed loosely so this file does
 * not need tsup as a runtime dependency — the plugin's own tsup install is used.
 */
type PluginConfigOverrides = Record<string, unknown>;

/**
 * Returns the standard tsup configuration for an OpenClaw plugin.
 *
 * Defaults:
 *   - entry: ["src/plugin.ts"]  — your plugin definition file
 *   - format: ESM only (OpenClaw and Node 20+ are fully ESM)
 *   - outDir: dist
 *   - dts: false (type declarations are not needed at runtime)
 *   - sourcemap: true (for debuggable stack traces)
 *   - clean: true (remove stale dist files before each build)
 *   - target: node20
 *   - splitting, shims: false (keeps output simple and portable)
 *   - skipNodeModulesBundle: true (dependencies are not inlined)
 *
 * Note: `src/adapter.ts` is intentionally NOT in the default entry list.
 * The adapter (`dist/adapter.js`) is generated at build time by
 * `carapace-generate-cli` and does not need to be compiled from source.
 *
 * @param overrides - Any tsup config options to merge on top of the defaults.
 */
export function definePluginConfig(overrides: PluginConfigOverrides = {}): PluginConfigOverrides {
  return {
    entry: ["src/plugin.ts"],
    format: ["esm"],
    outDir: "dist",
    dts: false,
    sourcemap: true,
    clean: true,
    target: "node20",
    splitting: false,
    shims: false,
    skipNodeModulesBundle: true,
    ...overrides,
  };
}

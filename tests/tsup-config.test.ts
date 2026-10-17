import { describe, it, expect } from "vitest";
import { definePluginConfig } from "../src/tsup.plugin.config.js";

// ---------------------------------------------------------------------------
// definePluginConfig
// ---------------------------------------------------------------------------

describe("definePluginConfig", () => {
  it("inlines @sinclair/typebox but no other dependency", () => {
    const [pattern] = definePluginConfig().noExternal as RegExp[];
    expect(pattern.test("@sinclair/typebox")).toBe(true);
    expect(pattern.test("@sinclair/typebox/value")).toBe(true);
    expect(pattern.test("@sinclair/typebox-codegen")).toBe(false);
    expect(pattern.test("@octokit/rest")).toBe(false);
  });

  it("lets overrides replace defaults", () => {
    expect(definePluginConfig({ noExternal: [] }).noExternal).toEqual([]);
  });
});

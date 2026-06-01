import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import { formatResult, definePlugin, ensureContracts, type PluginEntry } from "../src/index.js";

// ---------------------------------------------------------------------------
// formatResult
// ---------------------------------------------------------------------------

describe("formatResult", () => {
  it("wraps an object as JSON text content", () => {
    const result = formatResult({ price: 42, symbol: "AAPL" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ price: 42, symbol: "AAPL" });
  });

  it("passes strings through without double-encoding", () => {
    const result = formatResult("hello");
    expect(result.content[0].text).toBe("hello");
  });

  it("includes an empty details object", () => {
    expect(formatResult(null).details).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// definePlugin
// ---------------------------------------------------------------------------

describe("definePlugin", () => {
  const createEntry = definePlugin({
    id: "test-plugin",
    name: "Test Plugin",
    description: "A plugin for testing.",
    configSchema: Type.Object({
      greeting: Type.Optional(Type.String()),
    }),
    tools: (tool) => [
      tool({
        name: "greet",
        description: "Say hello.",
        parameters: Type.Object({
          name: Type.String(),
        }),
        execute: async ({ name }, config) => ({
          message: `${config.greeting ?? "Hello"}, ${name}!`,
        }),
      }),
    ],
  });

  it("returns a createEntry function", () => {
    expect(typeof createEntry).toBe("function");
  });

  it("createEntry() returns correct plugin metadata", () => {
    const entry = createEntry();
    expect(entry.id).toBe("test-plugin");
    expect(entry.name).toBe("Test Plugin");
    expect(entry.description).toBe("A plugin for testing.");
  });

  it("derives contracts from tool names", () => {
    const entry = createEntry();
    expect(entry.contracts?.tools).toEqual(["greet"]);
  });

  it("defaults activation to onStartup: true", () => {
    const entry = createEntry();
    expect(entry.activation?.onStartup).toBe(true);
  });

  it("registers tools and execute returns formatResult-wrapped output", async () => {
    const entry = createEntry();
    const tools: Record<string, any> = {};
    entry.register({
      registerTool: (t: any) => { tools[t.name] = t; },
      pluginConfig: { greeting: "Howdy" },
    });

    expect(tools["greet"]).toBeDefined();

    const result = await tools["greet"].execute("call-1", { name: "World" });
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ message: "Howdy, World!" });
  });

  it("uses config defaults when pluginConfig is empty", async () => {
    const entry = createEntry();
    const tools: Record<string, any> = {};
    entry.register({
      registerTool: (t: any) => { tools[t.name] = t; },
      pluginConfig: {},
    });

    const result = await tools["greet"].execute("call-2", { name: "World" });
    expect(JSON.parse(result.content[0].text)).toEqual({ message: "Hello, World!" });
  });
});

// ---------------------------------------------------------------------------
// ensureContracts
// ---------------------------------------------------------------------------

describe("ensureContracts", () => {
  it("returns entry unchanged when contracts.tools is already populated", () => {
    const entry: PluginEntry = {
      id: "already-set",
      name: "Already Set",
      contracts: { tools: ["existing_tool"] },
      register() {},
    };
    const result = ensureContracts(entry);
    expect(result.contracts?.tools).toEqual(["existing_tool"]);
    expect(result).toBe(entry); // same reference — no mutation
  });

  it("discovers tool names from register() when contracts is missing", () => {
    const entry: PluginEntry = {
      id: "no-contracts",
      name: "No Contracts",
      register(api) {
        api.registerTool({ name: "tool_a", execute: async () => ({}) });
        api.registerTool({ name: "tool_b", execute: async () => ({}) });
      },
    };
    const result = ensureContracts(entry);
    expect(result.contracts?.tools).toEqual(["tool_a", "tool_b"]);
  });

  it("discovers tool names when contracts.tools is an empty array", () => {
    const entry: PluginEntry = {
      id: "empty-tools",
      name: "Empty Tools",
      contracts: { tools: [] },
      register(api) {
        api.registerTool({ name: "discovered" });
      },
    };
    const result = ensureContracts(entry);
    expect(result.contracts?.tools).toEqual(["discovered"]);
  });

  it("skips tools registered without a name property", () => {
    const entry: PluginEntry = {
      id: "nameless",
      name: "Nameless",
      register(api) {
        api.registerTool({ description: "no name field" });
        api.registerTool({ name: "valid_tool" });
      },
    };
    const result = ensureContracts(entry);
    expect(result.contracts?.tools).toEqual(["valid_tool"]);
  });

  it("handles register() that throws without crashing", () => {
    const entry: PluginEntry = {
      id: "throws",
      name: "Throws",
      register() {
        throw new Error("boom");
      },
    };
    const result = ensureContracts(entry);
    // contracts remains unset since register() failed
    expect(result.contracts).toBeUndefined();
  });

  it("does not set contracts when register() registers no tools", () => {
    const entry: PluginEntry = {
      id: "no-tools",
      name: "No Tools",
      register() {
        // intentionally registers nothing
      },
    };
    const result = ensureContracts(entry);
    expect(result.contracts).toBeUndefined();
  });

  it("works end-to-end with a definePlugin entry that omits contracts", () => {
    // definePlugin always sets contracts, but ensureContracts should still be a no-op
    const createEntry = definePlugin({
      id: "defined",
      name: "Defined",
      description: "A defined plugin.",
      tools: (tool) => [
        tool({
          name: "my_tool",
          description: "Does stuff.",
          parameters: Type.Object({}),
          execute: async () => ({}),
        }),
      ],
    });
    const entry = createEntry();
    const result = ensureContracts(entry);
    expect(result.contracts?.tools).toEqual(["my_tool"]);
  });
});

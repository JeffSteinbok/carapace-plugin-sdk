import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import { formatResult, definePlugin, type PluginEntry } from "../src/index.js";

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
// createAdapter — contracts validation (v2 breaking change)
// ---------------------------------------------------------------------------

describe("createAdapter contracts enforcement", () => {
  it("definePlugin always provides contracts — createEntry().contracts.tools is populated", () => {
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
    expect(entry.contracts?.tools).toEqual(["my_tool"]);
  });
});

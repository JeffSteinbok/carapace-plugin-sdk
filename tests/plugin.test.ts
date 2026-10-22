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

  it("carries the structured value in details", () => {
    expect(formatResult({ price: 42, symbol: "AAPL" }).details).toEqual({ price: 42, symbol: "AAPL" });
    expect(formatResult([1, 2]).details).toEqual([1, 2]);
    expect(formatResult(null).details).toBeNull();
  });

  it("carries strings in details unchanged", () => {
    expect(formatResult("hello").details).toBe("hello");
  });

  it("keeps details JSON-equivalent to content", () => {
    const when = new Date("2026-10-01T00:00:00Z");
    const result = formatResult({ when, fn: () => 1 });
    expect(result.details).toEqual(JSON.parse(result.content[0].text));
    expect(result.details).toEqual({ when: "2026-10-01T00:00:00.000Z" });
  });

  it("falls back to empty details when the value is not serialisable", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatResult(cyclic).details).toEqual({});
    expect(formatResult(undefined).details).toEqual({});
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
// definePlugin — tool factories and the per-call context (v3.1)
// ---------------------------------------------------------------------------

describe("definePlugin tool factories", () => {
  const seen: unknown[] = [];
  const createEntry = definePlugin({
    id: "ctx-plugin",
    name: "Ctx Plugin",
    tools: (tool) => [
      tool({
        name: "whoami",
        description: "Echo the call context.",
        parameters: Type.Object({}),
        execute: async (_params, _config, ctx) => {
          seen.push(ctx);
          return { agent: ctx.agentId ?? null, sender: ctx.requesterSenderId ?? null };
        },
      }),
      tool({
        name: "legacy",
        description: "Ignores ctx.",
        parameters: Type.Object({}),
        execute: async () => ({ ok: true }),
      }),
    ],
  });

  function register(logger?: { warn: (m: string) => void }) {
    const calls: Array<{ tool: any; opts: any }> = [];
    createEntry().register({
      registerTool: (tool: any, opts?: any) => { calls.push({ tool, opts }); },
      pluginConfig: {},
      logger,
    });
    return calls;
  }

  it("registers each tool as a factory with its name in opts", () => {
    const calls = register();
    expect(calls.map((c) => typeof c.tool)).toEqual(["function", "function"]);
    expect(calls.map((c) => c.opts)).toEqual([{ name: "whoami" }, { name: "legacy" }]);
  });

  it("factories also carry the static tool shape for older hosts and wrappers", async () => {
    const [{ tool }] = register();
    expect(tool.name).toBe("whoami");
    expect(tool.label).toBe("whoami");
    expect(tool.description).toBe("Echo the call context.");
    const result = await tool.execute("id", {});
    expect(result.details).toEqual({ agent: null, sender: null });
  });

  it("passes a frozen context built from the trusted tool context", async () => {
    seen.length = 0;
    const [{ tool }] = register();
    const concrete = tool({
      agentId: "family",
      sessionKey: "agent:family:imessage:direct:+14255550100",
      messageChannel: "iMessage",
      requesterSenderId: "+14255550100",
      senderIsOwner: false,
      sandboxed: false,
      getRuntimeConfig: () => ({ accessGroups: { kids: { type: "message.senders", members: {} } } }),
    });
    expect(concrete.name).toBe("whoami");
    const result = await concrete.execute("call", {});
    expect(result.details).toEqual({ agent: "family", sender: "+14255550100" });
    const ctx = seen[0] as Record<string, unknown>;
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx).toEqual({
      agentId: "family",
      sessionKey: "agent:family:imessage:direct:+14255550100",
      messageChannel: "imessage",
      requesterSenderId: "+14255550100",
      senderIsOwner: false,
      accessGroups: { kids: { type: "message.senders", members: {} } },
    });
    expect(ctx).not.toHaveProperty("sandboxed");
  });

  it("falls back from getRuntimeConfig to runtimeConfig to config for accessGroups", async () => {
    seen.length = 0;
    const [{ tool }] = register();
    await tool({ runtimeConfig: { accessGroups: { a: {} } }, config: { accessGroups: { b: {} } } }).execute("x", {});
    await tool({ config: { accessGroups: { b: {} } } }).execute("x", {});
    await tool({ getRuntimeConfig: () => { throw new Error("boom"); }, config: { accessGroups: { c: {} } } }).execute("x", {});
    expect((seen as any[]).map((c) => Object.keys(c.accessGroups))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("tools that ignore ctx keep working through the factory", async () => {
    const [, { tool }] = register();
    expect((await tool(undefined).execute("x", {})).details).toEqual({ ok: true });
    expect((await tool.execute("x", {})).details).toEqual({ ok: true });
  });

  it("exposes the host logger on ctx", async () => {
    seen.length = 0;
    const logger = { warn: () => {} };
    const [{ tool }] = register(logger);
    await tool({ agentId: "main" }).execute("x", {});
    expect((seen[0] as any).logger).toBe(logger);
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

import { describe, it, expect, vi } from "vitest";
import {
  ACCESS_CONFIG_SCHEMA,
  buildToolCallContext,
  canAccess,
  checkAccess,
  describeCaller,
  isAccessControlled,
  isSenderInGroup,
  matchesGrant,
  normalizeSenderId,
  type AccessConfig,
  type ToolCallContext,
} from "../src/index.js";

const accessGroups = {
  jeff: {
    type: "message.senders",
    members: {
      imessage: ["+1 (425) 555-0100", "Jeff@Example.com"],
      discord: ["discord:111111111111111111"],
      telegram: ["2222222222"],
    },
  },
  nicole: { type: "message.senders", members: { imessage: ["+14255550199"] } },
  everywhere: { type: "message.senders", members: { "*": ["+14255550123"] } },
  dynamic: { type: "discord.channelAudience", members: { discord: ["111111111111111111"] } },
};

const ctx = (over: Partial<ToolCallContext>): ToolCallContext => ({ accessGroups, ...over });

const acl: AccessConfig = {
  calendars: {
    family: { read: ["*"], write: ["*"] },
    personal: { read: [{ agent: "main" }, { sender: "jeff" }], write: [{ agent: "main" }] },
    nicole: { read: [{ agent: "main" }, { sender: "nicole" }] },
    both: { read: [{ agent: "family", sender: ["jeff", "nicole"] }] },
    owner: { read: [{ sender: "owner" }] },
  },
};

describe("normalizeSenderId", () => {
  it("lowercases emails and strips channel prefixes", () => {
    expect(normalizeSenderId("Jeff@Example.COM")).toBe("jeff@example.com");
    expect(normalizeSenderId("imessage:Jeff@Example.com")).toBe("jeff@example.com");
    expect(normalizeSenderId("mailto:jeff@example.com")).toBe("jeff@example.com");
  });

  it("normalises formatted phone numbers to E.164", () => {
    expect(normalizeSenderId("+1 (425) 555-0100")).toBe("+14255550100");
    expect(normalizeSenderId("imessage:+14255550100")).toBe("+14255550100");
    expect(normalizeSenderId("tel:425.555.0100")).toBe("+14255550100");
    expect(normalizeSenderId("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("treats bare digits as phones only on phone channels", () => {
    expect(normalizeSenderId("4255550100", "imessage")).toBe("+14255550100");
    expect(normalizeSenderId("14255550100", "sms")).toBe("+14255550100");
    expect(normalizeSenderId("2222222222", "telegram")).toBe("2222222222");
    expect(normalizeSenderId("111111111111111111", "discord")).toBe("111111111111111111");
  });

  it("strips discord prefixes and mention wrapping", () => {
    expect(normalizeSenderId("discord:111")).toBe("111");
    expect(normalizeSenderId("user:111")).toBe("111");
    expect(normalizeSenderId("<@!111>")).toBe("111");
  });
});

describe("isSenderInGroup", () => {
  it("matches members for the turn's channel", () => {
    expect(isSenderInGroup("jeff", ctx({ messageChannel: "imessage", requesterSenderId: "+14255550100" }))).toBe(true);
    expect(isSenderInGroup("jeff", ctx({ messageChannel: "imessage", requesterSenderId: "jeff@example.com" }))).toBe(true);
    expect(isSenderInGroup("jeff", ctx({ messageChannel: "discord", requesterSenderId: "111111111111111111" }))).toBe(true);
    expect(isSenderInGroup("jeff", ctx({ messageChannel: "telegram", requesterSenderId: "telegram:2222222222" }))).toBe(true);
  });

  it("does not match a member listed under a different channel", () => {
    expect(isSenderInGroup("jeff", ctx({ messageChannel: "telegram", requesterSenderId: "111111111111111111" }))).toBe(false);
    expect(isSenderInGroup("nicole", ctx({ messageChannel: "discord", requesterSenderId: "+14255550199" }))).toBe(false);
  });

  it("matches the '*' channel key for every channel", () => {
    expect(isSenderInGroup("everywhere", ctx({ messageChannel: "signal", requesterSenderId: "+14255550123" }))).toBe(true);
  });

  it("ignores unknown groups and non-static group types", () => {
    expect(isSenderInGroup("nobody", ctx({ messageChannel: "imessage", requesterSenderId: "+14255550100" }))).toBe(false);
    expect(isSenderInGroup("dynamic", ctx({ messageChannel: "discord", requesterSenderId: "111111111111111111" }))).toBe(false);
  });

  it("supports the special owner group", () => {
    expect(isSenderInGroup("owner", ctx({ requesterSenderId: "x", senderIsOwner: true }))).toBe(true);
    expect(isSenderInGroup("owner", ctx({ requesterSenderId: "x", senderIsOwner: false }))).toBe(false);
    expect(isSenderInGroup("owner", ctx({ senderIsOwner: true }))).toBe(false);
  });
});

describe("matchesGrant", () => {
  it("'*' matches anyone, including senderless turns", () => {
    expect(matchesGrant("*", undefined)).toBe(true);
    expect(matchesGrant("*", {})).toBe(true);
  });

  it("matches agents by id, list, or wildcard", () => {
    expect(matchesGrant({ agent: "main" }, { agentId: "main" })).toBe(true);
    expect(matchesGrant({ agent: "main" }, { agentId: "family" })).toBe(false);
    expect(matchesGrant({ agent: ["mail", "main"] }, { agentId: "main" })).toBe(true);
    expect(matchesGrant({ agent: "*" }, { agentId: "anything" })).toBe(true);
    expect(matchesGrant({ agent: "main" }, {})).toBe(false);
  });

  it("requires ALL fields to match", () => {
    const grant = { agent: "family", sender: "nicole" };
    expect(matchesGrant(grant, ctx({ agentId: "family", messageChannel: "imessage", requesterSenderId: "+14255550199" }))).toBe(true);
    expect(matchesGrant(grant, ctx({ agentId: "main", messageChannel: "imessage", requesterSenderId: "+14255550199" }))).toBe(false);
    expect(matchesGrant(grant, ctx({ agentId: "family", messageChannel: "imessage", requesterSenderId: "+14255550100" }))).toBe(false);
  });

  it("never matches a sender grant on a senderless turn", () => {
    expect(matchesGrant({ sender: "jeff" }, ctx({ agentId: "main" }))).toBe(false);
    expect(matchesGrant({ sender: "owner" }, ctx({ agentId: "main", senderIsOwner: true }))).toBe(false);
  });

  it("fails closed on empty grants and unknown fields", () => {
    expect(matchesGrant({}, { agentId: "main" })).toBe(false);
    expect(matchesGrant({ agents: "main" } as never, { agentId: "main" })).toBe(false);
    expect(matchesGrant({ agent: "main", extra: 1 } as never, { agentId: "main" })).toBe(false);
    expect(matchesGrant(null as never, { agentId: "main" })).toBe(false);
  });
});

describe("canAccess", () => {
  it("allows everything when there is no access block", () => {
    expect(canAccess(undefined, "calendars", "nicole", "write", {})).toBe(true);
    expect(canAccess({}, "calendars", "nicole", "write", {})).toBe(true);
    expect(canAccess({ mailboxes: {} }, "calendars", "nicole", "read", {})).toBe(true);
  });

  it("default-denies unlisted resources once the kind is configured", () => {
    expect(canAccess(acl, "calendars", "work", "read", { agentId: "main" })).toBe(false);
    expect(canAccess({ calendars: {} }, "calendars", "family", "read", { agentId: "main" })).toBe(false);
  });

  it("denies an op with no grant list", () => {
    expect(canAccess(acl, "calendars", "nicole", "read", { agentId: "main" })).toBe(true);
    expect(canAccess(acl, "calendars", "nicole", "write", { agentId: "main" })).toBe(false);
  });

  it("applies wildcard grants", () => {
    expect(canAccess(acl, "calendars", "family", "write", {})).toBe(true);
    expect(canAccess(acl, "calendars", "family", "read", ctx({ agentId: "group", messageChannel: "imessage", requesterSenderId: "+19995550000" }))).toBe(true);
  });

  it("allows by agent OR by sender", () => {
    expect(canAccess(acl, "calendars", "personal", "read", { agentId: "main" })).toBe(true);
    expect(canAccess(acl, "calendars", "personal", "read", ctx({ agentId: "family", messageChannel: "imessage", requesterSenderId: "+14255550100" }))).toBe(true);
    expect(canAccess(acl, "calendars", "personal", "read", ctx({ agentId: "family", messageChannel: "imessage", requesterSenderId: "+14255550199" }))).toBe(false);
    expect(canAccess(acl, "calendars", "personal", "write", ctx({ agentId: "family", messageChannel: "imessage", requesterSenderId: "+14255550100" }))).toBe(false);
  });

  it("senderless turns (cron/CLI) only get agent and wildcard grants", () => {
    expect(canAccess(acl, "calendars", "personal", "read", ctx({ agentId: "family" }))).toBe(false);
    expect(canAccess(acl, "calendars", "family", "read", ctx({ agentId: "family" }))).toBe(true);
    expect(canAccess(acl, "calendars", "personal", "read", undefined)).toBe(false);
  });

  it("supports sender lists within one grant", () => {
    const base = { agentId: "family", messageChannel: "imessage" };
    expect(canAccess(acl, "calendars", "both", "read", ctx({ ...base, requesterSenderId: "+14255550199" }))).toBe(true);
    expect(canAccess(acl, "calendars", "both", "read", ctx({ ...base, requesterSenderId: "+14255550100" }))).toBe(true);
    expect(canAccess(acl, "calendars", "both", "read", ctx({ ...base, requesterSenderId: "+14255550123" }))).toBe(false);
  });

  it("supports owner grants", () => {
    expect(canAccess(acl, "calendars", "owner", "read", { requesterSenderId: "123", senderIsOwner: true })).toBe(true);
    expect(canAccess(acl, "calendars", "owner", "read", { requesterSenderId: "123", senderIsOwner: false })).toBe(false);
  });

  it("does not treat inherited object keys as resources", () => {
    expect(canAccess(acl, "calendars", "toString", "read", { agentId: "main" })).toBe(false);
  });
});

describe("checkAccess", () => {
  it("returns a clear denial message and logs it once", () => {
    const warn = vi.fn();
    const decision = checkAccess(acl, "calendars", "nicole", "read", ctx({
      agentId: "family",
      messageChannel: "imessage",
      requesterSenderId: "imessage:+1 425 555 0100",
      logger: { warn },
    }));
    expect(decision).toEqual({
      allowed: false,
      message: 'Access denied: agent "family" / sender +14255550100 may not read calendar "nicole"',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("Access denied");
  });

  it("describes senderless callers", () => {
    expect(checkAccess(acl, "calendars", "personal", "write", { agentId: "family" })).toEqual({
      allowed: false,
      message: 'Access denied: agent "family" (no sender) may not write calendar "personal"',
    });
    expect(describeCaller(undefined)).toBe("unknown agent (no sender)");
  });

  it("allows without logging", () => {
    const warn = vi.fn();
    expect(checkAccess(acl, "calendars", "family", "read", { logger: { warn } })).toEqual({ allowed: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("survives a throwing logger", () => {
    const decision = checkAccess(acl, "calendars", "work", "read", { logger: { warn: () => { throw new Error("x"); } } });
    expect(decision.allowed).toBe(false);
  });

  it("accepts a custom noun", () => {
    const d = checkAccess({ feeds: {} }, "feeds", "x", "read", {}, "feed");
    expect(d).toMatchObject({ message: expect.stringContaining('read feed "x"') });
  });
});

describe("helpers", () => {
  it("isAccessControlled reports whether a kind is governed", () => {
    expect(isAccessControlled(undefined, "calendars")).toBe(false);
    expect(isAccessControlled({}, "calendars")).toBe(false);
    expect(isAccessControlled(acl, "calendars")).toBe(true);
  });

  it("buildToolCallContext drops absent fields and freezes", () => {
    const c = buildToolCallContext({ agentId: " main ", requesterSenderId: "", messageChannel: "Discord" });
    expect(c).toEqual({ agentId: "main", messageChannel: "discord" });
    expect(Object.isFrozen(c)).toBe(true);
    expect(buildToolCallContext(undefined)).toEqual({});
  });

  it("ACCESS_CONFIG_SCHEMA is a JSON schema object", () => {
    expect(ACCESS_CONFIG_SCHEMA.type).toBe("object");
    expect(JSON.parse(JSON.stringify(ACCESS_CONFIG_SCHEMA))).toEqual(ACCESS_CONFIG_SCHEMA);
  });
});

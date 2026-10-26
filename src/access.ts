/**
 * Per-resource access control for plugin tools, keyed on the calling agent and
 * the verified message sender.
 *
 * OpenClaw hands plugin tool factories a trusted runtime context (agent id,
 * message channel, sender id, owner bit). `definePlugin` turns that into a
 * small frozen {@link ToolCallContext} and passes it to every tool's
 * `execute(params, config, ctx)`. Plugins then gate each resource (a calendar,
 * a mailbox, ...) with {@link checkAccess} against an `access` block in their
 * own config:
 *
 * ```json
 * "access": {
 *   "calendars": {
 *     "family":   { "read": ["*"], "write": ["*"] },
 *     "personal": { "read": [{ "agent": "main" }, { "sender": "jeff" }], "write": [{ "agent": "main" }] }
 *   }
 * }
 * ```
 *
 * Semantics:
 *   - No `access` block (or no `access.<kind>` entry) → everything is allowed,
 *     so existing configs keep working.
 *   - `access.<kind>` present → default-deny: an unlisted resource id, or a
 *     missing op list, denies that operation.
 *   - A grant list allows when ANY grant matches. A grant is `"*"` or an object
 *     whose fields must ALL match:
 *       - `agent`: agent id(s) compared with `ctx.agentId` (`"*"` = any).
 *       - `sender`: name(s) of OpenClaw root-config `accessGroups`
 *         (`type: "message.senders"`); matches when the sender id is a member
 *         for the turn's message channel (or the group's `"*"` channel key).
 *         The special name `"owner"` matches when `ctx.senderIsOwner === true`.
 *   - A turn with no sender id (cron, CLI, heartbeat) only matches grants that
 *     have no `sender` field.
 *   - Unknown grant fields, empty grant objects and unknown group names never
 *     match (fail closed).
 *
 * @module carapace-plugin-sdk/access
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A static sender group from the OpenClaw root config (`accessGroups.<name>`). */
export interface AccessGroup {
  type?: string;
  /** Sender ids keyed by message channel id, plus `"*"` for every channel. */
  members?: Record<string, readonly string[] | undefined>;
}

/** Minimal logger shape (OpenClaw's `api.logger`). */
export interface ToolLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * Trusted per-call context passed as the third argument to `execute`.
 *
 * Every field comes from the OpenClaw runtime, never from tool arguments. All
 * fields are optional: the standalone CLI and older hosts pass none of them.
 */
export interface ToolCallContext {
  /** Agent running the tool (e.g. "main", "family"). */
  readonly agentId?: string;
  readonly sessionKey?: string;
  /** Workspace directory of the agent running the tool. */
  readonly workspaceDir?: string;
  /** Message channel of the inbound turn (e.g. "imessage", "discord"). */
  readonly messageChannel?: string;
  /** Verified sender id of the inbound turn. Absent for cron/CLI turns. */
  readonly requesterSenderId?: string;
  /** Trusted owner bit for the inbound sender. */
  readonly senderIsOwner?: boolean;
  /** `accessGroups` from the live OpenClaw root config. */
  readonly accessGroups?: Readonly<Record<string, AccessGroup>>;
  /** Plugin logger, when the host provides one. */
  readonly logger?: ToolLogger;
}

/** `"*"` (anyone) or a set of conditions that must all hold. */
export type AccessGrant =
  | "*"
  | {
      /** Agent id(s); `"*"` matches any agent. */
      agent?: string | string[];
      /** Access group name(s), or `"owner"`. */
      sender?: string | string[];
    };

/** Operation → grants for one resource. */
export type ResourceAccess = Partial<Record<AccessOp, AccessGrant[]>>;

/** The `access` block of a plugin config: resource kind → resource id → ops. */
export type AccessConfig = Record<string, Record<string, ResourceAccess> | undefined>;

export type AccessOp = "read" | "write";

/** Result of {@link checkAccess}. */
export type AccessDecision = { allowed: true } | { allowed: false; message: string };

/**
 * JSON Schema for the `access` config property. TypeBox users:
 *
 * ```ts
 * access: Type.Optional(Type.Unsafe<AccessConfig>(ACCESS_CONFIG_SCHEMA)),
 * ```
 */
export const ACCESS_CONFIG_SCHEMA = (() => {
  const stringOrList = {
    anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  };
  const grant = {
    anyOf: [
      { type: "string", const: "*" },
      {
        type: "object",
        properties: { agent: stringOrList, sender: stringOrList },
        additionalProperties: false,
      },
    ],
  };
  const grants = { type: "array", items: grant };
  const resource = {
    type: "object",
    properties: { read: grants, write: grants },
    additionalProperties: false,
  };
  return {
    type: "object",
    description:
      "Per-resource access control keyed on agent and verified sender. " +
      'Shape: { "<kind>": { "<id>": { "read": [grant], "write": [grant] } } }; ' +
      'grant = "*" | { agent?, sender? } where sender names root-config accessGroups (or "owner"). ' +
      "Omit to allow everything; once a kind is listed, unlisted ids are denied.",
    additionalProperties: { type: "object", additionalProperties: resource },
  } as const;
})();

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Channels whose sender ids are phone numbers (bare digits are treated as phones). */
const PHONE_CHANNELS = new Set(["imessage", "sms", "whatsapp", "signal", "bluebubbles"]);

/**
 * Normalise a sender id for comparison.
 *
 * - trims and lowercases (emails compare case-insensitively)
 * - strips channel/scheme prefixes such as `imessage:`, `discord:`, `user:`, `tel:`, `mailto:`
 * - strips Discord mention wrapping (`<@123>`)
 * - formatted phone numbers (`+1 (425) 555-0100`) become `+14255550100`; on phone
 *   channels bare 10/11-digit numbers are also converted to `+1…`/`+…`. Bare digit
 *   ids elsewhere (Discord, Telegram) are left as-is.
 */
export function normalizeSenderId(raw: string, channel?: string): string {
  let s = String(raw).trim().toLowerCase();
  const mention = /^<@!?([^>]+)>$/.exec(s);
  if (mention) s = mention[1];
  // Strip one or more "scheme:" prefixes, but not URLs ("https://").
  while (/^[a-z][a-z0-9_.-]*:(?!\/\/)/.test(s)) s = s.replace(/^[a-z][a-z0-9_.-]*:/, "").trim();

  if (/^\+?[\d\s().-]+$/.test(s)) {
    const digits = s.replace(/\D/g, "");
    const formatted = /[+\s().-]/.test(s);
    const phoneChannel = channel !== undefined && PHONE_CHANNELS.has(channel.trim().toLowerCase());
    if (digits.length >= 7 && (formatted || phoneChannel)) {
      if (s.startsWith("+")) return `+${digits}`;
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
      return `+${digits}`;
    }
    return digits || s;
  }
  return s;
}

function asList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value : [value]).map((v) => String(v).trim()).filter(Boolean);
}

/** True when the turn's sender is a member of the named access group. */
export function isSenderInGroup(groupName: string, ctx: ToolCallContext | undefined): boolean {
  if (!ctx?.requesterSenderId) return false;
  if (groupName === "owner") return ctx.senderIsOwner === true;
  const group = ctx.accessGroups?.[groupName];
  if (!group || (group.type !== undefined && group.type !== "message.senders")) return false;
  const channel = ctx.messageChannel?.trim().toLowerCase();
  const members = group.members ?? {};
  const candidates = [...(channel ? members[channel] ?? [] : []), ...(members["*"] ?? [])];
  if (candidates.length === 0) return false;
  const sender = normalizeSenderId(ctx.requesterSenderId, channel);
  return candidates.some((m) => typeof m === "string" && normalizeSenderId(m, channel) === sender);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** True when a single grant matches the call context. */
export function matchesGrant(grant: AccessGrant, ctx: ToolCallContext | undefined): boolean {
  if (grant === "*") return true;
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) return false;
  const keys = Object.keys(grant);
  // Fail closed on empty grants and unknown fields (e.g. a typo like "agents").
  if (keys.length === 0 || keys.some((k) => k !== "agent" && k !== "sender")) return false;

  const agents = asList(grant.agent);
  if (agents !== undefined) {
    const ok = agents.some((a) => a === "*" || (ctx?.agentId !== undefined && a === ctx.agentId));
    if (!ok) return false;
  }
  const senders = asList(grant.sender);
  if (senders !== undefined) {
    // A senderless turn (cron, CLI) never satisfies a sender condition.
    if (!ctx?.requesterSenderId) return false;
    if (!senders.some((name) => isSenderInGroup(name, ctx))) return false;
  }
  return agents !== undefined || senders !== undefined;
}

/** True when ANY grant in the list matches. An empty or missing list denies. */
export function matchesAnyGrant(
  grants: readonly AccessGrant[] | undefined,
  ctx: ToolCallContext | undefined,
): boolean {
  return Array.isArray(grants) && grants.some((g) => matchesGrant(g, ctx));
}

/**
 * Decide whether `ctx` may perform `op` on resource `kind`/`id`.
 *
 * Returns true when `access` (or `access[kind]`) is absent — ACLs are opt-in.
 */
export function canAccess(
  access: AccessConfig | undefined | null,
  kind: string,
  id: string,
  op: AccessOp,
  ctx: ToolCallContext | undefined,
): boolean {
  if (!access || typeof access !== "object") return true;
  const resources = access[kind];
  if (!resources || typeof resources !== "object") return true;
  if (!Object.prototype.hasOwnProperty.call(resources, id)) return false;
  return matchesAnyGrant(resources[id]?.[op], ctx);
}

/** True when the plugin has an ACL for this resource kind (i.e. default-deny is on). */
export function isAccessControlled(access: AccessConfig | undefined | null, kind: string): boolean {
  return !!access && typeof access === "object" && !!access[kind] && typeof access[kind] === "object";
}

/** Human-readable caller description, e.g. `agent "family" / sender +14255550100`. */
export function describeCaller(ctx: ToolCallContext | undefined): string {
  const agent = ctx?.agentId ? `agent "${ctx.agentId}"` : "unknown agent";
  if (!ctx?.requesterSenderId) return `${agent} (no sender)`;
  return `${agent} / sender ${normalizeSenderId(ctx.requesterSenderId, ctx.messageChannel)}`;
}

/**
 * Check access and build a denial message. Logs one line via `ctx.logger` on denial.
 *
 * `noun` is the singular resource name used in the message (default: `kind`
 * without a trailing "s", e.g. "calendars" → "calendar").
 *
 * @example
 * const decision = checkAccess(config.access, "calendars", "nicole", "read", ctx);
 * if (!decision.allowed) return { error: decision.message };
 */
export function checkAccess(
  access: AccessConfig | undefined | null,
  kind: string,
  id: string,
  op: AccessOp,
  ctx: ToolCallContext | undefined,
  noun: string = kind.replace(/s$/, ""),
): AccessDecision {
  if (canAccess(access, kind, id, op, ctx)) return { allowed: true };
  const message = `Access denied: ${describeCaller(ctx)} may not ${op} ${noun} "${id}"`;
  try {
    (ctx?.logger?.warn ?? ctx?.logger?.info)?.(`[access] ${message}`);
  } catch {
    // Logging must never turn a denial into a crash.
  }
  return { allowed: false, message };
}

// ---------------------------------------------------------------------------
// Context construction (used by definePlugin)
// ---------------------------------------------------------------------------

/** The subset of OpenClaw's plugin tool context the SDK reads. */
export interface HostToolContext {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageChannel?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  config?: unknown;
  runtimeConfig?: unknown;
  getRuntimeConfig?: () => unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Build the frozen {@link ToolCallContext} from OpenClaw's tool context.
 * Reads `accessGroups` from the latest runtime config snapshot.
 */
export function buildToolCallContext(
  host: HostToolContext | undefined | null,
  logger?: ToolLogger,
): ToolCallContext {
  const h = (host && typeof host === "object" ? host : {}) as HostToolContext;
  let rootConfig: unknown;
  try {
    rootConfig = h.getRuntimeConfig?.();
  } catch {
    rootConfig = undefined;
  }
  rootConfig = rootConfig ?? h.runtimeConfig ?? h.config;
  const groups = (rootConfig as { accessGroups?: unknown } | undefined)?.accessGroups;

  const ctx: ToolCallContext = {
    agentId: str(h.agentId),
    sessionKey: str(h.sessionKey),
    workspaceDir: str(h.workspaceDir),
    messageChannel: str(h.messageChannel)?.toLowerCase(),
    requesterSenderId: str(h.requesterSenderId),
    senderIsOwner: typeof h.senderIsOwner === "boolean" ? h.senderIsOwner : undefined,
    accessGroups:
      groups && typeof groups === "object" ? (groups as Record<string, AccessGroup>) : undefined,
    logger,
  };
  for (const key of Object.keys(ctx) as (keyof ToolCallContext)[]) {
    if (ctx[key] === undefined) delete (ctx as Record<string, unknown>)[key];
  }
  return Object.freeze(ctx);
}

/** Context for calls with no runtime context (standalone CLI, tests). */
export const EMPTY_TOOL_CALL_CONTEXT: ToolCallContext = Object.freeze({});

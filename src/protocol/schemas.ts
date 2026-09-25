/**
 * Pi Swarm 1.0 protocol schemas (Zod).
 *
 * These schemas are the single source of truth for every on-disk format:
 * YAML manifests, Markdown front matter, claim records, presence records,
 * JSONL events and cursor state.
 *
 * This module must stay host-free: no oh-my-pi / extension imports here.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Crockford base32, 26 chars. */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const TASK_ID_RE = /^TASK-\d{4,}$/;
export const CLAIM_ID_RE = /^CLM-[0-9A-HJKMNP-TV-Z]{26}$/;
export const ROLE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const TOPIC_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** Dotted lowercase, at least two segments (e.g. `task.claimed`). */
export const EVENT_TYPE_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
/** `<role>-<26 char lowercase ulid>`, e.g. `backend-01j...`. */
export const INSTANCE_ID_RE = /^[a-z][a-z0-9-]+-[0-9a-z]{26}$/;
/** ISO-8601 UTC with mandatory Z suffix. */
export const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export const Ulid = z.string().regex(ULID_RE, "must be a 26-char ULID");
export const IsoTime = z.string().regex(ISO_TIME_RE, "must be ISO-8601 UTC ending in Z");
export const RoleId = z.string().regex(ROLE_ID_RE, "must be lowercase kebab-case role id");
export const TopicId = z.string().regex(TOPIC_RE, "must be lowercase kebab-case topic id");
export const TaskId = z.string().regex(TASK_ID_RE, "must match TASK-0000");
export const EventTypeId = z.string().regex(EVENT_TYPE_RE, "must be dotted lowercase, e.g. task.claimed");
/** Kebab-case work-domain id (same shape as role ids), e.g. `backend`. */
export const DOMAIN_RE = ROLE_ID_RE;
export const DomainId = z.string().regex(DOMAIN_RE, "must be lowercase kebab-case domain id");

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export const DirectRouteSchema = z.object({
  mode: z.literal("direct"),
  role: RoleId,
});
export const BroadcastRouteSchema = z.object({
  mode: z.literal("broadcast"),
  topic: TopicId,
});
export const RouteSchema = z.discriminatedUnion("mode", [
  DirectRouteSchema,
  BroadcastRouteSchema,
]);

export type DirectRoute = z.infer<typeof DirectRouteSchema>;
export type BroadcastRoute = z.infer<typeof BroadcastRouteSchema>;
export type Route = z.infer<typeof RouteSchema>;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const AgentIdentitySchema = z.object({
  role: RoleId,
  instanceId: z.string().regex(INSTANCE_ID_RE, "must be <role>-<ulid26 lowercase>"),
  sessionId: z.string().min(1).optional(),
  pid: z.number().int().positive(),
});
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Hard cap on one serialized event line (bytes). Events carry signals, not payloads. */
export const MAX_EVENT_BYTES = 128 * 1024;

export const EventContextSchema = z.object({
  taskId: TaskId.optional(),
  correlationId: z.string().min(1).optional(),
  causationId: z.string().min(1).optional(),
});
export type EventContext = z.infer<typeof EventContextSchema>;

export const SwarmEventSchema = z.object({
  version: z.literal(1),
  id: Ulid,
  time: IsoTime,
  type: EventTypeId,
  from: z.object({
    role: RoleId,
    instanceId: z.string().regex(INSTANCE_ID_RE),
  }),
  route: RouteSchema,
  context: EventContextSchema.optional(),
  data: z.unknown().optional(),
});
export type SwarmEvent = z.infer<typeof SwarmEventSchema>;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  "open",
  "claimed",
  "in_progress",
  "blocked",
  "done",
  "failed",
  "abandoned",
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Valid lifecycle transitions (architecture §8 + structural liveness fix §7).
 * `blocked` retains its claim/owner; the blocker itself is durable work in
 * `blockedOn`. Recovery may repair blocked -> open when the claim is lost.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ["claimed"],
  claimed: ["in_progress", "abandoned"],
  in_progress: ["blocked", "done", "failed", "abandoned"],
  blocked: ["in_progress", "abandoned"],
  done: [],
  failed: [],
  abandoned: ["open"],
};

export const TaskMetadataSchema = z.object({
  id: TaskId,
  status: TaskStatusSchema,
  kind: z.string().min(1).default("general"),
  priority: z.number().int().min(0).max(100).default(50),
  /** Tasks the claim is restricted to. Omitted/empty means any role may claim. */
  eligibleRoles: z.array(RoleId).optional(),
  /** Capabilities a claimant must have. Combined per manifest capability mode. */
  requiredCapabilities: z.array(z.string().min(1)).optional(),
  /**
   * Primary organizational ownership domain used by topology resolution
   * (structural liveness fix §6.2). Tasks with a workDomain resolve through
   * the Boundary Gate; tasks without it keep the legacy resolver path.
   */
  workDomain: DomainId.optional(),
  /** Soft ranking hints inside an eligible tier; never make a task impossible. */
  preferredCapabilities: z.array(z.string().min(1)).optional(),
  /** True feasibility constraints that fallback cannot bypass. */
  hardRequirements: z
    .object({ capabilities: z.array(z.string().min(1)).default([]) })
    .optional(),
  /** Policy constraints such as self-review exclusion. */
  constraints: z
    .object({
      excludeTaskAuthor: z.boolean().optional(),
      excludeCurrentClaimant: z.boolean().optional(),
    })
    .optional(),
  /** Whether the task may leave primary/secondary boundaries when no specialist exists. */
  fallback: z.object({ allowed: z.boolean() }).optional(),
  /** One-shot durable scheduling gate: the task is not actionable before this timestamp. */
  availableAt: IsoTime.optional(),
  createdBy: z.object({
    role: RoleId,
    instanceId: z.string().regex(INSTANCE_ID_RE),
  }),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  parentTask: TaskId.optional(),
  dependsOn: z.array(TaskId).default([]),
  /** Durable obligations whose completion this task waits on while blocked. */
  blockedOn: z.array(TaskId).default([]),
  /** Origin/idempotency metadata for compound coordination operations. */
  origin: z
    .object({
      type: z.string().min(1),
      sourceTaskId: TaskId.optional(),
      requestKey: z.string().min(1).optional(),
    })
    .optional(),
  /** Blackboard/artifact references a claimant should read first. */
  inputs: z.array(z.string().min(1)).default([]),
  /** Blackboard/artifact references produced by the claimant. */
  outputs: z.array(z.string().min(1)).default([]),
});
export type TaskMetadata = z.infer<typeof TaskMetadataSchema>;

export const TaskDocumentSchema = z.object({
  metadata: TaskMetadataSchema,
  body: z.string(),
});
export type TaskDocument = z.infer<typeof TaskDocumentSchema>;

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export const ClaimRecordSchema = z.object({
  version: z.literal(1),
  taskId: TaskId,
  claimId: z.string().regex(CLAIM_ID_RE, "must be CLM-<ulid26>"),
  agent: z.object({
    role: RoleId,
    instanceId: z.string().regex(INSTANCE_ID_RE),
  }),
  sessionId: z.string().min(1).optional(),
  pid: z.number().int().positive(),
  claimedAt: IsoTime,
});
export type ClaimRecord = z.infer<typeof ClaimRecordSchema>;

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export const PRESENCE_STATES = ["idle", "busy", "suspect", "stopped"] as const;
export const PresenceStateSchema = z.enum(PRESENCE_STATES);
export type PresenceState = (typeof PRESENCE_STATES)[number];

export const PresenceRecordSchema = z.object({
  version: z.literal(1),
  role: RoleId,
  instanceId: z.string().regex(INSTANCE_ID_RE),
  sessionId: z.string().min(1).optional(),
  pid: z.number().int().positive(),
  state: PresenceStateSchema,
  heartbeatAt: IsoTime,
  startedAt: IsoTime,
});
export type PresenceRecord = z.infer<typeof PresenceRecordSchema>;

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

export const StreamCursorSchema = z.object({
  offset: z.number().int().min(0),
  lastEventId: z.string().nullable(),
});
export type StreamCursor = z.infer<typeof StreamCursorSchema>;

export const CursorStateSchema = z.object({
  streams: z.record(StreamCursorSchema),
});
export type CursorState = z.infer<typeof CursorStateSchema>;

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export const ArtifactRefSchema = z.object({
  /** Workspace-relative path under `.pi/swarm/artifacts/`. */
  path: z.string().min(1),
  mediaType: z.string().min(3).optional(),
  size: z.number().int().min(0).optional(),
  /** `sha256:<hex>` content digest. */
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

// ---------------------------------------------------------------------------
// Agent manifest
// ---------------------------------------------------------------------------

export const AgentManifestSchema = z.object({
  version: z.literal(1),
  agent: z.object({
    role: RoleId,
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  capabilities: z.array(z.string().min(1)).default([]),
  /**
   * Work-domain ownership declaration (structural liveness fix §4).
   * Backward compatibility: no `domains` block -> primary=[role],
   * secondary=[], fallback=true.
   */
  domains: z
    .object({
      primary: z.array(DomainId).optional(),
      secondary: z.array(DomainId).optional(),
    })
    .optional(),
  /** Whether this agent may serve unoccupied domains through fallback. Default: true. */
  fallback: z.object({ enabled: z.boolean().optional() }).optional(),
  taskPolicy: z
    .object({
      claim: z
        .object({
          /** Task eligibleRoles this agent may match. Default: [own role]. */
          roles: z.array(RoleId).optional(),
          /** How requiredCapabilities must be satisfied. Default: "all". */
          capabilities: z.object({ mode: z.enum(["all", "any"]) }).optional(),
        })
        .optional(),
    })
    .optional(),
  subscriptions: z
    .object({
      direct: z.boolean().optional(),
      broadcast: z.object({ topics: z.array(TopicId) }).optional(),
    })
    .optional(),
  blackboard: z
    .object({
      read: z.array(z.string().min(1)).optional(),
      write: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  wakeup: z
    .object({
      /** Wake this agent when an eligible open task appears. Default: true. */
      taskAvailable: z.boolean().optional(),
      /** Event types that should be treated as actionable (wake-worthy). */
      events: z.array(EventTypeId).optional(),
    })
    .optional(),
});
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

/** Manifest with all defaults resolved. This is what the runtime consumes. */
export interface NormalizedAgentManifest {
  role: string;
  name: string;
  description?: string;
  capabilities: string[];
  /** Task eligibleRoles this agent may match (task must contain at least one). */
  claimRoles: string[];
  capabilityMode: "all" | "any";
  /** Domains this agent owns as an active primary specialist (fix §4.1: default [role]). */
  primaryDomains: string[];
  /** Domains this agent may serve when no primary specialist is active. */
  secondaryDomains: string[];
  /** Whether this agent may take fallback work in unoccupied domains. */
  fallbackEnabled: boolean;
  subscriptions: { direct: boolean; topics: string[] };
  blackboard: { read: string[]; write: string[] };
  wakeup: { taskAvailable: boolean; events: string[] };
}

export function normalizeAgentManifest(m: AgentManifest): NormalizedAgentManifest {
  return {
    role: m.agent.role,
    name: m.agent.name,
    description: m.agent.description,
    capabilities: m.capabilities,
    claimRoles: m.taskPolicy?.claim?.roles ?? [m.agent.role],
    capabilityMode: m.taskPolicy?.claim?.capabilities?.mode ?? "all",
    primaryDomains: m.domains?.primary ?? [m.agent.role],
    secondaryDomains: m.domains?.secondary ?? [],
    fallbackEnabled: m.fallback?.enabled ?? true,
    subscriptions: {
      direct: m.subscriptions?.direct ?? true,
      topics: m.subscriptions?.broadcast?.topics ?? [],
    },
    blackboard: {
      read: m.blackboard?.read ?? [],
      write: m.blackboard?.write ?? [],
    },
    wakeup: {
      taskAvailable: m.wakeup?.taskAvailable ?? true,
      events: m.wakeup?.events ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// Workspace configuration (swarm.yaml)
// ---------------------------------------------------------------------------

export const SwarmConfigSchema = z.object({
  version: z.literal(1),
  project: z
    .object({
      name: z.string().min(1).default("project"),
    })
    .default({ name: "project" }),
  runtime: z
    .object({
      eventPollIntervalMs: z.number().int().min(50).default(500),
      taskScanIntervalMs: z.number().int().min(50).default(1000),
      wakeBatchWindowMs: z.number().int().min(0).default(250),
      heartbeatIntervalMs: z.number().int().min(500).default(5000),
      presenceStaleMs: z.number().int().min(1000).default(15000),
    })
    .default({}),
  scheduling: z
    .object({
      /** Global fallback gate; a task or manifest may still opt out. Default: true. */
      fallbackEnabled: z.boolean().default(true),
    })
    .default({}),
  liveness: z
    .object({
      /** Watchdog warns when serviceable work makes no progress this long. */
      warningAfterMs: z.number().int().min(1000).default(60_000),
      /** Watchdog re-wake interval for eligible idle agents. */
      rewakeAfterMs: z.number().int().min(1000).default(30_000),
    })
    .default({}),
  blackboard: z
    .object({
      /** Shared hotspot file (exact relative path) -> roles allowed to write it. */
      hotspots: z.record(z.array(RoleId)).default({
        "project.md": ["coordinator"],
        "architecture.md": ["architect"],
      }),
    })
    .default({}),
});
export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

export const DEFAULT_SWARM_CONFIG: SwarmConfig = SwarmConfigSchema.parse({ version: 1 });

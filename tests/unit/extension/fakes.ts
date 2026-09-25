/**
 * Shared fakes for extension unit tests: a recording host (FakePi), a host
 * context (FakeCtx), and a full fake SwarmStack satisfying the compose
 * contract structurally (real store implementations live in other
 * workstreams and are integration-tested by the parent).
 */
import { vi } from "vitest";
import type {
  AgentIdentity,
  AgentManifest,
  ClaimRecord,
  NormalizedAgentManifest,
  PresenceRecord,
  SwarmConfig,
  SwarmEvent,
  TaskDocument,
  TaskStatus,
} from "../../../src/protocol/schemas.js";
import { DEFAULT_SWARM_CONFIG } from "../../../src/protocol/schemas.js";
import { buildEvent } from "../../../src/protocol/events.js";
import { SwarmPaths } from "../../../src/util/paths.js";
import { createEventService } from "../../../src/domain/event-service.js";
import type { RuntimeStatus } from "../../../src/runtime/ports.js";
import type {
  CommandHandler,
  ExtensionHook,
  PiCtxLike,
  PiLike,
  SendMessageOptions,
  SendMessagePayload,
  SessionEntryLike,
  ToolDefinition,
} from "../../../src/extension/pi-api.js";
import type { RuntimeHandle } from "../../../src/extension/binding.js";
import type { SwarmStack } from "../../../src/extension/compose.js";

// ---------------------------------------------------------------------------
// Host fakes
// ---------------------------------------------------------------------------

export class FakePi {
  label: string | null = null;
  sessionNames: string[] = [];
  readonly commands = new Map<string, { description: string; handler: CommandHandler }>();
  readonly tools = new Map<string, ToolDefinition>();
  readonly hooks = new Map<string, ExtensionHook>();
  readonly sentMessages: { payload: SendMessagePayload; opts?: SendMessageOptions }[] = [];
  readonly entries: unknown[] = [];

  setLabel(label: string): void {
    this.label = label;
  }

  setSessionName(name: string): void {
    this.sessionNames.push(name);
  }

  registerCommand(name: string, def: { description: string; handler: CommandHandler }): void {
    this.commands.set(name, def);
  }

  registerTool(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  on(event: string, handler: ExtensionHook): void {
    this.hooks.set(event, handler);
  }

  sendMessage(payload: SendMessagePayload, opts?: SendMessageOptions): void {
    this.sentMessages.push({ payload, opts });
  }

  appendEntry(entryOrType: SessionEntryLike | string, _data?: unknown): void {
    this.entries.push(entryOrType);
  }
}

export class FakeCtx implements PiCtxLike {
  readonly notifications: { message: string; level?: string }[] = [];
  readonly branch: SessionEntryLike[] = [];
  readonly timers: { fn: () => void; ms: number }[] = [];
  readonly ui = {
    notify: (message: string, level?: string) => {
      this.notifications.push({ message, level });
    },
  };

  constructor(
    public cwd: string,
    private idle = true,
  ) {}

  isIdle(): boolean {
    return this.idle;
  }

  readonly sessionManager = {
    getBranch: (): ArrayLike<SessionEntryLike> => this.branch,
  };

  setInterval(fn: () => void, ms: number): unknown {
    this.timers.push({ fn, ms });
    return this.timers.length - 1;
  }

  clearTimeout(handle: unknown): void {
    void handle;
  }
}

// ---------------------------------------------------------------------------
// Identity / manifest helpers
// ---------------------------------------------------------------------------

export function makeIdentity(role: string): AgentIdentity {
  return { role, instanceId: `${role}-01aaaaaaaaaaaaaaaaaaaaaaaa`, pid: 4242 };
}

export function makeManifest(role: string): NormalizedAgentManifest {
  return {
    role,
    name: role.charAt(0).toUpperCase() + role.slice(1),
    capabilities: [role, "testing"],
    claimRoles: [role],
    capabilityMode: "all",
    primaryDomains: [role],
    secondaryDomains: [],
    fallbackEnabled: true,
    subscriptions: { direct: true, topics: ["tasks", "architecture", "decisions"] },
    blackboard: {
      read: ["project.md", "findings/**"],
      write: [`findings/${role}/**`],
    },
    wakeup: { taskAvailable: true, events: [] },
  };
}

export function makeAgentManifestDoc(role: string): AgentManifest {
  return {
    version: 1,
    agent: { role, name: role },
    capabilities: [role],
    taskPolicy: { claim: { roles: [role], capabilities: { mode: "all" } } },
    subscriptions: { direct: true, broadcast: { topics: ["tasks"] } },
    blackboard: { read: ["findings/**"], write: [`findings/${role}/**`] },
  };
}

export function makePresence(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    version: 1,
    role: "backend",
    instanceId: "backend-01bbbbbbbbbbbbbbbbbbbbbbbb",
    pid: 99999,
    state: "idle",
    heartbeatAt: "2026-09-11T11:59:55Z",
    startedAt: "2026-09-11T11:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake runtime
// ---------------------------------------------------------------------------

export interface FakeRuntime extends RuntimeHandle {
  started: number;
  stopped: number;
  busyCount: number;
  idleCount: number;
  pendingWake: number;
}

export function makeFakeRuntime(instanceId = "backend-01aaaaaaaaaaaaaaaaaaaaaaaa"): FakeRuntime {
  return {
    started: 0,
    stopped: 0,
    busyCount: 0,
    idleCount: 0,
    pendingWake: 0,
    start: vi.fn(async function (this: FakeRuntime) {
      this.started += 1;
    }),
    stop: vi.fn(async function (this: FakeRuntime) {
      this.stopped += 1;
    }),
    markBusy: vi.fn(function (this: FakeRuntime) {
      this.busyCount += 1;
    }),
    markIdle: vi.fn(function (this: FakeRuntime) {
      this.idleCount += 1;
    }),
    status: vi.fn(function (this: FakeRuntime): RuntimeStatus {
      return {
        role: "backend",
        instanceId,
        running: this.started > this.stopped,
        lastTaskScanAt: null,
        lastEventPollAt: null,
        pendingWake: this.pendingWake,
        consumedEvents: 0,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake stack
// ---------------------------------------------------------------------------

export interface FakeStackOptions {
  paths?: SwarmPaths;
  config?: SwarmConfig;
  manifests?: AgentManifest[];
  presence?: PresenceRecord[];
  tasks?: TaskDocument[];
  claims?: ClaimRecord[];
}

export function makeFakeStack(options: FakeStackOptions = {}): SwarmStack {
  const paths = options.paths ?? new SwarmPaths("/tmp/pi-swarm-fake-workspace");
  const config = options.config ?? DEFAULT_SWARM_CONFIG;
  const manifests = options.manifests ?? [];
  const presence = options.presence ?? [];
  const tasks = options.tasks ?? [];
  const claims = options.claims ?? [];
  const appendedEvents: SwarmEvent[] = [];
  const eventStore = {
    append: vi.fn(async (event: SwarmEvent) => {
      appendedEvents.push(event);
    }),
    readFrom: vi.fn(async () => ({
      events: [],
      offset: 0,
      trailingIncomplete: false,
      malformed: [],
    })),
    listStreams: vi.fn(async () => [] as string[]),
    streamSize: vi.fn(async () => 0),
  };
  return {
    paths,
    config,
    stores: {
      config: { load: vi.fn(async () => config), save: vi.fn(), exists: vi.fn(async () => true) },
      manifest: {
        list: vi.fn(async () => manifests),
        get: vi.fn(async (role: string) => manifests.find((m) => m.agent.role === role) ?? null),
        save: vi.fn(),
        validate: vi.fn(async () => []),
      },
      task: {
        list: vi.fn(async () => tasks),
        get: vi.fn(async (taskId: string) => tasks.find((t) => t.metadata.id === taskId) ?? null),
        save: vi.fn(),
        nextTaskId: vi.fn(async () => "TASK-0001"),
        issues: vi.fn(async () => []),
      },
      claim: {
        tryClaim: vi.fn(async () => ({ status: "claimed" as const })),
        get: vi.fn(async () => null),
        remove: vi.fn(async () => true),
        list: vi.fn(async () => claims),
      },
      event: eventStore,
      cursor: {
        load: vi.fn(async () => ({ streams: {} })),
        save: vi.fn(),
      },
      presence: {
        upsert: vi.fn(async (record: PresenceRecord) => {
          const index = presence.findIndex((p) => p.instanceId === record.instanceId);
          if (index >= 0) presence[index] = record;
          else presence.push(record);
        }),
        get: vi.fn(async () => null),
        list: vi.fn(async () => presence),
        issues: vi.fn(async () => []),
        markStopped: vi.fn(),
      },
      blackboard: {
        read: vi.fn(async (relPath: string) => `content of ${relPath}`),
        write: vi.fn(),
        list: vi.fn(async () => [] as string[]),
      },
      artifact: {
        publish: vi.fn(async (taskId: string, fileName: string, content: string) => ({
          path: `artifacts/${taskId}/${fileName}`,
          size: content.length,
          digest: `sha256:${"a".repeat(64)}`,
        })),
        resolvePath: vi.fn(async () => "/tmp/resolved"),
      },
    },
    services: {
      policy: {
        checkClaim: vi.fn(() => ({ eligible: true })),
      },
      events: createEventService({ eventStore }),
      task: {
        create: vi.fn(async () => ({ ok: false as const, code: "invalid_input" as const, message: "not stubbed" })),
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        claim: vi.fn(async () => ({ status: "invalid_task" as const, message: "not stubbed" })),
        start: vi.fn(async () => ({ ok: false as const, code: "invalid_input" as const, message: "not stubbed" })),
        complete: vi.fn(async () => ({ ok: false as const, code: "invalid_input" as const, message: "not stubbed" })),
        fail: vi.fn(async () => ({ ok: false as const, code: "invalid_input" as const, message: "not stubbed" })),
        abandon: vi.fn(async () => ({ ok: false as const, code: "invalid_input" as const, message: "not stubbed" })),
        block: vi.fn(async () => ({ ok: false as const, code: "invalid_input" as const, message: "not stubbed" })),
        unblock: vi.fn(async () => ({ ok: false as const, code: "invalid_input" as const, message: "not stubbed" })),
        reopen: vi.fn(async () => ({ ok: false as const, code: "invalid_input" as const, message: "not stubbed" })),
      },
      recovery: {
        scan: vi.fn(async () => ({ orphans: [], suspects: [], inconsistencies: [], staleInstances: [] })),
        reconcile: vi.fn(async () => []),
        recoverOrphans: vi.fn(async () => []),
        recoverTask: vi.fn(async () => ({ ok: false, message: "not stubbed" })),
      },
      obligations: {
        createObligation: vi.fn(async () => ({ ok: false as const, code: "invalid_input" as const, message: "not stubbed" })),
        createRework: vi.fn(async () => ({ ok: false as const, code: "invalid_input" as const, message: "not stubbed" })),
      },
    },
  };
}

/** Convenience: a valid SwarmEvent for assertions/spies. */
export function fakeEvent(type: string): SwarmEvent {
  return buildEvent({
    type,
    from: { role: "backend", instanceId: "backend-01aaaaaaaaaaaaaaaaaaaaaaaa" },
    route: { mode: "broadcast", topic: "tasks" },
    data: { probe: true },
  });
}

export const STATUSES: TaskStatus[] = [
  "open",
  "claimed",
  "in_progress",
  "done",
  "failed",
  "abandoned",
];

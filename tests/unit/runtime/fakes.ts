import { setTimeout as sleep } from "node:timers/promises";
/**
 * In-memory test fakes for the runtime suite (unit + integration).
 *
 * MemoryEventStore reproduces the real JSONL byte-offset semantics exactly
 * (complete lines only, trailingIncomplete, malformed-line skipping) so unit
 * tests exercise the same cursor discipline as the fs-backed fixtures.
 */
import type {
  AgentIdentity,
  ClaimRecord,
  CursorState,
  NormalizedAgentManifest,
  PresenceRecord,
  SwarmEvent,
  TaskDocument,
  TaskStatus,
} from "../../../src/protocol/schemas.js";
import {
  CursorStateSchema,
  SwarmEventSchema,
} from "../../../src/protocol/schemas.js";
import { buildEvent, serializeEvent } from "../../../src/protocol/events.js";
import type { BuildEventInput } from "../../../src/protocol/events.js";
import type {
  CursorStore,
  EventReadResult,
  EventStore,
  MalformedLine,
  PresenceStore,
  PresenceFileIssue,
  TaskStore,
} from "../../../src/storage/types.js";
import type {
  CreateTaskInput,
  CreateTaskResult,
  ClaimOutcome,
  IneligibleReason,
  LifecycleResult,
  TaskListQuery,
  TaskService,
  TaskView,
} from "../../../src/domain/types.js";
import type {
  SwarmInboxMessage,
  TimerPort,
  WakeDelivery,
  WakePort,
} from "../../../src/runtime/ports.js";
import type { Logger } from "../../../src/util/logger.js";
import { ulid } from "../../../src/util/ulid.js";

// ---------------------------------------------------------------------------
// Clock / logger helpers
// ---------------------------------------------------------------------------

/** Deterministic ticking clock: each call advances one second from the base. */
export function tickClock(startMs = Date.UTC(2026, 0, 1, 0, 0, 0)): () => string {
  let t = startMs;
  return () => new Date((t += 1000)).toISOString();
}

/** Capturing logger; keeps test stderr clean. */
export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger: Logger = {
    debug: (msg, fields) => lines.push(JSON.stringify({ level: "debug", msg, ...fields })),
    info: (msg, fields) => lines.push(JSON.stringify({ level: "info", msg, ...fields })),
    warn: (msg, fields) => lines.push(JSON.stringify({ level: "warn", msg, ...fields })),
    error: (msg, fields) => lines.push(JSON.stringify({ level: "error", msg, ...fields })),
  };
  return { logger, lines };
}

// ---------------------------------------------------------------------------
// Identity / manifest / event factories
// ---------------------------------------------------------------------------

export function makeIdentity(role = "backend"): AgentIdentity {
  return {
    role,
    instanceId: `${role}-${ulid().toLowerCase()}`,
    pid: 42100,
    sessionId: "sess-1",
  };
}

export interface ManifestOverrides {
  role?: string;
  capabilities?: string[];
  claimRoles?: string[];
  capabilityMode?: "all" | "any";
  primaryDomains?: string[];
  secondaryDomains?: string[];
  fallbackEnabled?: boolean;
  subscriptions?: { direct: boolean; topics: string[] };
  wakeup?: { taskAvailable: boolean; events: string[] };
}

export function makeManifest(overrides: ManifestOverrides = {}): NormalizedAgentManifest {
  return {
    role: overrides.role ?? "backend",
    name: "Backend",
    capabilities: overrides.capabilities ?? ["backend", "api"],
    claimRoles: overrides.claimRoles ?? ["backend"],
    capabilityMode: overrides.capabilityMode ?? "all",
    primaryDomains: overrides.primaryDomains ?? ["backend"],
    secondaryDomains: overrides.secondaryDomains ?? [],
    fallbackEnabled: overrides.fallbackEnabled ?? true,
    subscriptions: overrides.subscriptions ?? { direct: true, topics: ["tasks", "review"] },
    blackboard: { read: [], write: [] },
    wakeup: overrides.wakeup ?? { taskAvailable: true, events: ["review.completed"] },
  };
}

export type MakeEventFields = Pick<BuildEventInput, "from"> &
  Partial<Pick<BuildEventInput, "type" | "route" | "context" | "data" | "id" | "time">>;

export function makeEvent(fields: MakeEventFields): SwarmEvent {
  return buildEvent({
    type: fields.type ?? "task.claimed",
    from: fields.from,
    route: fields.route ?? { mode: "broadcast", topic: "tasks" },
    ...(fields.context !== undefined ? { context: fields.context } : {}),
    ...(fields.data !== undefined ? { data: fields.data } : {}),
    ...(fields.id !== undefined ? { id: fields.id } : {}),
    ...(fields.time !== undefined ? { time: fields.time } : {}),
  });
}

// ---------------------------------------------------------------------------
// EventStore / CursorStore (byte-offset JSONL semantics, in memory)
// ---------------------------------------------------------------------------

/**
 * Parse a JSONL chunk starting at `offset`. The returned offset is the byte
 * after the last COMPLETE line (valid or malformed); an unterminated final
 * line is reported as trailingIncomplete and left for a later poll.
 */
export function parseJsonlChunk(buf: Buffer, offset: number): EventReadResult {
  if (offset >= buf.length) {
    return { events: [], offset, trailingIncomplete: false, malformed: [] };
  }
  const text = buf.subarray(offset).toString("utf8");
  const complete = text.split("\n").slice(0, -1);
  const trailingIncomplete = !text.endsWith("\n");
  const events: SwarmEvent[] = [];
  const malformed: MalformedLine[] = [];
  let next = offset;
  let lineNo = buf.subarray(0, offset).toString("utf8").split("\n").length;
  for (const line of complete) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      malformed.push({ line: lineNo, error: "empty line" });
    } else {
      try {
        const parsed = SwarmEventSchema.safeParse(JSON.parse(trimmed) as unknown);
        if (parsed.success) {
          events.push(parsed.data);
        } else {
          malformed.push({ line: lineNo, error: parsed.error.issues[0]?.message ?? "schema violation" });
        }
      } catch {
        malformed.push({ line: lineNo, error: "invalid JSON" });
      }
    }
    next += Buffer.byteLength(line, "utf8") + 1;
    lineNo += 1;
  }
  return { events, offset: next, trailingIncomplete, malformed };
}

export class MemoryEventStore implements EventStore {
  readonly streams = new Map<string, string>();

  constructor(readonly ownInstanceId: string) {}

  async append(event: SwarmEvent): Promise<void> {
    if (event.from.instanceId !== this.ownInstanceId) {
      throw new Error(`append rejected: ${event.from.instanceId} is not the owning writer`);
    }
    const parsed = SwarmEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error(`append rejected: invalid event (${parsed.error.issues[0]?.message ?? "?"})`);
    }
    await this.appendRaw(this.ownInstanceId, `${serializeEvent(parsed.data)}\n`);
  }

  /** Test seam: write arbitrary bytes into any producer's stream. */
  async appendRaw(producer: string, text: string): Promise<void> {
    this.streams.set(producer, (this.streams.get(producer) ?? "") + text);
  }

  async readFrom(producer: string, offset: number): Promise<EventReadResult> {
    return parseJsonlChunk(Buffer.from(this.streams.get(producer) ?? "", "utf8"), offset);
  }

  async listStreams(): Promise<string[]> {
    return [...this.streams.keys()].sort();
  }

  async streamSize(producer: string): Promise<number> {
    return Buffer.byteLength(this.streams.get(producer) ?? "", "utf8");
  }
}

export class MemoryCursorStore implements CursorStore {
  readonly states = new Map<string, CursorState>();

  async load(consumerInstanceId: string): Promise<CursorState> {
    const state = this.states.get(consumerInstanceId);
    return state === undefined ? { streams: {} } : CursorStateSchema.parse(state);
  }

  async save(consumerInstanceId: string, state: CursorState): Promise<void> {
    this.states.set(consumerInstanceId, CursorStateSchema.parse(state));
  }
}

// ---------------------------------------------------------------------------
// PresenceStore
// ---------------------------------------------------------------------------

export class MemoryPresenceStore implements PresenceStore {
  readonly records = new Map<string, PresenceRecord>();

  async upsert(record: PresenceRecord): Promise<void> {
    this.records.set(record.instanceId, { ...record });
  }

  async get(instanceId: string): Promise<PresenceRecord | null> {
    return this.records.get(instanceId) ?? null;
  }

  async list(): Promise<PresenceRecord[]> {
    return [...this.records.values()];
  }

  async issues(): Promise<PresenceFileIssue[]> {
    return [];
  }

  async markStopped(instanceId: string, stoppedAt: string): Promise<void> {
    const record = this.records.get(instanceId);
    if (record) {
      this.records.set(instanceId, { ...record, state: "stopped", heartbeatAt: stoppedAt });
    }
  }
}

// ---------------------------------------------------------------------------
// TaskStore / TaskService
// ---------------------------------------------------------------------------

export class MemoryTaskStore implements TaskStore {
  readonly docs = new Map<string, TaskDocument>();

  async list(): Promise<TaskDocument[]> {
    return [...this.docs.values()];
  }

  async get(taskId: string): Promise<TaskDocument | null> {
    return this.docs.get(taskId) ?? null;
  }

  async save(task: TaskDocument): Promise<void> {
    this.docs.set(task.metadata.id, { ...task, metadata: { ...task.metadata } });
  }

  async nextTaskId(): Promise<string> {
    let max = 0;
    for (const id of this.docs.keys()) {
      const n = Number(id.slice("TASK-".length));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `TASK-${String(max + 1).padStart(4, "0")}`;
  }

  async issues(): Promise<{ file: string; error: string }[]> {
    return [];
  }
}

interface FakeTaskEntry {
  doc: TaskDocument;
  claim: ClaimRecord | null;
}

/**
 * Minimal in-memory TaskService: real-enough open/claim/transition semantics
 * plus test seams (claimByOther/touch/reopenByOther) for poller scenarios.
 */
export class FakeTaskService implements TaskService {
  private entries = new Map<string, FakeTaskEntry>();
  private seq = 0;

  constructor(
    private readonly now: () => string,
    private readonly taskStore?: TaskStore,
  ) {}

  // -- test seams ----------------------------------------------------------

  async addTask(input: {
    title: string;
    body?: string;
    priority?: number;
    eligibleRoles?: string[];
    requiredCapabilities?: string[];
    dependsOn?: string[];
    status?: TaskStatus;
  }): Promise<TaskDocument> {
    this.seq += 1;
    const id = `TASK-${String(this.seq).padStart(4, "0")}`;
    const at = this.now();
    const doc: TaskDocument = {
      metadata: {
        id,
        status: input.status ?? "open",
        kind: "general",
        priority: input.priority ?? 50,
        ...(input.eligibleRoles ? { eligibleRoles: input.eligibleRoles } : {}),
        ...(input.requiredCapabilities ? { requiredCapabilities: input.requiredCapabilities } : {}),
        createdBy: { role: "coordinator", instanceId: `coordinator-${ulid().toLowerCase()}` },
        createdAt: at,
        updatedAt: at,
        dependsOn: input.dependsOn ?? [],
        blockedOn: [],
        inputs: [],
        outputs: [],
      },
      body: `# ${input.title}\n\n${input.body ?? "Do the work."}\n`,
    };
    this.entries.set(id, { doc, claim: null });
    if (this.taskStore) await this.taskStore.save(doc);
    return doc;
  }

  /** Simulate a competing instance winning the claim. */
  async claimByOther(taskId: string, role = "frontend"): Promise<void> {
    const entry = this.entries.get(taskId);
    if (!entry) throw new Error(`claimByOther: unknown task ${taskId}`);
    const at = this.now();
    entry.claim = {
      version: 1,
      taskId,
      claimId: `CLM-${ulid()}`,
      agent: { role, instanceId: `${role}-${ulid().toLowerCase()}` },
      pid: 53000,
      claimedAt: at,
    };
    entry.doc = {
      ...entry.doc,
      metadata: { ...entry.doc.metadata, status: "claimed", updatedAt: at },
    };
    if (this.taskStore) await this.taskStore.save(entry.doc);
  }

  /** Bump updatedAt (content change) on an open task. */
  async touch(taskId: string): Promise<void> {
    const entry = this.entries.get(taskId);
    if (!entry) throw new Error(`touch: unknown task ${taskId}`);
    entry.doc = {
      ...entry.doc,
      metadata: { ...entry.doc.metadata, updatedAt: this.now() },
    };
    if (this.taskStore) await this.taskStore.save(entry.doc);
  }

  /** Back to open with the claim cleared (recovery-style reopen). */
  async reopenByOther(taskId: string): Promise<void> {
    const entry = this.entries.get(taskId);
    if (!entry) throw new Error(`reopenByOther: unknown task ${taskId}`);
    entry.claim = null;
    entry.doc = {
      ...entry.doc,
      metadata: { ...entry.doc.metadata, status: "open", updatedAt: this.now() },
    };
    if (this.taskStore) await this.taskStore.save(entry.doc);
  }


  /** Force a status (dependency-satisfaction scenarios) and bump updatedAt. */
  async setStatus(taskId: string, status: TaskStatus): Promise<void> {
    const entry = this.entries.get(taskId);
    if (!entry) throw new Error(`setStatus: unknown task ${taskId}`);
    entry.doc = {
      ...entry.doc,
      metadata: { ...entry.doc.metadata, status, updatedAt: this.now() },
    };
    if (this.taskStore) await this.taskStore.save(entry.doc);
  }
  // -- TaskService ---------------------------------------------------------

  async create(input: CreateTaskInput, by: AgentIdentity): Promise<CreateTaskResult> {
    void by;
    const doc = await this.addTask(input);
    return { ok: true, task: doc };
  }

  async list(query: TaskListQuery): Promise<TaskView[]> {
    const statuses = query.statuses ?? ["open", "claimed", "in_progress"];
    const views: TaskView[] = [];
    for (const { doc, claim } of this.entries.values()) {
      if (!statuses.includes(doc.metadata.status)) continue;
      const check = this.eligibility(doc, claim, query);
      if (query.forAgent && !check.eligible && !query.includeIneligible) continue;
      views.push({
        metadata: { ...doc.metadata },
        claim: claim ? { ...claim } : null,
        eligible: check.eligible,
        ...(check.reason !== undefined ? { ineligibleReason: check.reason } : {}),
      });
    }
    return views;
  }

  async get(taskId: string): Promise<TaskView | null> {
    const entry = this.entries.get(taskId);
    if (!entry) return null;
    const check = this.eligibility(entry.doc, entry.claim, {});
    return {
      metadata: { ...entry.doc.metadata },
      claim: entry.claim ? { ...entry.claim } : null,
      eligible: check.eligible,
      ...(check.reason !== undefined ? { ineligibleReason: check.reason } : {}),
    };
  }

  async claim(
    taskId: string,
    by: { identity: AgentIdentity; manifest: NormalizedAgentManifest },
  ): Promise<ClaimOutcome> {
    const entry = this.entries.get(taskId);
    if (!entry) return { status: "invalid_task", message: "no such task" };
    if (entry.doc.metadata.status !== "open") {
      return { status: "not_open", message: `status is ${entry.doc.metadata.status}` };
    }
    if (entry.claim) return { status: "already_claimed", message: "claim exists" };
    const check = this.eligibility(entry.doc, entry.claim, { forAgent: by });
    if (!check.eligible) {
      return { status: "not_eligible", message: check.reason ?? "not eligible" };
    }
    const at = this.now();
    const claim: ClaimRecord = {
      version: 1,
      taskId,
      claimId: `CLM-${ulid()}`,
      agent: { role: by.identity.role, instanceId: by.identity.instanceId },
      ...(by.identity.sessionId !== undefined ? { sessionId: by.identity.sessionId } : {}),
      pid: by.identity.pid,
      claimedAt: at,
    };
    entry.claim = claim;
    entry.doc = {
      ...entry.doc,
      metadata: { ...entry.doc.metadata, status: "claimed", updatedAt: at },
    };
    if (this.taskStore) await this.taskStore.save(entry.doc);
    return { status: "claimed", claim, task: entry.doc };
  }

  async start(taskId: string, claimId: string): Promise<LifecycleResult> {
    return this.transition(taskId, claimId, "in_progress");
  }
  async complete(taskId: string, claimId: string): Promise<LifecycleResult> {
    return this.transition(taskId, claimId, "done");
  }

  async fail(taskId: string, claimId: string): Promise<LifecycleResult> {
    return this.transition(taskId, claimId, "failed");
  }

  async block(
    taskId: string,
    claimId: string,
    _by: unknown,
    result: { reason: string; blockedOn?: string[] },
  ): Promise<LifecycleResult> {
    const outcome = this.transition(taskId, claimId, "blocked");
    if (!outcome.ok) return outcome;
    const entry = this.entries.get(taskId)!;
    entry.doc = {
      ...entry.doc,
      metadata: {
        ...entry.doc.metadata,
        blockedOn: [...new Set([...entry.doc.metadata.blockedOn, ...(result.blockedOn ?? [])])],
      },
    };
    if (this.taskStore) await this.taskStore.save(entry.doc);
    return { ok: true, task: entry.doc };
  }

  async unblock(taskId: string, claimId: string): Promise<LifecycleResult> {
    return this.transition(taskId, claimId, "in_progress");
  }

  async abandon(taskId: string, claimId: string): Promise<LifecycleResult> {
    return this.transition(taskId, claimId, "abandoned");
  }

  async reopen(taskId: string): Promise<LifecycleResult> {
    const entry = this.entries.get(taskId);
    if (!entry) return { ok: false, code: "not_found", message: "no such task" };
    if (entry.doc.metadata.status !== "abandoned") {
      return { ok: false, code: "invalid_transition", message: "not abandoned" };
    }
    await this.reopenByOther(taskId);
    return { ok: true, task: this.entries.get(taskId)!.doc };
  }

  // -- internals -----------------------------------------------------------

  private eligibility(
    doc: TaskDocument,
    claim: ClaimRecord | null,
    query: TaskListQuery,
  ): { eligible: boolean; reason?: IneligibleReason } {
    if (doc.metadata.status !== "open") return { eligible: false, reason: "status" };
    if (claim !== null) return { eligible: false, reason: "claimed" };
    if (query.forAgent) {
      const roles = doc.metadata.eligibleRoles;
      if (roles && roles.length > 0 && !roles.some((r) => query.forAgent!.manifest.claimRoles.includes(r))) {
        return { eligible: false, reason: "role" };
      }
      const required = doc.metadata.requiredCapabilities ?? [];
      const caps = query.forAgent.manifest.capabilities;
      const satisfied =
        query.forAgent.manifest.capabilityMode === "any"
          ? required.some((c) => caps.includes(c))
          : required.every((c) => caps.includes(c));
      if (!satisfied) return { eligible: false, reason: "capabilities" };
    }
    if (query.requireDependencies !== false) {
      const unmet = doc.metadata.dependsOn.filter(
        (dep) => this.entries.get(dep)?.doc.metadata.status !== "done",
      );
      if (unmet.length > 0) return { eligible: false, reason: "dependencies" };
    }
    return { eligible: true };
  }

  private transition(taskId: string, claimId: string, to: TaskStatus): LifecycleResult {
    const entry = this.entries.get(taskId);
    if (!entry) return { ok: false, code: "not_found", message: "no such task" };
    if (!entry.claim || entry.claim.claimId !== claimId) {
      return { ok: false, code: "not_claim_owner", message: "claimId mismatch" };
    }
    const allowed: Record<TaskStatus, TaskStatus[]> = {
      open: [],
      claimed: ["in_progress", "abandoned"],
      in_progress: ["blocked", "done", "failed", "abandoned"],
      blocked: ["in_progress", "abandoned"],
      done: [],
      failed: [],
      abandoned: ["open"],
    };
    if (!allowed[entry.doc.metadata.status].includes(to)) {
      return {
        ok: false,
        code: "invalid_transition",
        message: `${entry.doc.metadata.status} -> ${to} not allowed`,
      };
    }
    entry.doc = {
      ...entry.doc,
      metadata: { ...entry.doc.metadata, status: to, updatedAt: this.now() },
    };
    return { ok: true, task: entry.doc };
  }
}

// ---------------------------------------------------------------------------
// Wake / timer ports
// ---------------------------------------------------------------------------

export interface RecordedDelivery {
  message: SwarmInboxMessage;
  delivery: WakeDelivery;
}

export class FakeWakePort implements WakePort {
  idle = true;
  readonly deliveries: RecordedDelivery[] = [];

  isIdle(): boolean {
    return this.idle;
  }

  async deliver(message: SwarmInboxMessage, delivery: WakeDelivery): Promise<void> {
    this.deliveries.push({ message, delivery });
  }
}

export interface FakeTimerEntry {
  id: number;
  ms: number;
  cleared: boolean;
  fire(): void;
}

export class FakeTimerPort implements TimerPort {
  readonly entries: FakeTimerEntry[] = [];
  private nextId = 1;

  setInterval(fn: () => void, ms: number): unknown {
    const entry: FakeTimerEntry = {
      id: this.nextId++,
      ms,
      cleared: false,
      fire: () => {
        if (!entry.cleared) fn();
      },
    };
    this.entries.push(entry);
    return entry;
  }

  clearInterval(handle: unknown): void {
    const entry = this.entries.find((e) => e === handle);
    if (entry) entry.cleared = true;
  }

  /** Fire every live interval once, then let async callbacks settle. */
  async fireAll(): Promise<void> {
    for (const entry of [...this.entries]) entry.fire();
    // Real fs callbacks land on later event-loop turns; give them time.
    await sleep(25);
  }
}

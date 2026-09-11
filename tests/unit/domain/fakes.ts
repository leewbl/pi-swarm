/**
 * Minimal in-memory / fs-backed store fakes for domain service tests.
 *
 * The real storage layer (Workstream A) is not imported: these fakes implement
 * the frozen interfaces in src/storage/types.ts directly. The only fs-backed
 * fake is FsClaimStore, which reproduces the exclusive-create claim primitive
 * (O_EXCL via tryCreateExclusive) so contention behavior is real.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { buildEvent } from "../../../src/protocol/events.js";
import {
  ClaimRecordSchema,
  TaskDocumentSchema,
} from "../../../src/protocol/schemas.js";
import type {
  AgentIdentity,
  ClaimRecord,
  NormalizedAgentManifest,
  PresenceRecord,
  PresenceState,
  SwarmEvent,
  TaskDocument,
  TaskStatus,
} from "../../../src/protocol/schemas.js";
import { TaskExistsError } from "../../../src/storage/types.js";
import type { ClaimStore, PresenceStore, TaskStore } from "../../../src/storage/types.js";
import type { EmitEventInput, EventService } from "../../../src/domain/types.js";
import { tryCreateExclusive, readFileIfExists } from "../../../src/util/atomic-file.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUFFIX = "01abcdefghjkmnpqrstvwxyz01"; // 26 chars [0-9a-z], matches INSTANCE_ID_RE

export function makeIdentity(role: string, seq = 0, sessionId?: string): AgentIdentity {
  const suffix = seq === 0 ? SUFFIX : `${seq}${SUFFIX.slice(String(seq).length)}`;
  return {
    role,
    instanceId: `${role}-${suffix}`,
    ...(sessionId !== undefined ? { sessionId } : {}),
    pid: 4242 + seq,
  };
}

export function makeManifest(opts: {
  role: string;
  capabilities?: string[];
  claimRoles?: string[];
  capabilityMode?: "all" | "any";
}): NormalizedAgentManifest {
  return {
    role: opts.role,
    name: opts.role,
    capabilities: opts.capabilities ?? [],
    claimRoles: opts.claimRoles ?? [opts.role],
    capabilityMode: opts.capabilityMode ?? "all",
    subscriptions: { direct: true, topics: [] },
    blackboard: { read: [], write: [] },
    wakeup: { taskAvailable: true, events: [] },
  };
}

export function makePresence(opts: {
  identity: AgentIdentity;
  heartbeatAt: string;
  state?: PresenceState;
}): PresenceRecord {
  return {
    version: 1,
    role: opts.identity.role,
    instanceId: opts.identity.instanceId,
    ...(opts.identity.sessionId !== undefined ? { sessionId: opts.identity.sessionId } : {}),
    pid: opts.identity.pid,
    state: opts.state ?? "idle",
    heartbeatAt: opts.heartbeatAt,
    startedAt: "2026-09-11T09:00:00Z",
  };
}

export interface FixedClock {
  now: () => string;
  advanceMs: (ms: number) => void;
  current: () => string;
}

/** Deterministic injectable clock: fixed start, advanced only on demand. */
export function fixedClock(startIso = "2026-09-11T10:00:00Z"): FixedClock {
  let ms = Date.parse(startIso);
  const iso = (): string => new Date(ms).toISOString().replace(".000Z", "Z");
  return {
    now: iso,
    advanceMs: (delta: number) => {
      ms += delta;
    },
    current: iso,
  };
}

export class FakeEventService implements EventService {
  readonly emitted: SwarmEvent[] = [];

  constructor(private readonly now: () => string = () => "2026-09-11T10:00:00Z") {}

  async emit(input: EmitEventInput, from: AgentIdentity): Promise<SwarmEvent> {
    const event = buildEvent(
      {
        type: input.type,
        from: { role: from.role, instanceId: from.instanceId },
        route: input.route,
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.data !== undefined ? { data: input.data } : {}),
      },
      { now: this.now },
    );
    this.emitted.push(event);
    return event;
  }

  of(type: string): SwarmEvent[] {
    return this.emitted.filter((e) => e.type === type);
  }
}

// ---------------------------------------------------------------------------
// Store fakes
// ---------------------------------------------------------------------------

export class MemoryTaskStore implements TaskStore {
  readonly docs = new Map<string, TaskDocument>();
  /** When set, the next exclusive create for this id "loses" to a concurrent creator. */
  collideOnce: string | null = null;

  async list(): Promise<TaskDocument[]> {
    return [...this.docs.values()];
  }

  async get(taskId: string): Promise<TaskDocument | null> {
    return this.docs.get(taskId) ?? null;
  }

  async save(task: TaskDocument, mode?: { create?: boolean }): Promise<void> {
    const doc = TaskDocumentSchema.parse(task);
    if (mode?.create) {
      if (this.collideOnce === doc.metadata.id) {
        this.collideOnce = null;
        // Simulate a concurrent creator whose file is now on disk.
        this.docs.set(doc.metadata.id, { ...doc, body: "# stolen\n\nstolen" });
        throw new TaskExistsError(doc.metadata.id);
      }
      if (this.docs.has(doc.metadata.id)) throw new TaskExistsError(doc.metadata.id);
    }
    this.docs.set(doc.metadata.id, doc);
  }

  async nextTaskId(): Promise<string> {
    let max = 0;
    for (const id of this.docs.keys()) max = Math.max(max, Number(id.slice("TASK-".length)));
    return `TASK-${String(max + 1).padStart(4, "0")}`;
  }

  async issues(): Promise<{ file: string; error: string }[]> {
    return [];
  }

  /** Test convenience: force a task into a status without lifecycle guards. */
  async forceStatus(taskId: string, status: TaskStatus, at: string): Promise<void> {
    const doc = this.docs.get(taskId);
    if (doc === undefined) throw new Error(`no task ${taskId}`);
    this.docs.set(taskId, {
      ...doc,
      metadata: { ...doc.metadata, status, updatedAt: at },
    });
  }
}

export class MemoryClaimStore implements ClaimStore {
  readonly claims = new Map<string, ClaimRecord>();

  async tryClaim(claim: ClaimRecord): Promise<{ status: "claimed" } | { status: "already_claimed" }> {
    if (this.claims.has(claim.taskId)) return { status: "already_claimed" };
    this.claims.set(claim.taskId, ClaimRecordSchema.parse(claim));
    return { status: "claimed" };
  }

  async get(taskId: string): Promise<ClaimRecord | null> {
    return this.claims.get(taskId) ?? null;
  }

  async remove(taskId: string, claimId: string): Promise<boolean> {
    const current = this.claims.get(taskId);
    if (current === undefined || current.claimId !== claimId) return false;
    return this.claims.delete(taskId);
  }

  async list(): Promise<ClaimRecord[]> {
    return [...this.claims.values()];
  }
}

export class MemoryPresenceStore implements PresenceStore {
  readonly records = new Map<string, PresenceRecord>();

  async upsert(record: PresenceRecord): Promise<void> {
    this.records.set(record.instanceId, record);
  }

  async get(instanceId: string): Promise<PresenceRecord | null> {
    return this.records.get(instanceId) ?? null;
  }

  async list(): Promise<PresenceRecord[]> {
    return [...this.records.values()];
  }

  async issues(): Promise<{ file: string; error: string }[]> {
    return [];
  }

  async markStopped(instanceId: string, stoppedAt: string): Promise<void> {
    const record = this.records.get(instanceId);
    if (record === undefined) return;
    this.records.set(instanceId, { ...record, state: "stopped", heartbeatAt: stoppedAt });
  }
}

/**
 * Real-filesystem claim store: exclusive create via O_EXCL, YAML files under
 * `<dir>/claims/<taskId>.yaml`. Mirrors the storage layer's ownership
 * primitive so claim contention in tests exercises true exclusivity.
 */
export class FsClaimStore implements ClaimStore {
  private readonly dir: string;

  constructor(workspaceRoot: string) {
    this.dir = path.join(workspaceRoot, "claims");
  }

  async tryClaim(claim: ClaimRecord): Promise<{ status: "claimed" } | { status: "already_claimed" }> {
    const doc = ClaimRecordSchema.parse(claim);
    await fsp.mkdir(this.dir, { recursive: true });
    const created = await tryCreateExclusive(
      path.join(this.dir, `${doc.taskId}.yaml`),
      stringifyYaml(doc),
    );
    return created ? { status: "claimed" } : { status: "already_claimed" };
  }

  async get(taskId: string): Promise<ClaimRecord | null> {
    const raw = await readFileIfExists(path.join(this.dir, `${taskId}.yaml`));
    if (raw === null) return null;
    return ClaimRecordSchema.parse(parseYaml(raw));
  }

  async remove(taskId: string, claimId: string): Promise<boolean> {
    const current = await this.get(taskId);
    if (current === null || current.claimId !== claimId) return false;
    await fsp.rm(path.join(this.dir, `${taskId}.yaml`));
    return true;
  }

  async list(): Promise<ClaimRecord[]> {
    const entries = await fsp.readdir(this.dir).catch(() => [] as string[]);
    const out: ClaimRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".yaml")) continue;
      const raw = await readFileIfExists(path.join(this.dir, entry));
      if (raw !== null) out.push(ClaimRecordSchema.parse(parseYaml(raw)));
    }
    return out;
  }
}

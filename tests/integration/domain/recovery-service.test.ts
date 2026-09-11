import { promises as fsp } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryService } from "../../../src/domain/recovery-service.js";
import { createTaskService } from "../../../src/domain/task-service.js";
import { createPolicyService } from "../../../src/domain/policy-service.js";
import { DEFAULT_SWARM_CONFIG } from "../../../src/protocol/schemas.js";
import type { AgentIdentity, TaskStatus } from "../../../src/protocol/schemas.js";
import type { RecoveryService, TaskService } from "../../../src/domain/types.js";
import { tmpWorkspaceDir } from "../../../src/util/atomic-file.js";
import {
  FakeEventService,
  FsClaimStore,
  MemoryPresenceStore,
  MemoryTaskStore,
  fixedClock,
  makeIdentity,
  makeManifest,
  makePresence,
} from "../../unit/domain/fakes.js";
import type { FixedClock } from "../../unit/domain/fakes.js";

// DEFAULT_SWARM_CONFIG.runtime.presenceStaleMs = 15000. Clock is fixed at
// 10:00:00Z, so heartbeats before 09:59:45Z are stale.
const NOW = "2026-09-11T10:00:00Z";
const STALE = "2026-09-11T09:00:00Z";
const FRESH = "2026-09-11T09:59:55Z";

let workspace: string;

beforeEach(async () => {
  workspace = await tmpWorkspaceDir("pi-swarm-recovery");
});

afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
});

interface Harness {
  clock: FixedClock;
  taskStore: MemoryTaskStore;
  claimStore: FsClaimStore;
  presenceStore: MemoryPresenceStore;
  events: FakeEventService;
  tasks: TaskService;
  recovery: RecoveryService;
  coordinator: AgentIdentity;
  backend: AgentIdentity;
}

function setup(alive: (pid: number) => boolean = () => false): Harness {
  const clock = fixedClock();
  const taskStore = new MemoryTaskStore();
  const claimStore = new FsClaimStore(workspace);
  const presenceStore = new MemoryPresenceStore();
  const events = new FakeEventService(clock.now);
  const tasks = createTaskService({
    taskStore,
    claimStore,
    policy: createPolicyService(),
    eventService: events,
    now: clock.now,
  });
  const recovery = createRecoveryService({
    taskStore,
    claimStore,
    presenceStore,
    eventService: events,
    config: DEFAULT_SWARM_CONFIG,
    now: clock.now,
    isProcessAlive: alive,
  });
  return {
    clock,
    taskStore,
    claimStore,
    presenceStore,
    events,
    tasks,
    recovery,
    coordinator: makeIdentity("coordinator"),
    backend: makeIdentity("backend"),
  };
}

/** A task driven to `claimed` by `backend`, plus that claimant's presence. */
async function claimedTask(
  h: Harness,
  opts: { heartbeatAt: string; state?: "idle" | "busy" | "suspect" | "stopped" },
): Promise<string> {
  const created = await h.tasks.create({ title: "T", body: "B" }, h.coordinator);
  if (!created.ok) throw new Error("create failed");
  const taskId = created.task.metadata.id;
  const outcome = await h.tasks.claim(taskId, {
    identity: h.backend,
    manifest: makeManifest({ role: "backend" }),
  });
  if (outcome.status !== "claimed") throw new Error("claim failed");
  await h.presenceStore.upsert(
    makePresence({ identity: h.backend, heartbeatAt: opts.heartbeatAt, state: opts.state }),
  );
  return taskId;
}

describe("recovery scan", () => {
  it("classifies a stale+dead claim as an orphan", async () => {
    const h = setup(() => false);
    await claimedTask(h, { heartbeatAt: STALE });
    const report = await h.recovery.scan();
    expect(report.orphans).toHaveLength(1);
    expect(report.suspects).toHaveLength(0);
    expect(report.orphans[0].taskId).toBe("TASK-0001");
    expect(report.orphans[0].presenceStale).toBe(true);
    expect(report.orphans[0].claimantAlive).toBe(false);
    expect(report.orphans[0].presence?.instanceId).toBe(h.backend.instanceId);
  });

  it("classifies a stale+alive claim as a suspect, not an orphan", async () => {
    const h = setup(() => true);
    await claimedTask(h, { heartbeatAt: STALE });
    const report = await h.recovery.scan();
    expect(report.orphans).toHaveLength(0);
    expect(report.suspects).toHaveLength(1);
    expect(report.suspects[0].claimantAlive).toBe(true);
    expect(report.suspects[0].taskId).toBe("TASK-0001");
  });

  it("leaves fresh-heartbeat claims out of both buckets even when dead", async () => {
    const h = setup(() => false);
    await claimedTask(h, { heartbeatAt: FRESH });
    const report = await h.recovery.scan();
    expect(report.orphans).toHaveLength(0);
    expect(report.suspects).toHaveLength(0);
  });

  it("treats a missing presence record as stale", async () => {
    const h = setup(() => false);
    await h.tasks.create({ title: "T", body: "B" }, h.coordinator);
    const outcome = await h.tasks.claim("TASK-0001", {
      identity: h.backend,
      manifest: makeManifest({ role: "backend" }),
    });
    if (outcome.status !== "claimed") throw new Error("claim failed");
    // No presence record at all for the claimant.
    const report = await h.recovery.scan();
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0].presence).toBeNull();
  });

  it("surfaces claim/Markdown drift as inconsistencies", async () => {
    const h = setup(() => true);
    // Drift 1: claim exists but task still open (interrupted claim).
    await h.tasks.create({ title: "T1", body: "B" }, h.coordinator);
    await h.claimStore.tryClaim({
      version: 1,
      taskId: "TASK-0001",
      claimId: "CLM-01ABCDEFGHJKMNPQRSTVWXYZ01",
      agent: { role: "backend", instanceId: h.backend.instanceId },
      pid: h.backend.pid,
      claimedAt: NOW,
    });
    // Drift 2: Markdown claimed but claim file gone.
    await h.tasks.create({ title: "T2", body: "B" }, h.coordinator);
    await h.taskStore.forceStatus("TASK-0002", "claimed", NOW);
    // Drift 3: claim exists but the task file is missing.
    await h.claimStore.tryClaim({
      version: 1,
      taskId: "TASK-0042",
      claimId: "CLM-01ABCDEFGHJKMNPQRSTVWXYZ02",
      agent: { role: "backend", instanceId: h.backend.instanceId },
      pid: h.backend.pid,
      claimedAt: NOW,
    });

    const report = await h.recovery.scan();
    const byTask = new Map(report.inconsistencies.map((i) => [i.taskId, i]));
    expect(byTask.get("TASK-0001")?.kind).toBe("claim_without_markdown_status");
    expect(byTask.get("TASK-0002")?.kind).toBe("markdown_claimed_without_claim");
    expect(byTask.get("TASK-0042")?.kind).toBe("task_file_missing");
    // A consistent claimed task (claim + Markdown) is absent.
    await claimedTask(h, { heartbeatAt: FRESH }); // TASK-0003, consistent
    const fresh = await h.recovery.scan();
    expect(fresh.inconsistencies.some((i) => i.taskId === "TASK-0003")).toBe(false);
  });

  it("lists stale non-stopped instances in staleInstances", async () => {
    const h = setup(() => true);
    await h.presenceStore.upsert(
      makePresence({ identity: makeIdentity("backend"), heartbeatAt: STALE }),
    );
    await h.presenceStore.upsert(
      makePresence({ identity: makeIdentity("tester", 1), heartbeatAt: STALE, state: "stopped" }),
    );
    await h.presenceStore.upsert(
      makePresence({ identity: makeIdentity("researcher", 2), heartbeatAt: FRESH }),
    );
    const report = await h.recovery.scan();
    expect(report.staleInstances.map((p) => p.instanceId)).toEqual([
      makeIdentity("backend").instanceId,
    ]);
  });
});

describe("recovery reconcile", () => {
  it("repairs an interrupted claim: claim file exists, Markdown still open", async () => {
    const h = setup(() => true);
    await h.tasks.create({ title: "T", body: "B" }, h.coordinator);
    // Simulate the crash window: claim file written, Markdown update lost.
    const interrupted = await h.claimStore.tryClaim({
      version: 1,
      taskId: "TASK-0001",
      claimId: "CLM-01ABCDEFGHJKMNPQRSTVWXYZ01",
      agent: { role: "backend", instanceId: h.backend.instanceId },
      pid: h.backend.pid,
      claimedAt: NOW,
    });
    expect(interrupted.status).toBe("claimed");

    const repairs = await h.recovery.reconcile();
    expect(repairs).toEqual([{ taskId: "TASK-0001", repaired: "open->claimed" }]);
    expect((await h.taskStore.get("TASK-0001"))?.metadata.status).toBe("claimed");
    expect((await h.taskStore.get("TASK-0001"))?.metadata.updatedAt).toBe(NOW);
    // Claim untouched; idempotent second run repairs nothing.
    expect(await h.claimStore.get("TASK-0001")).not.toBeNull();
    expect(await h.recovery.reconcile()).toEqual([]);
  });

  it("repairs reverse drift: Markdown claimed, claim file missing", async () => {
    const h = setup(() => true);
    await h.tasks.create({ title: "T", body: "B" }, h.coordinator);
    await h.taskStore.forceStatus("TASK-0001", "claimed", NOW);

    const repairs = await h.recovery.reconcile();
    expect(repairs).toEqual([{ taskId: "TASK-0001", repaired: "claimed->open" }]);
    expect((await h.taskStore.get("TASK-0001"))?.metadata.status).toBe("open");
    expect(await h.recovery.reconcile()).toEqual([]);
  });

  it("never touches done, failed, or abandoned tasks", async () => {
    const h = setup(() => true);
    const frozen: readonly TaskStatus[] = ["done", "failed", "abandoned"];
    for (const [i, status] of frozen.entries()) {
      await h.tasks.create({ title: `T${i}`, body: "B" }, h.coordinator);
      await h.taskStore.forceStatus(`TASK-000${i + 1}`, status, NOW);
    }
    expect(await h.recovery.reconcile()).toEqual([]);
    const statuses = (await h.taskStore.list()).map((t) => t.metadata.status);
    expect(statuses).toEqual(["done", "failed", "abandoned"]);
  });
});

describe("recovery recoverOrphans", () => {
  it("abandons and reopens orphaned tasks of dead claimants", async () => {
    const h = setup(() => false);
    await claimedTask(h, { heartbeatAt: STALE });
    h.clock.advanceMs(5_000);

    const actions = await h.recovery.recoverOrphans(h.coordinator);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      taskId: "TASK-0001",
      action: "abandoned_reopened",
      detail: `claimant ${h.backend.instanceId} (pid ${h.backend.pid}) is dead`,
    });
    expect((await h.taskStore.get("TASK-0001"))?.metadata.status).toBe("open");
    expect((await h.taskStore.get("TASK-0001"))?.metadata.updatedAt).toBe(
      "2026-09-11T10:00:05Z",
    );
    expect(await h.claimStore.get("TASK-0001")).toBeNull();

    const abandoned = h.events.of("task.abandoned");
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].data).toEqual({ taskId: "TASK-0001", reason: "claimant_dead" });
    expect(abandoned[0].context).toEqual({ taskId: "TASK-0001" });
    expect(abandoned[0].route).toEqual({ mode: "broadcast", topic: "tasks" });
    const reopened = h.events.of("task.reopened");
    expect(reopened).toHaveLength(1);
    expect(reopened[0].data).toEqual({ taskId: "TASK-0001", reason: "recovered" });
    expect(reopened[0].context).toEqual({ taskId: "TASK-0001" });
  });

  it("leaves suspects (stale but alive) untouched", async () => {
    const h = setup(() => true);
    await claimedTask(h, { heartbeatAt: STALE });
    const actions = await h.recovery.recoverOrphans(h.coordinator);
    expect(actions).toEqual([]);
    expect((await h.taskStore.get("TASK-0001"))?.metadata.status).toBe("claimed");
    expect(await h.claimStore.get("TASK-0001")).not.toBeNull();
    expect(h.events.of("task.abandoned")).toHaveLength(0);
    expect(h.events.of("task.reopened")).toHaveLength(0);
  });
});

describe("recovery recoverTask (manual)", () => {
  it("forces abandon+reopen even when the claimant is alive", async () => {
    const h = setup(() => true);
    await claimedTask(h, { heartbeatAt: FRESH });
    const result = await h.recovery.recoverTask("TASK-0001", h.coordinator);
    expect(result.ok).toBe(true);
    expect(result.action?.action).toBe("abandoned_reopened");
    expect(result.action?.detail).toContain("alive");
    expect((await h.taskStore.get("TASK-0001"))?.metadata.status).toBe("open");
    expect(await h.claimStore.get("TASK-0001")).toBeNull();
    expect(h.events.of("task.abandoned")[0]?.data).toEqual({
      taskId: "TASK-0001",
      reason: "manual_recovery",
    });
    expect(h.events.of("task.reopened")[0]?.data).toEqual({
      taskId: "TASK-0001",
      reason: "recovered",
    });
  });

  it("refuses tasks that do not exist or have no claim", async () => {
    const h = setup(() => false);
    await h.tasks.create({ title: "T", body: "B" }, h.coordinator);
    const missing = await h.recovery.recoverTask("TASK-9999", h.coordinator);
    expect(missing.ok).toBe(false);
    const unclaimed = await h.recovery.recoverTask("TASK-0001", h.coordinator);
    expect(unclaimed.ok).toBe(false);
    expect((await h.taskStore.get("TASK-0001"))?.metadata.status).toBe("open");
    expect(h.events.emitted).toHaveLength(1); // only task.opened
  });

  it("removes a stale claim on a done task without altering its status", async () => {
    const h = setup(() => false);
    await claimedTask(h, { heartbeatAt: STALE });
    const outcome = await h.tasks.get("TASK-0001");
    if (outcome?.claim === null || outcome === null) throw new Error("no claim");
    await h.tasks.start("TASK-0001", outcome.claim.claimId, h.backend);
    await h.tasks.complete("TASK-0001", outcome.claim.claimId, h.backend, {});
    expect((await h.taskStore.get("TASK-0001"))?.metadata.status).toBe("done");

    const actions = await h.recovery.recoverOrphans(h.coordinator);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("skipped_not_orphan");
    expect((await h.taskStore.get("TASK-0001"))?.metadata.status).toBe("done");
    expect(await h.claimStore.get("TASK-0001")).toBeNull();
  });
});

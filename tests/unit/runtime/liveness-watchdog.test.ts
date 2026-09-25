/**
 * Liveness watchdog regressions (structural liveness fix §21/§36):
 * evaluateLiveness classifies due+serviceable+stalled work and unserviceable
 * work; the runtime watchdogTick re-surfaces stalled candidates for the
 * local agent while idle (never as the scheduler — claim/scan loops remain
 * the work authority).
 */
import { describe, expect, it } from "vitest";
import { evaluateLiveness } from "../../../src/domain/liveness-service.js";
import { buildActiveTopology } from "../../../src/domain/topology.js";
import { SwarmRuntime } from "../../../src/runtime/runtime.js";
import { DEFAULT_SWARM_CONFIG } from "../../../src/protocol/schemas.js";
import type { TaskDocument } from "../../../src/protocol/schemas.js";
import {
  MemoryClaimStore,
  MemoryManifestStore,
  MemoryPresenceStore,
  MemoryTaskStore,
  fixedClock,
  makeIdentity,
  makeManifest,
  makePresence,
} from "../domain/fakes.js";
import {
  FakeEventService,
} from "../domain/fakes.js";
import {
  FakeTaskService,
  FakeWakePort,
  MemoryCursorStore,
  MemoryEventStore,
} from "./fakes.js";
import { createTaskService } from "../../../src/domain/task-service.js";
import { createPolicyService } from "../../../src/domain/policy-service.js";

const T0 = "2026-09-24T17:00:00Z";
const STALLED_SINCE = "2026-09-24T16:00:00Z"; // 1h old

function openTask(id: number, opts: { workDomain?: string; updatedAt?: string } = {}): TaskDocument {
  return {
    metadata: {
      id: `TASK-${String(id).padStart(4, "0")}`,
      status: "open",
      kind: "general",
      priority: 50,
      ...(opts.workDomain !== undefined ? { workDomain: opts.workDomain } : {}),
      createdBy: { role: "tester", instanceId: makeIdentity("tester").instanceId },
      createdAt: STALLED_SINCE,
      updatedAt: opts.updatedAt ?? STALLED_SINCE,
      dependsOn: [],
      blockedOn: [],
      inputs: [],
      outputs: [],
    },
    body: "# t\n\nb",
  };
}

describe("evaluateLiveness (fix §21)", () => {
  const coordinator = makeIdentity("coordinator");
  const topology = buildActiveTopology(
    [makePresence({ identity: coordinator, heartbeatAt: T0 })],
    [{ version: 1, agent: { role: "coordinator", name: "coordinator" }, capabilities: [] }],
    { nowIso: T0, presenceStaleMs: 15_000 },
  );

  it("flags due+serviceable work that stalled past the threshold", () => {
    const report = evaluateLiveness({
      nowIso: T0,
      warningAfterMs: 60_000,
      tasks: [openTask(1, { workDomain: "decision" })],
      claims: [],
      topology,
      statusIndex: new Map(),
    });
    expect(report.stalled).toHaveLength(1);
    expect(report.stalled[0].taskId).toBe("TASK-0001");
    expect(report.stalled[0].candidates).toEqual([coordinator.instanceId]);
    expect(report.unserviceable).toHaveLength(0);
  });

  it("does not flag recently-updated work", () => {
    const report = evaluateLiveness({
      nowIso: T0,
      warningAfterMs: 60_000,
      tasks: [openTask(1, { workDomain: "decision", updatedAt: T0 })],
      claims: [],
      topology,
      statusIndex: new Map(),
    });
    expect(report.stalled).toHaveLength(0);
  });

  it("flags unserviceable work explicitly instead of idle silence", () => {
    const report = evaluateLiveness({
      nowIso: T0,
      warningAfterMs: 60_000,
      tasks: [openTask(1, { workDomain: "backend" })],
      claims: [],
      topology,
      statusIndex: new Map(),
    });
    // fallback IS open for the coordinator, so this is stalled-serviceable;
    // make it unserviceable by a hard constraint nobody has.
    expect(report.stalled.map((f) => f.taskId)).toEqual(["TASK-0001"]);
    const report2 = evaluateLiveness({
      nowIso: T0,
      warningAfterMs: 60_000,
      tasks: [
        {
          ...openTask(2, { workDomain: "backend" }),
          metadata: {
            ...openTask(2, { workDomain: "backend" }).metadata,
            hardRequirements: { capabilities: ["ios-device-access"] },
          },
        },
      ],
      claims: [],
      topology,
      statusIndex: new Map(),
    });
    expect(report2.unserviceable).toHaveLength(1);
    expect(report2.unserviceable[0].reason).toContain("ios-device-access");
  });

  it("restricts stalled findings to the local agent's candidature when asked", () => {
    const backend = makeIdentity("backend");
    const twoAgentTopology = buildActiveTopology(
      [
        makePresence({ identity: coordinator, heartbeatAt: T0 }),
        makePresence({ identity: backend, heartbeatAt: T0 }),
      ],
      [
        { version: 1, agent: { role: "coordinator", name: "c" }, capabilities: [], domains: { primary: ["decision"] } },
        { version: 1, agent: { role: "backend", name: "b" }, capabilities: [] },
      ],
      { nowIso: T0, presenceStaleMs: 15_000 },
    );
    const forBackend = evaluateLiveness({
      nowIso: T0,
      warningAfterMs: 60_000,
      tasks: [openTask(1, { workDomain: "decision" })],
      claims: [],
      topology: twoAgentTopology,
      statusIndex: new Map(),
      forInstanceIds: [backend.instanceId],
    });
    expect(forBackend.stalled).toHaveLength(0); // coordinator owns the boundary
    const forCoordinator = evaluateLiveness({
      nowIso: T0,
      warningAfterMs: 60_000,
      tasks: [openTask(1, { workDomain: "decision" })],
      claims: [],
      topology: twoAgentTopology,
      statusIndex: new Map(),
      forInstanceIds: [coordinator.instanceId],
    });
    expect(forCoordinator.stalled).toHaveLength(1);
  });

  it("respects the global fallback gate — no policy drift with the claim resolver", () => {
    // fallback globally disabled: the coordinator-only topology cannot serve
    // a backend task, so the watchdog must report UNSERVICEABLE (matching
    // what claim-time resolution would deny), not stalled-serviceable.
    const report = evaluateLiveness({
      nowIso: T0,
      warningAfterMs: 60_000,
      fallbackEnabled: false,
      tasks: [openTask(1, { workDomain: "backend" })],
      claims: [],
      topology,
      statusIndex: new Map(),
    });
    expect(report.stalled).toHaveLength(0);
    expect(report.unserviceable.map((f) => f.taskId)).toEqual(["TASK-0001"]);
  });
});

describe("runtime watchdogTick (fix §21)", () => {
  it("re-surfaces stalled serviceable work for the local agent while idle", async () => {
    const clock = fixedClock(T0);
    const identity = makeIdentity("backend");
    const taskStore = new MemoryTaskStore();
    const claimStore = new MemoryClaimStore();
    const presenceStore = new MemoryPresenceStore();
    const manifestStore = new MemoryManifestStore({
      version: 1,
      agent: { role: "backend", name: "backend" },
      capabilities: [],
      domains: { primary: ["backend"] },
    });
    const events = new FakeEventService(clock.now);
    const config = { ...DEFAULT_SWARM_CONFIG, liveness: { warningAfterMs: 60_000, rewakeAfterMs: 30_000 } };
    const service = createTaskService({
      taskStore,
      claimStore,
      policy: createPolicyService(),
      eventService: events,
      presenceStore,
      manifestStore,
      config,
      now: clock.now,
    });
    const created = await service.create(
      { title: "Stalled backend work", body: "b", workDomain: "backend" },
      makeIdentity("tester"),
    );
    if (!created.ok) throw new Error(created.message);
    // Age the task past the threshold.
    await taskStore.forceStatus(created.task.metadata.id, "open", STALLED_SINCE);
    const doc = taskStore.docs.get(created.task.metadata.id)!;
    taskStore.docs.set(doc.metadata.id, {
      ...doc,
      metadata: { ...doc.metadata, createdAt: STALLED_SINCE },
    });

    const wake = new FakeWakePort(); // idle
    const runtime = new SwarmRuntime({
      identity,
      manifest: makeManifest({ role: "backend" }) as never,
      config,
      taskService: service,
      eventStore: new MemoryEventStore(identity.instanceId),
      cursorStore: new MemoryCursorStore(),
      presenceStore,
      wake,
      taskStore,
      manifestStore,
      claimList: () => claimStore.list(),
      now: clock.now,
    });
    await runtime.start();
    await runtime.scanTasksOnce(); // first surfacing delivered + suppressed
    expect(wake.deliveries).toHaveLength(1);

    clock.advanceMs(31_000); // past liveness.rewakeAfterMs
    presenceStore.records.set(identity.instanceId, makePresence({ identity, heartbeatAt: clock.now() }));
    await runtime.watchdogTick(); // stalled -> re-surface + LIVENESS WARNING
    expect(wake.deliveries.length).toBeGreaterThanOrEqual(2);
    const warning = wake.deliveries.find((d) => d.message.body.includes("LIVENESS WARNING"));
    expect(warning).toBeDefined();
    expect(warning?.message.body).toContain(created.task.metadata.id);
    await runtime.stop();
  });
});

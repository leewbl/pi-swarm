/**
 * Issue #1 structural regression (fix §29): the exact deadlock scenario as a
 * permanent E2E fixture.
 *
 * tester hits a blocker -> creates a DURABLE decision obligation and blocks
 * its in_progress task on it -> no other open work exists -> no user message.
 * The runtime must resolve the decision task against the current topology,
 * wake an eligible agent, and after the decision completes, resume the
 * blocked work. Variants: no coordinator (backend secondary decides) and a
 * single-agent swarm (fallback decides).
 *
 * Assertions (fix §29): no manual ping, no supervisor LLM, no direct process
 * invocation, no database/broker, no dependence on a custom event type, and
 * never permanently idle while serviceable durable work exists.
 */
import { describe, expect, it } from "vitest";
import { createTaskService } from "../../../src/domain/task-service.js";
import { createPolicyService } from "../../../src/domain/policy-service.js";
import { createObligationService } from "../../../src/domain/obligation-service.js";
import { SwarmRuntime } from "../../../src/runtime/runtime.js";
import { DEFAULT_SWARM_CONFIG } from "../../../src/protocol/schemas.js";
import type { AgentManifest, SwarmConfig, TaskDocument } from "../../../src/protocol/schemas.js";
import {
  FakeEventService,
  MemoryClaimStore,
  MemoryManifestStore,
  MemoryPresenceStore,
  MemoryTaskStore,
  fixedClock,
  makeIdentity,
  makePresence,
} from "../../unit/domain/fakes.js";
import {
  FakeWakePort,
  MemoryCursorStore,
  MemoryEventStore,
} from "../../unit/runtime/fakes.js";

const T0 = "2026-09-24T17:16:34Z";

function manifestDoc(role: string, domains: { primary?: string[]; secondary?: string[] }): AgentManifest {
  return {
    version: 1,
    agent: { role, name: role },
    capabilities: [],
    domains: {
      ...(domains.primary !== undefined ? { primary: domains.primary } : {}),
      ...(domains.secondary !== undefined ? { secondary: domains.secondary } : {}),
    },
  };
}

const SIX_ROLE_MANIFESTS: AgentManifest[] = [
  manifestDoc("coordinator", { primary: ["planning", "coordination", "decision"], secondary: ["architecture", "research"] }),
  manifestDoc("architect", { primary: ["architecture", "design"] }),
  manifestDoc("researcher", { primary: ["research"] }),
  manifestDoc("frontend", { primary: ["frontend", "ui"] }),
  manifestDoc("backend", { primary: ["backend", "api"], secondary: ["decision"] }),
  manifestDoc("tester", { primary: ["testing", "verification"] }),
];

interface Harness {
  clock: ReturnType<typeof fixedClock>;
  taskStore: MemoryTaskStore;
  claimStore: MemoryClaimStore;
  presenceStore: MemoryPresenceStore;
  manifestStore: MemoryManifestStore;
  events: FakeEventService;
  service: ReturnType<typeof createTaskService>;
  obligations: ReturnType<typeof createObligationService>;
  config: SwarmConfig;
}

function setupHarness(activeRoles: string[], manifests: AgentManifest[] = SIX_ROLE_MANIFESTS): Harness {
  const clock = fixedClock(T0);
  const taskStore = new MemoryTaskStore();
  const claimStore = new MemoryClaimStore();
  const presenceStore = new MemoryPresenceStore();
  const manifestStore = new MemoryManifestStore(...manifests);
  const events = new FakeEventService(clock.now);
  for (const role of activeRoles) {
    presenceStore.records.set(`${role}-x`, makePresence({ identity: makeIdentity(role), heartbeatAt: T0 }));
  }
  const config: SwarmConfig = {
    ...DEFAULT_SWARM_CONFIG,
    runtime: { ...DEFAULT_SWARM_CONFIG.runtime, presenceStaleMs: 15_000 },
    scheduling: { fallbackEnabled: true },
  };
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
  const obligations = createObligationService({ taskService: service, taskStore });
  return { clock, taskStore, claimStore, presenceStore, manifestStore, events, service, obligations, config };
}

function agentFor(h: Harness, role: string) {
  const manifest = h.manifestStore.docs.find((m) => m.agent.role === role);
  if (manifest === undefined) throw new Error(`no manifest for ${role}`);
  return {
    identity: makeIdentity(role),
    manifest: {
      role,
      name: role,
      capabilities: manifest.capabilities,
      claimRoles: [role],
      capabilityMode: "all" as const,
      primaryDomains: manifest.domains?.primary ?? [role],
      secondaryDomains: manifest.domains?.secondary ?? [],
      fallbackEnabled: true,
      subscriptions: { direct: true, topics: ["tasks"] },
      blackboard: { read: [], write: [] },
      wakeup: { taskAvailable: true, events: [] },
    },
  };
}

/** A runtime loop instance bound to one role, sharing the harness stores. */
function makeRuntime(h: Harness, role: string): { runtime: SwarmRuntime; wake: FakeWakePort } {
  const { identity, manifest } = agentFor(h, role);
  const wake = new FakeWakePort();
  const runtime = new SwarmRuntime({
    identity,
    manifest,
    config: h.config,
    taskService: h.service,
    eventStore: new MemoryEventStore(identity.instanceId),
    cursorStore: new MemoryCursorStore(),
    presenceStore: h.presenceStore,
    wake,
    taskStore: h.taskStore,
    timers: undefined,
    now: h.clock.now,
  });
  return { runtime, wake };
}

/** Drive the Issue #1 prologue: tester blocked on a decision obligation. */
async function driveBlocker(h: Harness): Promise<{ obligationId: string; testerTaskId: string; testerClaimId: string }> {
  // 1. All other open work is complete; one long-running task stays in_progress.
  const tester = agentFor(h, "tester");
  const created = await h.service.create(
    { title: "Long verification run", body: "Verifying M2 refix", workDomain: "verification" },
    tester.identity,
  );
  if (!created.ok) throw new Error(created.message);
  const claimed = await h.service.claim(created.task.metadata.id, tester);
  if (claimed.status !== "claimed") throw new Error(claimed.message);
  await h.service.start(created.task.metadata.id, claimed.claim.claimId, tester.identity);

  // 2. Tester discovers a blocker: create the DURABLE decision obligation...
  const obligation = await h.obligations.createObligation(
    {
      kind: "decision",
      workDomain: "decision",
      title: "Decide M2 residual-spin handling",
      reason: "Verification found residual spin",
      sourceTaskId: created.task.metadata.id,
      options: ["fix-first", "continue-full-run"],
      excludeSourceClaimant: true,
    },
    tester.identity,
  );
  if (!obligation.ok) throw new Error(obligation.message);

  // ...then block the current task on it (crash-safe compound order).
  const blocked = await h.service.block(
    created.task.metadata.id,
    claimed.claim.claimId,
    tester.identity,
    { reason: "needs coordinator decision", blockedOn: [obligation.task.metadata.id] },
  );
  if (!blocked.ok) throw new Error(blocked.message);
  return {
    obligationId: obligation.task.metadata.id,
    testerTaskId: created.task.metadata.id,
    testerClaimId: claimed.claim.claimId,
  };
}

describe("Issue #1 regression: durable obligation resolves without a user ping", () => {
  it("coordinator wakes, claims the decision, and the blocked tester task resumes", async () => {
    const h = setupHarness(["coordinator", "backend", "tester"]);
    const { obligationId, testerTaskId, testerClaimId } = await driveBlocker(h);

    // 3. No user message. The coordinator's task loop must surface the decision task.
    const coordinator = makeRuntime(h, "coordinator");
    await coordinator.runtime.start();
    const candidates = await coordinator.runtime.scanTasksOnce();
    expect(candidates.map((c) => c.taskId)).toContain(obligationId);
    // Wake delivered as actionable (follow-up that triggers a turn).
    expect(coordinator.wake.deliveries.length).toBeGreaterThan(0);
    const triggered = coordinator.wake.deliveries.find(
      (d) => d.delivery.deliverAs === "followUp" && "triggerTurn" in d.delivery,
    );
    expect(triggered).toBeDefined();
    await coordinator.runtime.stop();

    // 4. Coordinator claims (claim-time topology re-resolution passes: primary decision).
    const coordinatorAgent = agentFor(h, "coordinator");
    const claim = await h.service.claim(obligationId, coordinatorAgent);
    expect(claim.status).toBe("claimed");

    // 5. Decision completes -> the blocked tester task resumes automatically.
    if (claim.status !== "claimed") return;
    await h.service.start(obligationId, claim.claim.claimId, coordinatorAgent.identity);
    h.clock.advanceMs(1_000);
    const done = await h.service.complete(obligationId, claim.claim.claimId, coordinatorAgent.identity, {
      summary: "fix-first",
    });
    expect(done.ok).toBe(true);
    const resumed: TaskDocument | null = await h.taskStore.get(testerTaskId);
    expect(resumed?.metadata.status).toBe("in_progress"); // claim retained
    expect(await h.claimStore.get(testerTaskId)).not.toBeNull();
    const unblocked = h.events.of("task.unblocked");
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0].route).toEqual({ mode: "direct", role: "tester" });
    void testerClaimId;
  });

  it("variant: without a coordinator, the backend (decision secondary) resolves it", async () => {
    const h = setupHarness(["backend", "tester"]);
    const { obligationId } = await driveBlocker(h);

    const backend = makeRuntime(h, "backend");
    await backend.runtime.start();
    const candidates = await backend.runtime.scanTasksOnce();
    expect(candidates.map((c) => c.taskId)).toContain(obligationId);
    await backend.runtime.stop();

    const backendAgent = agentFor(h, "backend");
    const claim = await h.service.claim(obligationId, backendAgent);
    expect(claim.status).toBe("claimed");
  });

  it("variant: single-agent swarm resolves the obligation through fallback", async () => {
    // Custom world: a lone "researcher" role must fall back into the decision domain.
    const h = setupHarness(
      ["researcher"],
      [manifestDoc("researcher", { primary: ["research"] })],
    );
    const researcher = agentFor(h, "researcher");
    const created = await h.service.create(
      { title: "Lone task", body: "b", workDomain: "research" },
      researcher.identity,
    );
    if (!created.ok) throw new Error(created.message);
    const claimed = await h.service.claim(created.task.metadata.id, researcher);
    if (claimed.status !== "claimed") throw new Error(claimed.message);
    await h.service.start(created.task.metadata.id, claimed.claim.claimId, researcher.identity);

    const obligation = await h.obligations.createObligation(
      {
        kind: "decision",
        workDomain: "decision",
        title: "Lone decision",
        reason: "single-agent blocker",
        sourceTaskId: created.task.metadata.id,
      },
      researcher.identity,
    );
    if (!obligation.ok) throw new Error(obligation.message);

    const runtime = makeRuntime(h, "researcher");
    await runtime.runtime.start();
    const candidates = await runtime.runtime.scanTasksOnce();
    expect(candidates.map((c) => c.taskId)).toContain(obligation.task.metadata.id);
    expect(candidates.find((c) => c.taskId === obligation.task.metadata.id)?.tier).toBe("fallback");
    await runtime.runtime.stop();

    const claim = await h.service.claim(obligation.task.metadata.id, researcher);
    expect(claim.status).toBe("claimed");
  });

  it("boundary: with a coordinator active, the backend is denied the decision task", async () => {
    const h = setupHarness(["coordinator", "backend", "tester"]);
    const { obligationId } = await driveBlocker(h);
    const backend = agentFor(h, "backend");
    const denied = await h.service.claim(obligationId, backend);
    expect(denied.status).toBe("not_eligible");
    if (denied.status === "not_eligible") {
      expect(denied.message).toContain("primary");
    }
  });

  it("dedupe: repeating swarm_request_create with the same arguments returns the existing obligation", async () => {
    const h = setupHarness(["coordinator", "tester"]);
    const tester = agentFor(h, "tester");
    const first = await h.obligations.createObligation(
      { kind: "decision", workDomain: "decision", title: "Same decision", sourceTaskId: "TASK-0001" },
      tester.identity,
    );
    const second = await h.obligations.createObligation(
      { kind: "decision", workDomain: "decision", title: "Same decision", sourceTaskId: "TASK-0001" },
      tester.identity,
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.deduplicated).toBe(true);
    expect(second.task.metadata.id).toBe(first.task.metadata.id);
  });

  it("rework: verification contradiction creates new work excluding the original claimant", async () => {
    const h = setupHarness(["backend", "tester"]);
    const backend = agentFor(h, "backend");
    const tester = agentFor(h, "tester");
    const original = await h.service.create(
      { title: "Implement M2 fix", body: "b", workDomain: "backend" },
      tester.identity,
    );
    if (!original.ok) throw new Error(original.message);
    const claimed = await h.service.claim(original.task.metadata.id, backend);
    if (claimed.status !== "claimed") throw new Error(claimed.message);
    await h.service.start(original.task.metadata.id, claimed.claim.claimId, backend.identity);
    const done = await h.service.complete(original.task.metadata.id, claimed.claim.claimId, backend.identity, {});
    expect(done.ok).toBe(true);

    const rework = await h.obligations.createRework(
      { originalTaskId: original.task.metadata.id, reason: "residual spin still reproduces" },
      tester.identity,
    );
    expect(rework.ok).toBe(true);
    if (!rework.ok) return;
    expect(rework.task.metadata.kind).toBe("rework");
    expect(rework.task.metadata.workDomain).toBe("backend");
    expect(rework.task.metadata.parentTask).toBe(original.task.metadata.id);
    expect(rework.task.metadata.origin?.type).toBe("verification-contradiction");
    expect(rework.task.metadata.constraints?.excludeCurrentClaimant).toBe(true);
    // Original history is immutable (Invariant I).
    expect((await h.taskStore.get(original.task.metadata.id))?.metadata.status).toBe("done");

    // The original claimant (backend) is denied; the topology has no other
    // backend primary, and the fallback pool excludes backend -> unserviceable
    // is CORRECT here would need a third agent; assert the denial explicitly.
    const denied = await h.service.claim(rework.task.metadata.id, backend);
    expect(denied.status).toBe("not_eligible");
  });

  it("scheduled work: not actionable before availableAt, actionable after restart without timers", async () => {
    const h = setupHarness(["backend"]);
    const backend = agentFor(h, "backend");
    const created = await h.service.create(
      {
        title: "Hourly checkpoint",
        body: "b",
        workDomain: "coordination",
        availableAt: "2026-09-24T18:00:00Z",
      },
      backend.identity,
    );
    if (!created.ok) throw new Error(created.message);

    // Before due: nothing surfaces (and the same for a FRESH runtime = restart).
    const early = makeRuntime(h, "backend");
    await early.runtime.start();
    expect((await early.runtime.scanTasksOnce()).map((c) => c.taskId)).not.toContain(
      created.task.metadata.id,
    );
    await early.runtime.stop();

    // Time passes; a NEW runtime instance (restart) finds the due checkpoint
    // through the plain task scan — no in-memory timer was carried over.
    h.clock.advanceMs(60 * 60 * 1000);
    const late = makeRuntime(h, "backend");
    await late.runtime.start();
    const candidates = await late.runtime.scanTasksOnce();
    expect(candidates.map((c) => c.taskId)).toContain(created.task.metadata.id);
    await late.runtime.stop();
  });
});

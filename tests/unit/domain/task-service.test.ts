import { describe, expect, it } from "vitest";
import { createTaskService } from "../../../src/domain/task-service.js";
import { createPolicyService } from "../../../src/domain/policy-service.js";
import { CLAIM_ID_RE, TASK_ID_RE } from "../../../src/protocol/schemas.js";
import {
  FakeEventService,
  MemoryClaimStore,
  MemoryTaskStore,
  fixedClock,
  makeIdentity,
  makeManifest,
} from "./fakes.js";

function setup() {
  const clock = fixedClock();
  const taskStore = new MemoryTaskStore();
  const claimStore = new MemoryClaimStore();
  const events = new FakeEventService(clock.now);
  const service = createTaskService({
    taskStore,
    claimStore,
    policy: createPolicyService(),
    eventService: events,
    now: clock.now,
  });
  const coordinator = makeIdentity("coordinator");
  const backend = makeIdentity("backend");
  return { clock, taskStore, claimStore, events, service, coordinator, backend };
}

describe("task-service create", () => {
  it("persists an open task with defaults and Markdown heading body", async () => {
    const { service, coordinator, taskStore } = setup();
    const result = await service.create(
      { title: "Write API", body: "Goal and acceptance criteria." },
      coordinator,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { task } = result;
    expect(task.metadata.id).toMatch(TASK_ID_RE);
    expect(task.metadata.id).toBe("TASK-0001");
    expect(task.metadata.status).toBe("open");
    expect(task.metadata.kind).toBe("general");
    expect(task.metadata.priority).toBe(50);
    expect(task.metadata.dependsOn).toEqual([]);
    expect(task.metadata.outputs).toEqual([]);
    expect(task.metadata.createdBy).toEqual({
      role: "coordinator",
      instanceId: coordinator.instanceId,
    });
    expect(task.metadata.createdAt).toBe("2026-09-11T10:00:00Z");
    expect(task.metadata.updatedAt).toBe("2026-09-11T10:00:00Z");
    expect(task.body).toBe("# Write API\n\nGoal and acceptance criteria.");
    expect(await taskStore.get("TASK-0001")).not.toBeNull();
  });

  it("emits task.opened broadcast on the tasks topic with references", async () => {
    const { service, coordinator, events } = setup();
    const result = await service.create(
      {
        title: "Write API",
        body: "Do it.",
        kind: "implementation",
        priority: 80,
        eligibleRoles: ["backend"],
        requiredCapabilities: ["rust"],
        dependsOn: [],
      },
      coordinator,
    );
    expect(result.ok).toBe(true);
    const opened = events.of("task.opened");
    expect(opened).toHaveLength(1);
    const event = opened[0];
    expect(event.route).toEqual({ mode: "broadcast", topic: "tasks" });
    expect(event.context).toEqual({ taskId: "TASK-0001" });
    expect(event.from).toEqual({
      role: "coordinator",
      instanceId: coordinator.instanceId,
    });
    expect(event.time).toBe("2026-09-11T10:00:00Z");
    expect(event.data).toEqual({
      taskId: "TASK-0001",
      title: "Write API",
      kind: "implementation",
      priority: 80,
      eligibleRoles: ["backend"],
      requiredCapabilities: ["rust"],
      dependsOn: [],
    });
  });

  it.each([
    ["empty title", { title: "  ", body: "b" }],
    ["title over 200 chars", { title: "x".repeat(201), body: "b" }],
    ["empty body", { title: "t", body: "" }],
    ["priority above 100", { title: "t", body: "b", priority: 101 }],
    ["priority below 0", { title: "t", body: "b", priority: -1 }],
    ["non-integer priority", { title: "t", body: "b", priority: 10.5 }],
    ["bad dependsOn id", { title: "t", body: "b", dependsOn: ["TASK-xy"] }],
    ["bad parentTask id", { title: "t", body: "b", parentTask: "nope" }],
    ["bad eligibleRoles entry", { title: "t", body: "b", eligibleRoles: ["Backend_Role"] }],
    ["bad requiredCapabilities entry", { title: "t", body: "b", requiredCapabilities: [""] }],
  ])("rejects invalid input: %s", async (_name, input) => {
    const { service, coordinator, events } = setup();
    const result = await service.create(
      input as { title: string; body: string; [key: string]: unknown },
      coordinator,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
    expect(result.message.length).toBeGreaterThan(0);
    expect(events.emitted).toHaveLength(0);
  });

  it("re-allocates the id when an exclusive create collides", async () => {
    const { service, coordinator, taskStore } = setup();
    taskStore.collideOnce = "TASK-0001";
    const result = await service.create({ title: "T", body: "B" }, coordinator);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.metadata.id).toBe("TASK-0002");
    // The concurrent creator's file is untouched, ours landed next to it.
    expect((await taskStore.get("TASK-0001"))?.body).toBe("# stolen\n\nstolen");
    expect((await taskStore.get("TASK-0002"))?.body).toBe("# T\n\nB");
  });
});

describe("task-service claim", () => {
  it("claims atomically and updates Markdown status", async () => {
    const { service, coordinator, backend, claimStore, taskStore, events } = setup();
    await service.create({ title: "T", body: "B" }, coordinator);
    const outcome = await service.claim("TASK-0001", {
      identity: backend,
      manifest: makeManifest({ role: "backend" }),
    });
    expect(outcome.status).toBe("claimed");
    if (outcome.status !== "claimed") return;
    expect(outcome.claim.claimId).toMatch(CLAIM_ID_RE);
    expect(outcome.claim.taskId).toBe("TASK-0001");
    expect(outcome.claim.agent).toEqual({
      role: "backend",
      instanceId: backend.instanceId,
    });
    expect(outcome.claim.pid).toBe(backend.pid);
    expect(outcome.claim.claimedAt).toBe("2026-09-11T10:00:00Z");
    expect(outcome.task.metadata.status).toBe("claimed");
    expect((await claimStore.get("TASK-0001"))?.claimId).toBe(outcome.claim.claimId);
    expect((await taskStore.get("TASK-0001"))?.metadata.status).toBe("claimed");

    const claimed = events.of("task.claimed");
    expect(claimed).toHaveLength(1);
    expect(claimed[0].route).toEqual({ mode: "broadcast", topic: "tasks" });
    expect(claimed[0].context).toEqual({ taskId: "TASK-0001" });
    expect(claimed[0].data).toEqual({
      taskId: "TASK-0001",
      claimantRole: "backend",
      claimId: outcome.claim.claimId,
    });
  });

  it("returns still-claimed when the Markdown update fails after claim creation", async () => {
    // Claim file is canonical (§9.5): a Markdown write failure must not
    // roll back ownership.
    const { service, coordinator, backend, claimStore, taskStore } = setup();
    await service.create({ title: "T", body: "B" }, coordinator);
    const originalSave = taskStore.save.bind(taskStore);
    let failOnce = true;
    taskStore.save = async (task, mode) => {
      if (failOnce && task.metadata.status === "claimed") {
        failOnce = false;
        throw new Error("disk full");
      }
      return originalSave(task, mode);
    };
    try {
      const outcome = await service.claim("TASK-0001", {
        identity: backend,
        manifest: makeManifest({ role: "backend" }),
      });
      expect(outcome.status).toBe("claimed");
      expect(await claimStore.get("TASK-0001")).not.toBeNull();
    } finally {
      taskStore.save = originalSave;
    }
  });

  it("rejects malformed and unknown task ids with invalid_task", async () => {
    const { service, coordinator, backend } = setup();
    await service.create({ title: "T", body: "B" }, coordinator);
    const manifest = makeManifest({ role: "backend" });
    const malformed = await service.claim("not-a-task", { identity: backend, manifest });
    expect(malformed.status).toBe("invalid_task");
    const unknown = await service.claim("TASK-9999", { identity: backend, manifest });
    expect(unknown.status).toBe("invalid_task");
  });

  it("returns not_open for a task not in status open", async () => {
    const { service, coordinator, backend, taskStore } = setup();
    await service.create({ title: "T", body: "B" }, coordinator);
    await taskStore.forceStatus("TASK-0001", "done", "2026-09-11T10:01:00Z");
    const outcome = await service.claim("TASK-0001", {
      identity: backend,
      manifest: makeManifest({ role: "backend" }),
    });
    expect(outcome.status).toBe("not_open");
  });

  it("returns already_claimed when a claim record exists (Markdown still open)", async () => {
    const { service, coordinator, backend, claimStore } = setup();
    await service.create({ title: "T", body: "B" }, coordinator);
    // Interrupted claim of a third party: claim file exists, Markdown open.
    await claimStore.tryClaim({
      version: 1,
      taskId: "TASK-0001",
      claimId: "CLM-01ABCDEFGHJKMNPQRSTVWXYZ01",
      agent: { role: "tester", instanceId: "tester-01abcdefghjkmnpqrstvwxyz01" },
      pid: 1111,
      claimedAt: "2026-09-11T10:00:00Z",
    });
    const outcome = await service.claim("TASK-0001", {
      identity: backend,
      manifest: makeManifest({ role: "backend" }),
    });
    expect(outcome.status).toBe("already_claimed");
  });

  it("returns not_eligible with the policy detail", async () => {
    const { service, coordinator, backend } = setup();
    await service.create({ title: "T", body: "B", eligibleRoles: ["researcher"] }, coordinator);
    const outcome = await service.claim("TASK-0001", {
      identity: backend,
      manifest: makeManifest({ role: "backend" }),
    });
    expect(outcome.status).toBe("not_eligible");
    if (outcome.status === "not_eligible") {
      expect(outcome.message).toContain("researcher");
    }
  });
});

describe("task-service list/get", () => {
  it("suppresses claimed and ineligible tasks in the agent view", async () => {
    const { service, coordinator, backend } = setup();
    await service.create({ title: "Mine now", body: "B" }, coordinator);
    await service.create({ title: "Research only", body: "B", eligibleRoles: ["researcher"] }, coordinator);
    await service.create({ title: "Open any", body: "B" }, coordinator);
    const backendAgent = { identity: backend, manifest: makeManifest({ role: "backend" }) };
    await service.claim("TASK-0001", backendAgent);

    // Agent view: own claimed task suppressed (§15.1), researcher-only task
    // filtered as ineligible, only the open any-role task remains.
    const views = await service.list({ forAgent: backendAgent });
    expect(views.map((v) => v.metadata.id)).toEqual(["TASK-0003"]);
    expect(views[0].eligible).toBe(true);
    expect(views[0].claim).toBeNull();

    const all = await service.list({ includeIneligible: true });
    expect(all.map((v) => v.metadata.id)).toEqual(["TASK-0001", "TASK-0002", "TASK-0003"]);
    expect(all.every((v) => v.eligible)).toBe(true); // no forAgent: eligibility not evaluated
    expect(all[0].claim?.agent.role).toBe("backend");

    const diagnostics = await service.list({ forAgent: backendAgent, includeIneligible: true });
    expect(diagnostics.map((v) => [v.metadata.id, v.eligible, v.ineligibleReason])).toEqual([
      ["TASK-0001", false, "status"],
      ["TASK-0002", false, "role"],
      ["TASK-0003", true, undefined],
    ]);
  });

  it("skips dependency-unsatisfied tasks unless requireDependencies is false", async () => {
    const { service, coordinator, backend } = setup();
    await service.create({ title: "Blocked", body: "B", dependsOn: ["TASK-0002"] }, coordinator);
    await service.create({ title: "Blocker", body: "B" }, coordinator);
    const backendAgent = { identity: backend, manifest: makeManifest({ role: "backend" }) };

    const strict = await service.list({ forAgent: backendAgent });
    expect(strict.map((v) => v.metadata.id)).toEqual(["TASK-0002"]);

    const relaxed = await service.list({ forAgent: backendAgent, requireDependencies: false });
    expect(relaxed.map((v) => [v.metadata.id, v.eligible, v.ineligibleReason])).toEqual([
      ["TASK-0001", false, "dependencies"],
      ["TASK-0002", true, undefined],
    ]);
  });

  it("filters by explicit statuses", async () => {
    const { service, coordinator, backend } = setup();
    await service.create({ title: "T1", body: "B" }, coordinator);
    await service.create({ title: "T2", body: "B" }, coordinator);
    const backendAgent = { identity: backend, manifest: makeManifest({ role: "backend" }) };
    const claim = await service.claim("TASK-0001", backendAgent);
    if (claim.status !== "claimed") throw new Error("claim failed");
    await service.start("TASK-0001", claim.claim.claimId, backend);

    const views = await service.list({ statuses: ["in_progress"] });
    expect(views.map((v) => v.metadata.id)).toEqual(["TASK-0001"]);
  });

  it("get returns the task with its claim, or null", async () => {
    const { service, coordinator, backend } = setup();
    await service.create({ title: "T", body: "B" }, coordinator);
    expect(await service.get("TASK-9999")).toBeNull();
    const before = await service.get("TASK-0001");
    expect(before?.claim).toBeNull();
    expect(before?.eligible).toBe(true);

    const claim = await service.claim("TASK-0001", {
      identity: backend,
      manifest: makeManifest({ role: "backend" }),
    });
    if (claim.status !== "claimed") throw new Error("claim failed");
    const after = await service.get("TASK-0001");
    expect(after?.claim?.claimId).toBe(claim.claim.claimId);
    expect(after?.metadata.status).toBe("claimed");
  });
});

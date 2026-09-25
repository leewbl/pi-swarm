import { describe, expect, it } from "vitest";
import { createTaskService } from "../../../src/domain/task-service.js";
import { createPolicyService } from "../../../src/domain/policy-service.js";
import { TASK_STATUSES, TASK_TRANSITIONS } from "../../../src/protocol/schemas.js";
import type { AgentIdentity, TaskStatus } from "../../../src/protocol/schemas.js";
import type { LifecycleResult, TaskService } from "../../../src/domain/types.js";
import {
  FakeEventService,
  MemoryClaimStore,
  MemoryTaskStore,
  fixedClock,
  makeIdentity,
  makeManifest,
} from "./fakes.js";
import type { FixedClock } from "./fakes.js";

interface Harness {
  clock: FixedClock;
  taskStore: MemoryTaskStore;
  claimStore: MemoryClaimStore;
  events: FakeEventService;
  service: TaskService;
  coordinator: AgentIdentity;
  backend: AgentIdentity;
}

function setup(): Harness {
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
  return {
    clock,
    taskStore,
    claimStore,
    events,
    service,
    coordinator: makeIdentity("coordinator"),
    backend: makeIdentity("backend"),
  };
}

let counter = 0;

/** Create a fresh open task and return its id. */
async function newTask(h: Harness): Promise<string> {
  counter += 1;
  const result = await h.service.create(
    { title: `Task ${counter}`, body: "B" },
    h.coordinator,
  );
  if (!result.ok) throw new Error(`create failed: ${result.message}`);
  return result.task.metadata.id;
}

/** Drive a fresh task into `status` through the public service API. */
async function taskInStatus(h: Harness, status: TaskStatus): Promise<{ taskId: string; claimId: string }> {
  const taskId = await newTask(h);
  const backendAgent = { identity: h.backend, manifest: makeManifest({ role: "backend" }) };
  let claimId = "";
  if (status !== "open") {
    const outcome = await h.service.claim(taskId, backendAgent);
    if (outcome.status !== "claimed") throw new Error(`drive claim failed: ${outcome.message}`);
    claimId = outcome.claim.claimId;
  }
  if (["in_progress", "done", "failed", "blocked"].includes(status)) {
    const started = await h.service.start(taskId, claimId, h.backend);
    if (!started.ok) throw new Error("drive start failed");
  }
  if (status === "done") {
    const done = await h.service.complete(taskId, claimId, h.backend, {});
    if (!done.ok) throw new Error("drive complete failed");
  }
  if (status === "failed") {
    const failed = await h.service.fail(taskId, claimId, h.backend, { reason: "driving" });
    if (!failed.ok) throw new Error("drive fail failed");
  }
  if (status === "blocked") {
    const obligationId = await newTask(h);
    const blocked = await h.service.block(taskId, claimId, h.backend, {
      reason: "driving",
      blockedOn: [obligationId],
    });
    if (!blocked.ok) throw new Error("drive block failed");
    (h as Harness & { obligationId?: string }).obligationId = obligationId;
  }
  if (status === "abandoned") {
    const abandoned = await h.service.abandon(taskId, claimId, h.backend);
    if (!abandoned.ok) throw new Error("drive abandon failed");
  }
  return { taskId, claimId };
}

type Attempt = (h: Harness, taskId: string, claimId: string) => Promise<{ ok: boolean; code?: string; status?: string }>;

const ATTEMPTS: Record<Exclude<TaskStatus, "open">, Attempt> = {
  claimed: async (h, taskId) => {
    const outcome = await h.service.claim(taskId, {
      identity: h.backend,
      manifest: makeManifest({ role: "backend" }),
    });
    return { ok: outcome.status === "claimed", status: outcome.status };
  },
  in_progress: async (h, taskId, claimId) => {
    const r = await h.service.start(taskId, claimId, h.backend);
    return { ok: r.ok, code: r.ok ? undefined : r.code };
  },
  done: async (h, taskId, claimId) => {
    const r = await h.service.complete(taskId, claimId, h.backend, {});
    return { ok: r.ok, code: r.ok ? undefined : r.code };
  },
  failed: async (h, taskId, claimId) => {
    const r = await h.service.fail(taskId, claimId, h.backend, { reason: "boom" });
    return { ok: r.ok, code: r.ok ? undefined : r.code };
  },
  abandoned: async (h, taskId, claimId) => {
    const r = await h.service.abandon(taskId, claimId, h.backend);
    return { ok: r.ok, code: r.ok ? undefined : r.code };
  },
  blocked: async (h, taskId, claimId) => {
    const obligationId = await newTask(h);
    const r = await h.service.block(taskId, claimId, h.backend, {
      reason: "attempt",
      blockedOn: [obligationId],
    });
    return { ok: r.ok, code: r.ok ? undefined : r.code };
  },
};

const UNBLOCK: Attempt = async (h, taskId, claimId) => {
  // The obligation is force-completed (bypassing complete()'s auto-resume)
  // so this exercises the manual unblock path.
  const obligationId = (h as Harness & { obligationId?: string }).obligationId;
  if (obligationId !== undefined) {
    await h.taskStore.forceStatus(obligationId, "done", h.clock.now());
  }
  const r = await h.service.unblock(taskId, claimId, h.backend);
  return { ok: r.ok, code: r.ok ? undefined : r.code };
};

const REOPEN: Attempt = async (h, taskId) => {
  const r = await h.service.reopen(taskId, h.coordinator);
  return { ok: r.ok, code: r.ok ? undefined : r.code };
};

function expectFailure(result: LifecycleResult, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

describe("task lifecycle state machine", () => {
  it("succeeds for every transition allowed by TASK_TRANSITIONS", async () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_TRANSITIONS[from]) {
        const h = setup();
        const { taskId, claimId } = await taskInStatus(h, from);
        const attempt =
          to === "open" ? REOPEN : to === "in_progress" && from === "blocked" ? UNBLOCK : ATTEMPTS[to];
        const result = await attempt(h, taskId, claimId);
        expect(
          result.ok,
          `${from} -> ${to} should be allowed (got ${JSON.stringify(result)})`,
        ).toBe(true);
        const task = await h.taskStore.get(taskId);
        expect(task?.metadata.status, `${from} -> ${to}`).toBe(to);
      }
    }
  });

  it("rejects a representative set of invalid transitions with invalid_transition", async () => {
    const invalid: { from: TaskStatus; to: Exclude<TaskStatus, "open"> | "open" }[] = [
      { from: "open", to: "open" },
      { from: "claimed", to: "done" },
      { from: "claimed", to: "failed" },
      { from: "in_progress", to: "in_progress" },
      { from: "done", to: "in_progress" },
      { from: "done", to: "done" },
      { from: "done", to: "abandoned" },
      { from: "done", to: "open" },
      { from: "failed", to: "in_progress" },
      { from: "failed", to: "open" },
      { from: "claimed", to: "blocked" },
    ];
    for (const { from, to } of invalid) {
      const h = setup();
      const { taskId, claimId } = await taskInStatus(h, from);
      const attempt = to === "open" ? REOPEN : ATTEMPTS[to];
      const result = await attempt(h, taskId, claimId);
      expect(result.ok, `${from} -> ${to} must be rejected`).toBe(false);
      expect(result.code, `${from} -> ${to}`).toBe("invalid_transition");
      const task = await h.taskStore.get(taskId);
      expect(task?.metadata.status, `${from} -> ${to} leaves status untouched`).toBe(from);
    }
  });

  it("returns not_found for unknown or malformed task ids", async () => {
    const h = setup();
    expectFailure(await h.service.start("TASK-9999", "CLM-x", h.backend), "not_found");
    expectFailure(await h.service.complete("junk", "CLM-x", h.backend, {}), "not_found");
    expectFailure(
      await h.service.fail("TASK-9999", "CLM-x", h.backend, { reason: "r" }),
      "not_found",
    );
    expectFailure(await h.service.abandon("TASK-9999", "CLM-x", h.backend), "not_found");
    expectFailure(await h.service.reopen("TASK-9999", h.coordinator), "not_found");
  });
});


describe("durable obligation enforcement", () => {
  it("rejects block without obligations (silent-wait deadlock guard)", async () => {
    const h = setup();
    const { taskId, claimId } = await taskInStatus(h, "in_progress");
    const missing = await h.service.block(taskId, claimId, h.backend, { reason: "waiting for somebody" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("invalid_input");
    expect((await h.taskStore.get(taskId))?.metadata.status).toBe("in_progress");

    const obligationId = await newTask(h);
    const valid = await h.service.block(taskId, claimId, h.backend, {
      reason: "needs decision",
      blockedOn: [obligationId],
    });
    expect(valid.ok).toBe(true);

    const ghost = await h.service.block(taskId, claimId, h.backend, {
      reason: "ghost",
      blockedOn: ["TASK-9999"],
    });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.code).toBe("invalid_input");
  });
});
describe("claim ownership validation", () => {
  it("rejects a wrong claimId with not_claim_owner and leaves the task untouched", async () => {
    const h = setup();
    const { taskId, claimId } = await taskInStatus(h, "claimed");
    const result = await h.service.start(taskId, `CLM-not-${claimId}`, h.backend);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_claim_owner");
    expect((await h.taskStore.get(taskId))?.metadata.status).toBe("claimed");
  });

  it("rejects a wrong claimant instanceId with not_claim_owner", async () => {
    const h = setup();
    const { taskId, claimId } = await taskInStatus(h, "claimed");
    const impostor = makeIdentity("backend", 1); // same role, different instance
    const result = await h.service.start(taskId, claimId, impostor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_claim_owner");
    expect((await h.taskStore.get(taskId))?.metadata.status).toBe("claimed");
  });

  it("verifies ownership before the transition check", async () => {
    const h = setup();
    const taskId = await newTask(h); // open, never claimed
    const result = await h.service.start(taskId, "CLM-whatever", h.backend);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_claim_owner"); // not invalid_transition
  });
});

describe("transition side effects", () => {
  it("complete merges outputs without duplicates and appends the summary section", async () => {
    const h = setup();
    const { taskId, claimId } = await taskInStatus(h, "in_progress");
    h.clock.advanceMs(60_000);
    const first = await h.service.complete(taskId, claimId, h.backend, {
      summary: "Shipped",
      outputs: [".pi/swarm/artifacts/a.json", ".pi/swarm/artifacts/b.json"],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.task.metadata.outputs).toEqual([
      ".pi/swarm/artifacts/a.json",
      ".pi/swarm/artifacts/b.json",
    ]);
    expect(first.task.metadata.updatedAt).toBe("2026-09-11T10:01:00Z");

    // Complete again is an invalid transition, so push duplicates through a
    // fresh task with pre-seeded outputs to prove dedupe.
    const second = await newTask(h);
    const claim2 = await h.service.claim(second, {
      identity: h.backend,
      manifest: makeManifest({ role: "backend" }),
    });
    if (claim2.status !== "claimed") throw new Error("claim failed");
    await h.service.start(second, claim2.claim.claimId, h.backend);
    const doc = await h.taskStore.get(second);
    if (doc === null) throw new Error("missing task");
    await h.taskStore.save({
      ...doc,
      metadata: { ...doc.metadata, outputs: [".pi/swarm/artifacts/a.json"] },
    });
    const done = await h.service.complete(second, claim2.claim.claimId, h.backend, {
      outputs: [".pi/swarm/artifacts/a.json", ".pi/swarm/artifacts/c.json"],
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.task.metadata.outputs).toEqual([
      ".pi/swarm/artifacts/a.json",
      ".pi/swarm/artifacts/c.json",
    ]);

    const body = (await h.taskStore.get(taskId))?.body ?? "";
    expect(body).toContain("## Completion\n\nShipped");
    expect(body.startsWith("# Task ")).toBe(true);
    const completed = h.events.of("task.completed");
    expect(completed).toHaveLength(2);
    expect(completed[0].data).toEqual({ taskId });
    expect(completed[0].context).toEqual({ taskId });
    expect(completed[0].route).toEqual({ mode: "broadcast", topic: "tasks" });
  });

  it("fail requires a reason and appends the failure section", async () => {
    const h = setup();
    const { taskId, claimId } = await taskInStatus(h, "in_progress");
    const missing = await h.service.fail(taskId, claimId, h.backend, { reason: "  " });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("invalid_input");

    const result = await h.service.fail(taskId, claimId, h.backend, {
      reason: "build broken",
    });
    expect(result.ok).toBe(true);
    const task = await h.taskStore.get(taskId);
    expect(task?.metadata.status).toBe("failed");
    expect(task?.body).toContain("## Failure\n\nbuild broken");
    const failed = h.events.of("task.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].data).toEqual({ taskId, reason: "build broken" });
  });

  it("abandon releases the claim file and emits task.abandoned with the reason", async () => {
    const h = setup();
    const { taskId, claimId } = await taskInStatus(h, "in_progress");
    const result = await h.service.abandon(taskId, claimId, h.backend, {
      reason: "out of scope",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.task.metadata.status).toBe("abandoned");
    expect(await h.claimStore.get(taskId)).toBeNull();
    const abandoned = h.events.of("task.abandoned");
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].data).toEqual({ taskId, reason: "out of scope" });
    expect(abandoned[0].context).toEqual({ taskId });
  });

  it("reopen moves abandoned to open and emits task.reopened", async () => {
    const h = setup();
    const { taskId } = await taskInStatus(h, "abandoned");
    const result = await h.service.reopen(taskId, h.coordinator);
    expect(result.ok).toBe(true);
    expect(result.ok && result.task.metadata.status).toBe("open");
    const reopened = h.events.of("task.reopened");
    expect(reopened).toHaveLength(1);
    expect(reopened[0].data).toEqual({ taskId });
    expect(reopened[0].context).toEqual({ taskId });
    expect(reopened[0].route).toEqual({ mode: "broadcast", topic: "tasks" });
  });

  it("start emits task.started with the task context", async () => {
    const h = setup();
    const { taskId, claimId } = await taskInStatus(h, "claimed");
    const result = await h.service.start(taskId, claimId, h.backend);
    expect(result.ok).toBe(true);
    const started = h.events.of("task.started");
    expect(started).toHaveLength(1);
    expect(started[0].type).toBe("task.started");
    expect(started[0].context).toEqual({ taskId });
    expect(started[0].data).toEqual({ taskId });
  });
});

import { promises as fsp } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTaskService } from "../../../src/domain/task-service.js";
import { createPolicyService } from "../../../src/domain/policy-service.js";
import { tmpWorkspaceDir } from "../../../src/util/atomic-file.js";
import {
  FakeEventService,
  FsClaimStore,
  MemoryTaskStore,
  fixedClock,
  makeIdentity,
  makeManifest,
} from "../../unit/domain/fakes.js";

let workspace: string;

beforeEach(async () => {
  workspace = await tmpWorkspaceDir("pi-swarm-claim-race");
});

afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
});

function setup() {
  const clock = fixedClock();
  const taskStore = new MemoryTaskStore();
  const claimStore = new FsClaimStore(workspace);
  const events = new FakeEventService(clock.now);
  const service = createTaskService({
    taskStore,
    claimStore,
    policy: createPolicyService(),
    eventService: events,
    now: clock.now,
  });
  return {
    taskStore,
    claimStore,
    events,
    service,
    coordinator: makeIdentity("coordinator"),
    backend: makeIdentity("backend"),
    tester: makeIdentity("tester"),
  };
}

describe("claim contention against a real exclusive-create claim store", () => {
  it("returns already_claimed when the claim file was created first", async () => {
    const { service, claimStore, events, coordinator, backend, tester } = setup();
    await service.create({ title: "T", body: "B" }, coordinator);
    // A third party's claim file already holds TASK-0001 (e.g. created between
    // this agent's policy check and its tryClaim).
    const preExisting = await claimStore.tryClaim({
      version: 1,
      taskId: "TASK-0001",
      claimId: "CLM-01ABCDEFGHJKMNPQRSTVWXYZ01",
      agent: { role: "tester", instanceId: tester.instanceId },
      pid: tester.pid,
      claimedAt: "2026-09-11T09:59:00Z",
    });
    expect(preExisting.status).toBe("claimed");

    const outcome = await service.claim("TASK-0001", {
      identity: backend,
      manifest: makeManifest({ role: "backend" }),
    });
    expect(outcome.status).toBe("already_claimed");
    // The backend's Markdown was not flipped to claimed and no task.claimed
    // event was emitted by the loser.
    expect((await service.get("TASK-0001"))?.metadata.status).toBe("open");
    expect(events.of("task.claimed")).toHaveLength(0);
  });

  it("resolves two concurrent claims to exactly one winner", async () => {
    const { service, claimStore, coordinator, backend, tester } = setup();
    await service.create({ title: "T", body: "B" }, coordinator);
    const outcomes = await Promise.all([
      service.claim("TASK-0001", { identity: backend, manifest: makeManifest({ role: "backend" }) }),
      service.claim("TASK-0001", { identity: tester, manifest: makeManifest({ role: "tester" }) }),
    ]);
    const statuses = outcomes.map((o) => o.status).sort();
    expect(statuses).toEqual(["already_claimed", "claimed"]);
    const winner = outcomes.find((o) => o.status === "claimed");
    if (winner === undefined || winner.status !== "claimed") throw new Error("no winner");

    // The surviving claim file on disk belongs to the winner.
    const onDisk = await claimStore.get("TASK-0001");
    expect(onDisk?.claimId).toBe(winner.claim.claimId);
    expect(onDisk?.agent.role).toBe(winner.claim.agent.role);
  });
});

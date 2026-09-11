import { describe, expect, it } from "vitest";
import { createTaskPoller, extractTaskTitle } from "../../../src/runtime/task-poller.js";
import {
  FakeTaskService,
  MemoryTaskStore,
  captureLogger,
  makeIdentity,
  makeManifest,
  tickClock,
} from "./fakes.js";

function setup(manifestOverrides?: Parameters<typeof makeManifest>[0]) {
  const identity = makeIdentity();
  const taskStore = new MemoryTaskStore();
  const taskService = new FakeTaskService(tickClock(), taskStore);
  const poller = createTaskPoller({
    identity,
    manifest: makeManifest(manifestOverrides),
    taskService,
    taskStore,
    now: tickClock(),
    logger: captureLogger().logger,
  });
  return { identity, taskService, poller };
}

describe("extractTaskTitle", () => {
  it("strips the heading marker from the first body heading", () => {
    expect(extractTaskTitle("# Implement OAuth\n\n## Goal\n")).toBe("Implement OAuth");
  });

  it("strips deeper heading levels and surrounding whitespace", () => {
    expect(extractTaskTitle("intro\n###  Nested heading  \n")).toBe("Nested heading");
  });

  it("falls back to the first non-empty line without a heading", () => {
    expect(extractTaskTitle("\n\nJust a line\nOther\n")).toBe("Just a line");
  });

  it("returns empty for an empty body", () => {
    expect(extractTaskTitle("")).toBe("");
  });
});

describe("createTaskPoller suppression", () => {
  it("surfaces an eligible open task with title, priority and path", async () => {
    const { taskService, poller } = setup();
    const doc = await taskService.addTask({ title: "Implement OAuth", priority: 70 });

    expect(await poller.poll()).toEqual([
      {
        taskId: doc.metadata.id,
        title: "Implement OAuth",
        priority: 70,
        path: `tasks/${doc.metadata.id}.md`,
      },
    ]);
  });

  it("suppresses an unchanged task after its batch is committed", async () => {
    const { taskService, poller } = setup();
    await taskService.addTask({ title: "Stable" });

    expect(await poller.poll()).toHaveLength(1);
    poller.flushNotified();
    expect(await poller.poll()).toEqual([]);
  });

  it("keeps resurfacing uncommitted candidates until flushNotified()", async () => {
    const { taskService, poller } = setup();
    await taskService.addTask({ title: "Not yet delivered" });

    expect(await poller.poll()).toHaveLength(1);
    expect(await poller.poll()).toHaveLength(1); // no commit yet
    poller.flushNotified();
    expect(await poller.poll()).toEqual([]);
  });

  it("drops the task once another instance claims it", async () => {
    const { taskService, poller } = setup();
    const doc = await taskService.addTask({ title: "Shared work" });
    await poller.poll();
    poller.flushNotified();

    await taskService.claimByOther(doc.metadata.id);
    expect(await poller.poll()).toEqual([]);
  });

  it("resurfaces a reopened task whose key changed", async () => {
    const { taskService, poller } = setup();
    const doc = await taskService.addTask({ title: "Contested" });
    await poller.poll();
    poller.flushNotified();

    await taskService.claimByOther(doc.metadata.id);
    expect(await poller.poll()).toEqual([]);
    await taskService.reopenByOther(doc.metadata.id);

    const resurfaced = await poller.poll();
    expect(resurfaced.map((c) => c.taskId)).toEqual([doc.metadata.id]);
  });

  it("resurfaces a committed task after its content changed", async () => {
    const { taskService, poller } = setup();
    const doc = await taskService.addTask({ title: "Evolving spec" });
    await poller.poll();
    poller.flushNotified();
    expect(await poller.poll()).toEqual([]);

    await taskService.touch(doc.metadata.id);

    expect((await poller.poll()).map((c) => c.taskId)).toEqual([doc.metadata.id]);
  });

  it("flushNotified() before any poll is a no-op", async () => {
    const { poller } = setup();
    expect(() => poller.flushNotified()).not.toThrow();
  });
});

describe("createTaskPoller eligibility and ordering", () => {
  it("sorts candidates by priority desc, then id asc", async () => {
    const { taskService, poller } = setup();
    const low = await taskService.addTask({ title: "Low", priority: 10 });
    const high = await taskService.addTask({ title: "High", priority: 90 });
    const tied1 = await taskService.addTask({ title: "Tied one", priority: 90 });
    const tied2 = await taskService.addTask({ title: "Tied two", priority: 90 });

    const candidates = await poller.poll();
    expect(candidates.map((c) => c.taskId)).toEqual([
      high.metadata.id,
      tied1.metadata.id,
      tied2.metadata.id,
      low.metadata.id,
    ]);
  });

  it("excludes tasks restricted to another role", async () => {
    const { taskService, poller } = setup();
    await taskService.addTask({ title: "Frontend only", eligibleRoles: ["frontend"] });
    await taskService.addTask({ title: "Backend ok", eligibleRoles: ["backend"] });

    const candidates = await poller.poll();
    expect(candidates.map((c) => c.title)).toEqual(["Backend ok"]);
  });

  it("excludes tasks with unsatisfied dependencies, includes them once satisfied", async () => {
    const { taskService, poller } = setup();
    const blocker = await taskService.addTask({ title: "Blocker" });
    await taskService.addTask({ title: "Dependent", dependsOn: [blocker.metadata.id] });

    expect(await poller.poll()).toEqual([expect.objectContaining({ title: "Blocker" })]);

    await taskService.setStatus(blocker.metadata.id, "done");

    expect(await poller.poll()).toEqual([expect.objectContaining({ title: "Dependent" })]);
  });

  it("reports lastScanAt after each poll", async () => {
    const { poller } = setup();
    expect(poller.lastScanAt).toBeNull();
    await poller.poll();
    expect(poller.lastScanAt).not.toBeNull();
  });

  it("carries an empty title when no taskStore is provided", async () => {
    const identity = makeIdentity();
    const taskService = new FakeTaskService(tickClock());
    const doc = await taskService.addTask({ title: "No body access" });
    const poller = createTaskPoller({
      identity,
      manifest: makeManifest(),
      taskService,
      now: tickClock(),
      logger: captureLogger().logger,
    });

    expect(await poller.poll()).toEqual([
      {
        taskId: doc.metadata.id,
        title: "",
        priority: 50,
        path: `tasks/${doc.metadata.id}.md`,
      },
    ]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SwarmRuntime } from "../../../src/runtime/runtime.js";
import { DEFAULT_SWARM_CONFIG } from "../../../src/protocol/schemas.js";
import {
  FakeTaskService,
  FakeTimerPort,
  FakeWakePort,
  MemoryPresenceStore,
  MemoryTaskStore,
  captureLogger,
  makeEvent,
  makeIdentity,
  makeManifest,
  tickClock,
} from "../../unit/runtime/fakes.js";
import { FsCursorStore, FsEventStore, setupWorkspace } from "./helpers.js";
import type { Workspace } from "./helpers.js";

let workspace: Workspace;

beforeEach(async () => {
  workspace = await setupWorkspace("pi-swarm-loop");
});

afterEach(async () => {
  await workspace.cleanup();
});

function setupRuntime() {
  const identity = makeIdentity();
  const producerId = makeIdentity("coordinator").instanceId;
  const producerStore = new FsEventStore(workspace.paths, producerId);
  const taskStore = new MemoryTaskStore();
  const taskService = new FakeTaskService(tickClock(), taskStore);
  const wake = new FakeWakePort();
  const timers = new FakeTimerPort();
  const presenceStore = new MemoryPresenceStore();
  const runtime = new SwarmRuntime({
    identity,
    manifest: makeManifest(),
    config: DEFAULT_SWARM_CONFIG,
    taskService,
    eventStore: new FsEventStore(workspace.paths, identity.instanceId),
    cursorStore: new FsCursorStore(workspace.paths),
    presenceStore,
    taskStore,
    wake,
    timers,
    now: tickClock(),
    logger: captureLogger().logger,
  });
  return { identity, producerId, producerStore, taskService, wake, timers, presenceStore, runtime };
}

describe("SwarmRuntime over a real file workspace", () => {
  it("pollEventsOnce() turns a producer's events into one actionable wake", async () => {
    const { producerId, producerStore, wake, runtime } = setupRuntime();
    await producerStore.append(
      makeEvent({
        type: "review.completed",
        from: { role: "coordinator", instanceId: producerId },
        route: { mode: "direct", role: "backend" },
      }),
    );

    const matched = await runtime.pollEventsOnce();

    expect(matched).toHaveLength(1);
    expect(wake.deliveries).toHaveLength(1);
    expect(wake.deliveries[0]!.message.kind).toBe("actionable");
    expect(wake.deliveries[0]!.message.body).toContain("1 review.completed (direct)");
    expect(wake.deliveries[0]!.delivery).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("scanTasksOnce() surfaces a new task, then stays quiet until it changes", async () => {
    const { taskService, wake, runtime } = setupRuntime();
    const doc = await taskService.addTask({ title: "Wire the loops", priority: 80 });

    await runtime.scanTasksOnce();
    expect(wake.deliveries).toHaveLength(1);
    expect(wake.deliveries[0]!.message.body).toContain(
      `${doc.metadata.id} [P80] Wire the loops — tasks/${doc.metadata.id}.md`,
    );

    await runtime.scanTasksOnce();
    expect(wake.deliveries).toHaveLength(1);

    await taskService.touch(doc.metadata.id);
    await runtime.scanTasksOnce();
    expect(wake.deliveries).toHaveLength(2);
  });

  it("keeps batching: events and a task found between two flushes become one wake", async () => {
    const { producerId, producerStore, taskService, wake, runtime } = setupRuntime();

    // Warm the task suppression first so the second scan surfaces nothing stale.
    await taskService.addTask({ title: "Combine me", priority: 60 });
    await runtime.scanTasksOnce();
    expect(wake.deliveries).toHaveLength(1);

    await producerStore.append(
      makeEvent({
        type: "task.claimed",
        from: { role: "coordinator", instanceId: producerId },
        route: { mode: "broadcast", topic: "tasks" },
      }),
    );
    const second = await taskService.addTask({ title: "Batched work", priority: 40 });

    const candidates = await runtime.scanTasksOnce();
    const matched = await runtime.pollEventsOnce();

    // Each cycle flushes its own batch; the two batches stay separate wakes.
    expect(candidates.map((c) => c.taskId)).toEqual([second.metadata.id]);
    expect(matched).toHaveLength(1);
    expect(wake.deliveries).toHaveLength(3);
    const titles = wake.deliveries.map((d) => d.message.title);
    expect(titles).toContain("SWARM INBOX — 1 task");
    expect(titles).toContain("SWARM INBOX — 1 event");
  });

  it("timer-driven loops poll, heartbeat and respect stop()", async () => {
    const { producerId, producerStore, wake, timers, presenceStore, identity, runtime } =
      setupRuntime();
    await producerStore.append(
      makeEvent({
        type: "review.completed",
        from: { role: "coordinator", instanceId: producerId },
        route: { mode: "broadcast", topic: "review" },
      }),
    );

    await runtime.start();
    expect(timers.entries).toHaveLength(3);

    await timers.fireAll();

    expect(wake.deliveries).toHaveLength(1);
    expect(runtime.status().running).toBe(true);
    expect(runtime.status().consumedEvents).toBe(1);

    await runtime.stop();

    expect(timers.entries.every((e) => e.cleared)).toBe(true);
    expect(presenceStore.records.get(identity.instanceId)!.state).toBe("stopped");

    // Firing after stop does nothing.
    await timers.fireAll();
    expect(wake.deliveries).toHaveLength(1);
  });

  it("active sessions receive actionable batches as follow-ups", async () => {
    const { producerId, producerStore, wake, runtime } = setupRuntime();
    await runtime.start();
    await runtime.markBusy();

    await producerStore.append(
      makeEvent({
        type: "review.completed",
        from: { role: "coordinator", instanceId: producerId },
        route: { mode: "broadcast", topic: "review" },
      }),
    );
    await runtime.start();
    wake.idle = false;
    await runtime.markBusy();
    await runtime.pollEventsOnce();

    expect(wake.deliveries).toHaveLength(1);
    expect(wake.deliveries[0]!.delivery).toEqual({ deliverAs: "followUp", triggerTurn: true });

    await runtime.stop();
  });
});

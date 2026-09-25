import { describe, expect, it } from "vitest";
import { SwarmRuntime, createSwarmRuntime } from "../../../src/runtime/runtime.js";
import { DEFAULT_SWARM_CONFIG } from "../../../src/protocol/schemas.js";
import type { NormalizedAgentManifest } from "../../../src/protocol/schemas.js";
import type { EventStore } from "../../../src/storage/types.js";
import {
  FakeTaskService,
  FakeTimerPort,
  FakeWakePort,
  MemoryCursorStore,
  MemoryEventStore,
  MemoryPresenceStore,
  MemoryTaskStore,
  captureLogger,
  makeEvent,
  makeIdentity,
  makeManifest,
  tickClock,
} from "./fakes.js";

function setup(options?: { manifest?: NormalizedAgentManifest }) {
  const identity = makeIdentity();
  const producer = makeIdentity("coordinator");
  const eventStore = new MemoryEventStore(identity.instanceId);
  const presenceStore = new MemoryPresenceStore();
  const taskStore = new MemoryTaskStore();
  const taskService = new FakeTaskService(tickClock(), taskStore);
  const wake = new FakeWakePort();
  const timers = new FakeTimerPort();
  const logger = captureLogger();
  const runtime = new SwarmRuntime({
    identity,
    manifest: options?.manifest ?? makeManifest(),
    config: DEFAULT_SWARM_CONFIG,
    taskService,
    eventStore,
    cursorStore: new MemoryCursorStore(),
    presenceStore,
    taskStore,
    wake,
    timers,
    now: tickClock(),
    logger: logger.logger,
  });
  return {
    identity,
    producer,
    eventStore,
    presenceStore,
    taskService,
    wake,
    timers,
    runtime,
    logs: logger.lines,
  };
}

async function seedEvent(
  store: MemoryEventStore,
  producerId: string,
  overrides: { type?: string } = {},
): Promise<string> {
  const event = makeEvent({
    type: overrides.type ?? "task.claimed",
    from: { role: "coordinator", instanceId: producerId },
    route: { mode: "broadcast", topic: "tasks" },
  });
  await store.appendRaw(producerId, `${JSON.stringify(event)}\n`);
  return event.id;
}

describe("SwarmRuntime lifecycle", () => {
  it("start() registers event, task-scan and heartbeat intervals", async () => {
    const { runtime, timers, presenceStore, identity } = setup();

    await runtime.start();

    expect(timers.entries).toHaveLength(3);
    expect(timers.entries.map((e) => e.cleared)).toEqual([false, false, false]);
    expect(presenceStore.records.get(identity.instanceId)!.state).toBe("idle");
    await runtime.stop();
  });

  it("start() skips the task-scan interval when wakeup.taskAvailable is false", async () => {
    const { runtime, timers } = setup({
      manifest: makeManifest({ wakeup: { taskAvailable: false, events: [] } }),
    });

    await runtime.start();
    expect(timers.entries).toHaveLength(2);
    await runtime.stop();
  });

  it("stop() clears every interval and marks presence stopped", async () => {
    const { runtime, timers, presenceStore, identity } = setup();
    await runtime.start();

    await runtime.stop();

    expect(timers.entries.every((e) => e.cleared)).toBe(true);
    expect(presenceStore.records.get(identity.instanceId)!.state).toBe("stopped");
    expect(runtime.status().running).toBe(false);
  });

  it("start() is idempotent", async () => {
    const { runtime, timers } = setup();
    await runtime.start();
    await runtime.start();
    expect(timers.entries).toHaveLength(3);
    await runtime.stop();
  });
});

describe("SwarmRuntime status", () => {
  it("populates identity and loop fields", async () => {
    const { identity, producer, eventStore, taskService, runtime } = setup();
    expect(runtime.status()).toEqual({
      role: identity.role,
      instanceId: identity.instanceId,
      running: false,
      lastTaskScanAt: null,
      lastEventPollAt: null,
      pendingWake: 0,
      consumedEvents: 0,
    });

    await seedEvent(eventStore, producer.instanceId);
    await taskService.addTask({ title: "Fresh work" });

    await runtime.pollEventsOnce();
    await runtime.scanTasksOnce();

    const status = runtime.status();
    expect(status.running).toBe(false);
    expect(status.lastEventPollAt).not.toBeNull();
    expect(status.lastTaskScanAt).not.toBeNull();
    expect(status.consumedEvents).toBe(1);
    expect(status.pendingWake).toBe(0);
  });
});

describe("SwarmRuntime timer-free loop drives", () => {
  it("pollEventsOnce() delivers matched events as one wake batch", async () => {
    const { producer, eventStore, wake, runtime } = setup();
    await seedEvent(eventStore, producer.instanceId, { type: "review.completed" });
    await seedEvent(eventStore, producer.instanceId);

    const matched = await runtime.pollEventsOnce();

    expect(matched).toHaveLength(2);
    expect(wake.deliveries).toHaveLength(1);
    const { message, delivery } = wake.deliveries[0]!;
    expect(message.kind).toBe("actionable");
    expect(message.title).toBe("SWARM INBOX — 2 events");
    expect(delivery).toEqual({ deliverAs: "followUp", triggerTurn: true });

    await runtime.pollEventsOnce();
    expect(wake.deliveries).toHaveLength(1);
  });

  it("scanTasksOnce() surfaces eligible tasks as an actionable wake", async () => {
    const { taskService, wake, runtime } = setup();
    await taskService.addTask({ title: "Implement OAuth", priority: 70 });

    const candidates = await runtime.scanTasksOnce();

    expect(candidates).toHaveLength(1);
    expect(wake.deliveries).toHaveLength(1);
    const { message, delivery } = wake.deliveries[0]!;
    expect(message.kind).toBe("actionable");
    expect(message.body).toContain("TASK-0001 [P70] Implement OAuth — tasks/TASK-0001.md");
    expect(delivery).toEqual({ deliverAs: "followUp", triggerTurn: true });

    // Unchanged task stays suppressed after the delivered wake flushed it.
    await runtime.scanTasksOnce();
    expect(wake.deliveries).toHaveLength(1);
  });

  it("markBusy()/markIdle() drive the presence state", async () => {
    const { presenceStore, identity, runtime } = setup();
    await runtime.start();

    await runtime.markBusy();
    expect(presenceStore.records.get(identity.instanceId)!.state).toBe("busy");

    await runtime.markIdle();
    expect(presenceStore.records.get(identity.instanceId)!.state).toBe("idle");

    await runtime.stop();
  });
});

describe("SwarmRuntime timer callbacks", () => {
  it("firing the intervals runs polls and heartbeats", async () => {
    const { producer, eventStore, timers, wake, presenceStore, identity, runtime } = setup();
    await seedEvent(eventStore, producer.instanceId, { type: "review.completed" });
    await runtime.start();

    await timers.fireAll();

    expect(wake.deliveries).toHaveLength(1);
    const heartbeat = presenceStore.records.get(identity.instanceId)!;
    expect(heartbeat.heartbeatAt >= heartbeat.startedAt).toBe(true);
    expect(runtime.status().running).toBe(true);

    await runtime.stop();
  });

  it("a failing loop logs instead of surfacing an unhandled rejection", async () => {
    const healthy = new MemoryEventStore("unused");
    const broken: EventStore = {
      append: (event) => healthy.append(event),
      readFrom: (producer, offset) => healthy.readFrom(producer, offset),
      streamSize: (producer) => healthy.streamSize(producer),
      listStreams: () => {
        throw new Error("fs gone");
      },
    };
    const timers = new FakeTimerPort();
    const logs = captureLogger();
    const runtime = createSwarmRuntime({
      identity: makeIdentity(),
      manifest: makeManifest(),
      config: DEFAULT_SWARM_CONFIG,
      taskService: new FakeTaskService(tickClock()),
      eventStore: broken,
      cursorStore: new MemoryCursorStore(),
      presenceStore: new MemoryPresenceStore(),
      wake: new FakeWakePort(),
      timers,
      now: tickClock(),
      logger: logs.logger,
    });
    await runtime.start();

    await timers.fireAll(); // must not reject

    expect(logs.lines.some((line) => line.includes("eventPoll loop failed"))).toBe(true);
    expect(logs.lines.some((line) => line.includes("taskScan loop failed"))).toBe(false);
    expect(runtime.status().running).toBe(true);
    await runtime.stop();
  });
});

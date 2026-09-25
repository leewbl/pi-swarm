/**
 * Event reliability regressions (structural liveness fix §18/§17/§32):
 *
 * - onMatch failure: poll #1 throws -> poll #2 must redeliver the SAME event
 *   (neither the seen-dedupe window nor the cursor was committed);
 * - direct events are actionable by default even when not listed in
 *   wakeup.events (latency optimization, §17.1);
 * - broadcast events stay informational unless opted in — and never affect
 *   task liveness (the task pool remains the work authority).
 */
import { describe, expect, it } from "vitest";
import { createEventPoller } from "../../../src/runtime/event-poller.js";
import type { MatchedEvent } from "../../../src/runtime/ports.js";
import { MemoryCursorStore, MemoryEventStore, makeEvent, makeIdentity, makeManifest } from "./fakes.js";

function setup(manifestOverrides: Parameters<typeof makeManifest>[0] = {}) {
  const producer = makeIdentity("coordinator");
  const consumer = makeIdentity("backend");
  const eventStore = new MemoryEventStore(producer.instanceId);
  const cursorStore = new MemoryCursorStore();
  const manifest = makeManifest(manifestOverrides);
  return { producer, consumer, eventStore, cursorStore, manifest };
}

describe("event poller reliability (fix §18/§32)", () => {
  it("redelivers the same event after onMatch throws on the first attempt", async () => {
    const { producer, consumer, eventStore, cursorStore, manifest } = setup();
    const event = makeEvent({
      type: "review.completed",
      from: { role: producer.role, instanceId: producer.instanceId },
      route: { mode: "broadcast", topic: "tasks" },
    });
    await eventStore.append(event);

    const batches: MatchedEvent[][] = [];
    let attempts = 0;
    const poller = createEventPoller({
      identity: consumer,
      manifest: { ...manifest, wakeup: { taskAvailable: true, events: ["review.completed"] } },
      eventStore,
      cursorStore,
      onMatch: (events) => {
        attempts += 1;
        batches.push(events);
        if (attempts === 1) throw new Error("delivery crashed");
      },
    });

    await expect(poller.poll()).rejects.toThrow("delivery crashed");
    // Cursor and seen window were NOT committed: the retry sees the event again.
    const second = await poller.poll();
    expect(second.map((m) => m.event.id)).toEqual([event.id]);
    expect(attempts).toBe(2);

    // After a successful delivery the dedupe window commits: a replay of the
    // same stream content yields nothing new.
    const third = await poller.poll();
    expect(third).toEqual([]);
  });

  it("redelivers the same event after cursor persistence throws (seen committed last)", async () => {
    const { producer, consumer, eventStore, cursorStore, manifest } = setup();
    const event = makeEvent({
      type: "review.completed",
      from: { role: producer.role, instanceId: producer.instanceId },
      route: { mode: "broadcast", topic: "tasks" },
    });
    await eventStore.append(event);

    let saveAttempts = 0;
    const failingCursorStore = {
      load: cursorStore.load.bind(cursorStore),
      save: async (consumerId: string, state: unknown) => {
        saveAttempts += 1;
        if (saveAttempts === 1) throw new Error("cursor write failed");
        return cursorStore.save(consumerId, state as never);
      },
    };

    let deliveries = 0;
    const poller = createEventPoller({
      identity: consumer,
      manifest: { ...manifest, wakeup: { taskAvailable: true, events: ["review.completed"] } },
      eventStore,
      cursorStore: failingCursorStore,
      onMatch: () => {
        deliveries += 1;
      },
    });

    // onMatch succeeds but cursor.save throws: the seen window must NOT be
    // committed, or the redelivery below would be suppressed and the event lost.
    await expect(poller.poll()).rejects.toThrow("cursor write failed");
    expect(deliveries).toBe(1);

    const retry = await poller.poll();
    expect(retry.map((m) => m.event.id)).toEqual([event.id]);
    expect(deliveries).toBe(2);
  });

  it("treats direct events as actionable by default (not listed in wakeup.events)", async () => {
    const { producer, consumer, eventStore, cursorStore, manifest } = setup({
      wakeup: { taskAvailable: true, events: [] },
    });
    const event = makeEvent({
      type: "m2.refix.partially-verified", // custom type, NOT in wakeup.events
      from: { role: producer.role, instanceId: producer.instanceId },
      route: { mode: "direct", role: "backend" },
    });
    await eventStore.append(event);

    const delivered: MatchedEvent[] = [];
    const poller = createEventPoller({
      identity: consumer,
      manifest,
      eventStore,
      cursorStore,
      onMatch: (events) => {
        delivered.push(...events);
      },
    });
    await poller.poll();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].channel).toBe("direct");
    expect(delivered[0].actionable).toBe(true);
  });

  it("keeps unlisted broadcast events informational (no required work implied)", async () => {
    const { producer, consumer, eventStore, cursorStore, manifest } = setup({
      wakeup: { taskAvailable: true, events: [] },
    });
    const event = makeEvent({
      type: "architecture.updated",
      from: { role: producer.role, instanceId: producer.instanceId },
      route: { mode: "broadcast", topic: "tasks" },
    });
    await eventStore.append(event);

    const delivered: MatchedEvent[] = [];
    const poller = createEventPoller({
      identity: consumer,
      manifest,
      eventStore,
      cursorStore,
      onMatch: (events) => {
        delivered.push(...events);
      },
    });
    await poller.poll();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].actionable).toBe(false);
  });

  it("respects explicit wakeup.events opt-in for broadcast events", async () => {
    const { producer, consumer, eventStore, cursorStore, manifest } = setup({
      wakeup: { taskAvailable: true, events: ["task.completed"] },
    });
    const event = makeEvent({
      type: "task.completed",
      from: { role: producer.role, instanceId: producer.instanceId },
      route: { mode: "broadcast", topic: "tasks" },
    });
    await eventStore.append(event);

    const delivered: MatchedEvent[] = [];
    const poller = createEventPoller({
      identity: consumer,
      manifest,
      eventStore,
      cursorStore,
      onMatch: (events) => {
        delivered.push(...events);
      },
    });
    await poller.poll();
    expect(delivered[0].actionable).toBe(true);
  });
});

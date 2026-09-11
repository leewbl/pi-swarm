import { describe, expect, it } from "vitest";
import { createEventPoller } from "../../../src/runtime/event-poller.js";
import type { MatchedEvent } from "../../../src/runtime/ports.js";
import {
  MemoryCursorStore,
  MemoryEventStore,
  captureLogger,
  makeEvent,
  makeIdentity,
  makeManifest,
  tickClock,
} from "./fakes.js";

interface Harness {
  identity: ReturnType<typeof makeIdentity>;
  producerId: string;
  store: MemoryEventStore;
  cursors: MemoryCursorStore;
  delivered: MatchedEvent[];
  poll: () => Promise<MatchedEvent[]>;
}

function harness(manifestOverrides?: Parameters<typeof makeManifest>[0]): Harness {
  const identity = makeIdentity();
  const producer = makeIdentity("coordinator");
  const store = new MemoryEventStore(identity.instanceId);
  const cursors = new MemoryCursorStore();
  const delivered: MatchedEvent[] = [];
  const poller = createEventPoller({
    identity,
    manifest: makeManifest(manifestOverrides),
    eventStore: store,
    cursorStore: cursors,
    onMatch: (events) => {
      delivered.push(...events);
    },
    now: tickClock(),
    logger: captureLogger().logger,
  });
  return {
    identity,
    producerId: producer.instanceId,
    store,
    cursors,
    delivered,
    poll: () => poller.poll(),
  };
}

describe("createEventPoller routing", () => {
  it("delivers direct events addressed to our role on the direct channel", async () => {
    const h = harness();
    const event = makeEvent({
      from: { role: "coordinator", instanceId: h.producerId },
      route: { mode: "direct", role: "backend" },
    });
    await h.store.appendRaw(h.producerId, `${JSON.stringify(event)}\n`);

    const matched = await h.poll();

    expect(matched).toHaveLength(1);
    expect(matched[0]!.channel).toBe("direct");
    expect(matched[0]!.event.id).toBe(event.id);
    expect(h.delivered).toHaveLength(1);
  });

  it("skips direct events addressed to another role", async () => {
    const h = harness();
    const event = makeEvent({
      from: { role: "coordinator", instanceId: h.producerId },
      route: { mode: "direct", role: "frontend" },
    });
    await h.store.appendRaw(h.producerId, `${JSON.stringify(event)}\n`);

    expect(await h.poll()).toHaveLength(0);
  });

  it("delivers broadcast events on a subscribed topic", async () => {
    const h = harness();
    const event = makeEvent({
      type: "task.opened",
      from: { role: "coordinator", instanceId: h.producerId },
      route: { mode: "broadcast", topic: "review" },
    });
    await h.store.appendRaw(h.producerId, `${JSON.stringify(event)}\n`);

    const matched = await h.poll();
    expect(matched).toHaveLength(1);
    expect(matched[0]!.channel).toBe("broadcast");
  });

  it("skips broadcast events on unsubscribed topics", async () => {
    const h = harness();
    const event = makeEvent({
      from: { role: "coordinator", instanceId: h.producerId },
      route: { mode: "broadcast", topic: "misc" },
    });
    await h.store.appendRaw(h.producerId, `${JSON.stringify(event)}\n`);

    expect(await h.poll()).toHaveLength(0);
  });

  it("skips direct events entirely when the manifest disables direct subscriptions", async () => {
    const h = harness({ subscriptions: { direct: false, topics: ["tasks"] } });
    const direct = makeEvent({
      from: { role: "coordinator", instanceId: h.producerId },
      route: { mode: "direct", role: "backend" },
    });
    const broadcast = makeEvent({
      from: { role: "coordinator", instanceId: h.producerId },
      route: { mode: "broadcast", topic: "tasks" },
    });
    await h.store.appendRaw(
      h.producerId,
      `${JSON.stringify(direct)}\n${JSON.stringify(broadcast)}\n`,
    );

    const matched = await h.poll();
    expect(matched).toHaveLength(1);
    expect(matched[0]!.channel).toBe("broadcast");
  });

  it("never reads its own stream (self events stay audit-only)", async () => {
    const h = harness();
    const own = makeEvent({
      from: { role: "backend", instanceId: h.identity.instanceId },
      route: { mode: "broadcast", topic: "tasks" },
    });
    await h.store.append(own);
    const foreign = makeEvent({
      from: { role: "coordinator", instanceId: h.producerId },
      route: { mode: "broadcast", topic: "tasks" },
    });
    await h.store.appendRaw(h.producerId, `${JSON.stringify(foreign)}\n`);

    const matched = await h.poll();

    expect(matched.map((m) => m.event.id)).toEqual([foreign.id]);
    const state = await h.cursors.load(h.identity.instanceId);
    expect(Object.keys(state.streams)).not.toContain(h.identity.instanceId);
  });

  it("classifies actionable events via manifest wakeup.events", async () => {
    const h = harness();
    const actionable = makeEvent({
      type: "review.completed",
      from: { role: "coordinator", instanceId: h.producerId },
      route: { mode: "broadcast", topic: "review" },
    });
    const informational = makeEvent({
      type: "task.claimed",
      from: { role: "coordinator", instanceId: h.producerId },
      route: { mode: "broadcast", topic: "tasks" },
    });
    await h.store.appendRaw(
      h.producerId,
      `${JSON.stringify(actionable)}\n${JSON.stringify(informational)}\n`,
    );

    const matched = await h.poll();
    const byId = new Map(matched.map((m) => [m.event.id, m.actionable]));
    expect(byId.get(actionable.id)).toBe(true);
    expect(byId.get(informational.id)).toBe(false);
  });
});

describe("createEventPoller cursors and dedupe", () => {
  it("delivers each event exactly once across sequential polls and persists the cursor", async () => {
    const h = harness();
    const e1 = makeEvent({ from: { role: "coordinator", instanceId: h.producerId } });
    const e2 = makeEvent({ from: { role: "coordinator", instanceId: h.producerId } });
    await h.store.appendRaw(
      h.producerId,
      `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`,
    );

    const first = await h.poll();
    const second = await h.poll();

    expect(first.map((m) => m.event.id)).toEqual([e1.id, e2.id]);
    expect(second).toHaveLength(0);

    const cursor = (await h.cursors.load(h.identity.instanceId)).streams[h.producerId]!;
    expect(cursor.offset).toBe(await h.store.streamSize(h.producerId));
    expect(cursor.lastEventId).toBe(e2.id);
  });

  it("skips events already seen by id even when the cursor rewinds", async () => {
    const h = harness();
    const event = makeEvent({ from: { role: "coordinator", instanceId: h.producerId } });
    await h.store.appendRaw(h.producerId, `${JSON.stringify(event)}\n`);

    expect(await h.poll()).toHaveLength(1);

    // Simulate cursor loss: the poller re-reads from zero but dedupes by id.
    h.cursors.states.delete(h.identity.instanceId);
    expect(await h.poll()).toHaveLength(0);
  });

  it("suppresses the cursor persist when onMatch throws (at-least-once)", async () => {
    const h = harness();
    const event = makeEvent({ from: { role: "coordinator", instanceId: h.producerId } });
    await h.store.appendRaw(h.producerId, `${JSON.stringify(event)}\n`);

    const delivered: MatchedEvent[] = [];
    const poller = createEventPoller({
      identity: h.identity,
      manifest: makeManifest(),
      eventStore: h.store,
      cursorStore: h.cursors,
      onMatch: (events) => {
        delivered.push(...events);
        throw new Error("inbox full");
      },
      now: tickClock(),
      logger: captureLogger().logger,
    });

    await expect(poller.poll()).rejects.toThrow("inbox full");
    expect((await h.cursors.load(h.identity.instanceId)).streams).toEqual({});
  });

  it("exposes consumedCount and lastPollAt", async () => {
    const identity = makeIdentity();
    const producer = makeIdentity("coordinator");
    const store = new MemoryEventStore(identity.instanceId);
    const event = makeEvent({ from: { role: "coordinator", instanceId: producer.instanceId } });
    await store.appendRaw(producer.instanceId, `${JSON.stringify(event)}\n`);
    let clock = "2026-09-11T00:00:00Z";
    const poller = createEventPoller({
      identity,
      manifest: makeManifest(),
      eventStore: store,
      cursorStore: new MemoryCursorStore(),
      onMatch: () => {},
      now: () => clock,
      logger: captureLogger().logger,
    });

    expect(poller.lastPollAt).toBeNull();
    expect(poller.consumedCount).toBe(0);

    clock = "2026-09-11T00:00:01Z";
    await poller.poll();

    expect(poller.consumedCount).toBe(1);
    expect(poller.lastPollAt).toBe("2026-09-11T00:00:01Z");
  });
});

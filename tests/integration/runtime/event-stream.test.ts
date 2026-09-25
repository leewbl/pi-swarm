import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import { createEventPoller } from "../../../src/runtime/event-poller.js";
import { createInbox } from "../../../src/runtime/inbox.js";
import { createWakeScheduler } from "../../../src/runtime/wake-scheduler.js";
import type { MatchedEvent } from "../../../src/runtime/ports.js";
import {
  FakeWakePort,
  captureLogger,
  makeEvent,
  makeIdentity,
  makeManifest,
  tickClock,
} from "../../unit/runtime/fakes.js";
import { FsCursorStore, FsEventStore, setupWorkspace } from "./helpers.js";
import type { Workspace } from "./helpers.js";

let workspace: Workspace;
let producerId: string;
let store: FsEventStore;

beforeEach(async () => {
  workspace = await setupWorkspace("pi-swarm-events");
  producerId = makeIdentity("coordinator").instanceId;
  store = new FsEventStore(workspace.paths, producerId);
});

afterEach(async () => {
  await workspace.cleanup();
});

function makePoller(consumerInstanceId: string, cursors: FsCursorStore) {
  const identity = { ...makeIdentity(), instanceId: consumerInstanceId };
  const delivered: MatchedEvent[] = [];
  const poller = createEventPoller({
    identity,
    manifest: makeManifest(),
    eventStore: store,
    cursorStore: cursors,
    onMatch: (events) => {
      delivered.push(...events);
    },
    now: tickClock(),
    logger: captureLogger().logger,
  });
  return { identity, poller, delivered };
}

async function appendEvents(...types: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const type of types) {
    const event = makeEvent({
      type,
      from: { role: "coordinator", instanceId: producerId },
      route: { mode: "broadcast", topic: "tasks" },
    });
    ids.push(event.id);
    await store.append(event);
  }
  return ids;
}

describe("event stream cursor discipline (real JSONL files)", () => {
  it("delivers each event exactly once across sequential polls", async () => {
    const cursors = new FsCursorStore(workspace.paths);
    const { identity, poller, delivered } = makePoller(makeIdentity().instanceId, cursors);
    const [e1, e2] = await appendEvents("task.opened", "task.claimed");

    const first = await poller.poll();
    const second = await poller.poll();

    expect(first.map((m) => m.event.id)).toEqual([e1, e2]);
    expect(second).toEqual([]);
    expect(delivered).toHaveLength(2);

    const cursor = (await cursors.load(identity.instanceId)).streams[producerId]!;
    expect(cursor.offset).toBe((await fsp.stat(workspace.paths.eventStreamFile(producerId))).size);
    expect(cursor.lastEventId).toBe(e2);
  });

  it("withholds a partial trailing line and keeps the cursor unchanged", async () => {
    const cursors = new FsCursorStore(workspace.paths);
    const { identity, poller, delivered } = makePoller(makeIdentity().instanceId, cursors);
    await appendEvents("task.opened");
    await poller.poll();
    const cursorBefore = (await cursors.load(identity.instanceId)).streams[producerId]!;

    // Append bytes WITHOUT the terminating newline directly to the stream.
    const partial = JSON.stringify(
      makeEvent({
        type: "task.claimed",
        from: { role: "coordinator", instanceId: producerId },
        route: { mode: "broadcast", topic: "tasks" },
      }),
    );
    await fsp.appendFile(workspace.paths.eventStreamFile(producerId), partial.slice(0, 40), "utf8");

    expect(await poller.poll()).toEqual([]);
    expect(delivered).toHaveLength(1); // only the first event, ever

    const cursorAfter = (await cursors.load(identity.instanceId)).streams[producerId]!;
    expect(cursorAfter).toEqual(cursorBefore);
  });

  it("delivers the completed line exactly once", async () => {
    const cursors = new FsCursorStore(workspace.paths);
    const { poller, delivered } = makePoller(makeIdentity().instanceId, cursors);
    await appendEvents("task.opened");
    const second = makeEvent({
      type: "task.claimed",
      from: { role: "coordinator", instanceId: producerId },
      route: { mode: "broadcast", topic: "tasks" },
    });
    const line = JSON.stringify(second);
    await fsp.appendFile(workspace.paths.eventStreamFile(producerId), line.slice(0, 55), "utf8");
    await poller.poll();
    expect(delivered).toHaveLength(1);

    await fsp.appendFile(workspace.paths.eventStreamFile(producerId), `${line.slice(55)}\n`, "utf8");

    const matched = await poller.poll();
    expect(matched.map((m) => m.event.id)).toEqual([second.id]);
    await poller.poll();
    expect(delivered).toHaveLength(2);
  });

  it("skips a malformed complete line and still delivers later valid events", async () => {
    const cursors = new FsCursorStore(workspace.paths);
    const { identity, poller } = makePoller(makeIdentity().instanceId, cursors);
    await appendEvents("task.opened");
    await poller.poll();

    await fsp.appendFile(workspace.paths.eventStreamFile(producerId), '{"bogus": tru\n', "utf8");
    const valid = makeEvent({
      type: "task.completed",
      from: { role: "coordinator", instanceId: producerId },
      route: { mode: "broadcast", topic: "tasks" },
    });
    await store.append(valid);

    const matched = await poller.poll();
    expect(matched.map((m) => m.event.id)).toEqual([valid.id]);

    // The cursor advanced past the malformed line: nothing is redelivered.
    await poller.poll();
    const cursor = (await cursors.load(identity.instanceId)).streams[producerId]!;
    expect(cursor.offset).toBe((await fsp.stat(workspace.paths.eventStreamFile(producerId))).size);
    expect(cursor.lastEventId).toBe(valid.id);
  });

  it("a fresh poller on the same cursor store resumes with no redelivery", async () => {
    const consumerId = makeIdentity().instanceId;
    const cursors = new FsCursorStore(workspace.paths);
    const first = makePoller(consumerId, cursors);
    await appendEvents("task.claimed", "task.claimed", "task.claimed");
    await first.poller.poll();
    expect(first.delivered).toHaveLength(3);

    const second = makePoller(consumerId, cursors);
    expect(await second.poller.poll()).toEqual([]);
    expect(second.delivered).toHaveLength(0);
  });

  it("cursor file loss replays the stream but dedupes into at most one batch", async () => {
    const consumerId = makeIdentity().instanceId;
    const cursors = new FsCursorStore(workspace.paths);
    const first = makePoller(consumerId, cursors);
    await appendEvents("task.claimed", "task.claimed", "task.claimed");
    await first.poller.poll();
    expect(first.delivered).toHaveLength(3);

    await fsp.rm(workspace.paths.cursorFile(consumerId));

    // Fresh poller (fresh dedupe window) replays everything from offset 0...
    const replay = makePoller(consumerId, cursors);
    const inbox = createInbox();
    const wake = new FakeWakePort();
    const scheduler = createWakeScheduler({ wake, logger: captureLogger().logger });
    const poller = createEventPoller({
      identity: replay.identity,
      manifest: makeManifest(),
      eventStore: store,
      cursorStore: cursors,
      onMatch: (events) => inbox.enqueueEvents(events),
      now: tickClock(),
      logger: captureLogger().logger,
    });

    const matched = await poller.poll();
    const message = inbox.peek();
    if (message !== null) {
      await scheduler.deliver(message, message.kind, message.kind === "actionable");
    }

    expect(matched).toHaveLength(3);
    expect(wake.deliveries).toHaveLength(1);
    expect(wake.deliveries[0]!.message.body).toContain("Events:");
    expect(wake.deliveries[0]!.message.body.split("\n")).toHaveLength(2);

    // ...and the same poller dedupes any further rewind.
    await fsp.rm(workspace.paths.cursorFile(consumerId));
    expect(await poller.poll()).toEqual([]);
  });

  it("a burst of 30 events in one poll yields exactly one consolidated wake", async () => {
    const types = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? "task.claimed" : "task.completed",
    );
    await appendEvents(...types);

    const inbox = createInbox();
    const wake = new FakeWakePort();
    const scheduler = createWakeScheduler({ wake, logger: captureLogger().logger });
    const poller = createEventPoller({
      identity: makeIdentity(),
      manifest: makeManifest(),
      eventStore: store,
      cursorStore: new FsCursorStore(workspace.paths),
      onMatch: (events) => inbox.enqueueEvents(events),
      now: tickClock(),
      logger: captureLogger().logger,
    });

    const matched = await poller.poll();
    const message = inbox.peek();
    expect(message).not.toBeNull();
    await scheduler.deliver(message!, message!.kind, message!.kind === "actionable");

    expect(matched).toHaveLength(30);
    expect(wake.deliveries).toHaveLength(1);
    expect(wake.deliveries[0]!.message.title).toBe("SWARM INBOX — 30 events");
    expect(wake.deliveries[0]!.message.body).toContain("15 task.claimed (broadcast tasks)");
    expect(wake.deliveries[0]!.message.body).toContain("15 task.completed (broadcast tasks)");
    expect(wake.deliveries[0]!.message.body.split("\n")).toHaveLength(3);
  });
});

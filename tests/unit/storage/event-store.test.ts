/**
 * EventStore unit tests — byte-offset semantics (acceptance #2 and #3).
 */
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEventStore } from "../../../src/storage/event-store.js";
import { serializeEvent } from "../../../src/protocol/events.js";
import { MAX_EVENT_BYTES } from "../../../src/protocol/schemas.js";
import { instanceId, makeEvent, newWorkspace } from "./fixtures.js";

const PRODUCER = instanceId("backend", "b");
const OTHER = instanceId("frontend", "f");

async function appendRaw(paths: Awaited<ReturnType<typeof newWorkspace>>["paths"], producer: string, text: string) {
  await fsp.appendFile(paths.eventStreamFile(producer), text, "utf8");
}

describe("EventStore append/read byte math", () => {
  it("delivers appended events exactly once with exact byte offsets", async () => {
    const ws = await newWorkspace("pi-swarm-storage-ev");
    const store = createEventStore(ws.paths, { instanceId: PRODUCER });
    const events = [makeEvent(1, { role: "backend", instanceId: PRODUCER }), makeEvent(2, { role: "backend", instanceId: PRODUCER }), makeEvent(3, { role: "backend", instanceId: PRODUCER })];
    for (const event of events) await store.append(event);

    const first = await store.readFrom(PRODUCER, 0);
    expect(first.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(first.trailingIncomplete).toBe(false);
    expect(first.malformed).toEqual([]);
    const expectedOffset = events.reduce((sum, e) => sum + Buffer.byteLength(serializeEvent(e)) + 1, 0);
    expect(first.offset).toBe(expectedOffset);
    expect(await store.streamSize(PRODUCER)).toBe(expectedOffset);

    const second = await store.readFrom(PRODUCER, expectedOffset);
    expect(second.events).toEqual([]);
    expect(second.malformed).toEqual([]);
    expect(second.trailingIncomplete).toBe(false);
    expect(second.offset).toBe(expectedOffset);
  });

  it("holds back a torn trailing line and delivers it once completed", async () => {
    const ws = await newWorkspace("pi-swarm-storage-ev2");
    const store = createEventStore(ws.paths, { instanceId: PRODUCER });
    const first = makeEvent(1, { role: "backend", instanceId: PRODUCER });
    await store.append(first);
    const base = (await store.readFrom(PRODUCER, 0)).offset;

    // Simulate a crash mid-append: first half of event 2's line, no newline.
    const second = makeEvent(2, { role: "backend", instanceId: PRODUCER });
    const line = serializeEvent(second);
    const half = Math.floor(line.length / 2);
    await appendRaw(ws.paths, PRODUCER, line.slice(0, half));

    const torn = await store.readFrom(PRODUCER, base);
    expect(torn.events).toEqual([]);
    expect(torn.malformed).toEqual([]);
    expect(torn.trailingIncomplete).toBe(true);
    expect(torn.offset).toBe(base); // torn bytes are NOT consumed

    // The remainder lands later; the event is delivered exactly once.
    await appendRaw(ws.paths, PRODUCER, `${line.slice(half)}\n`);
    const completed = await store.readFrom(PRODUCER, base);
    expect(completed.trailingIncomplete).toBe(false);
    expect(completed.malformed).toEqual([]);
    expect(completed.events.map((e) => e.id)).toEqual([second.id]);
    expect(completed.offset).toBe(base + Buffer.byteLength(line) + 1);

    const after = await store.readFrom(PRODUCER, completed.offset);
    expect(after.events).toEqual([]);
  });

  it("advances past malformed complete lines without wedging the cursor", async () => {
    const ws = await newWorkspace("pi-swarm-storage-ev3");
    const store = createEventStore(ws.paths, { instanceId: PRODUCER });
    const good = makeEvent(1, { role: "backend", instanceId: PRODUCER });
    await store.append(good);
    const base = (await store.readFrom(PRODUCER, 0)).offset;

    const next = makeEvent(2, { role: "backend", instanceId: PRODUCER });
    const valid = makeEvent(3, { role: "backend", instanceId: PRODUCER });
    const schemaInvalid = JSON.stringify({ version: 1, id: "not-a-ulid", time: "nope", type: "x", from: {}, route: {} });
    await appendRaw(ws.paths, PRODUCER, `garbage\n${schemaInvalid}\n${serializeEvent(next)}\n${serializeEvent(valid)}\n`);

    const result = await store.readFrom(PRODUCER, base);
    expect(result.events.map((e) => e.id)).toEqual([next.id, valid.id]);
    expect(result.trailingIncomplete).toBe(false);
    expect(result.malformed).toEqual([
      { line: 1, error: expect.stringContaining("JSON") },
      { line: 2, error: expect.stringContaining("id") },
    ]);
    // Offset advanced past every complete line, malformed included.
    expect(result.offset).toBe(
      base +
        Buffer.byteLength("garbage\n") +
        Buffer.byteLength(`${schemaInvalid}\n`) +
        Buffer.byteLength(`${serializeEvent(next)}\n`) +
        Buffer.byteLength(`${serializeEvent(valid)}\n`),
    );
    // And the cursor never wedges: the next read is empty.
    expect((await store.readFrom(PRODUCER, result.offset)).events).toEqual([]);
  });

  it("reads a missing stream as an empty result", async () => {
    const ws = await newWorkspace("pi-swarm-storage-ev4");
    const store = createEventStore(ws.paths, { instanceId: PRODUCER });
    const result = await store.readFrom(OTHER, 0);
    expect(result).toEqual({ events: [], offset: 0, trailingIncomplete: false, malformed: [] });
    expect(await store.streamSize(OTHER)).toBe(0);
  });
});

describe("EventStore ownership and discovery", () => {
  it("rejects events from a foreign instanceId", async () => {
    const ws = await newWorkspace("pi-swarm-storage-ev5");
    const store = createEventStore(ws.paths, { instanceId: PRODUCER });
    const foreign = makeEvent(1, { role: "frontend", instanceId: OTHER });
    await expect(store.append(foreign)).rejects.toThrow(/not owned by this stream/);
    expect(await store.listStreams()).toEqual([]);
  });

  it("rejects an invalid owning instanceId at creation", async () => {
    const { paths } = await newWorkspace("pi-swarm-storage-ev8");
    expect(() => createEventStore(paths, { instanceId: "not-an-instance-id" })).toThrow(
      /invalid owning instanceId/,
    );
  });

  it("enforces the serialized size cap", async () => {
    const ws = await newWorkspace("pi-swarm-storage-ev6");
    const store = createEventStore(ws.paths, { instanceId: PRODUCER });
    const huge = makeEvent(1, { role: "backend", instanceId: PRODUCER });
    huge.data = { blob: "x".repeat(MAX_EVENT_BYTES) };
    await expect(store.append(huge)).rejects.toThrow(/MAX_EVENT_BYTES/);
  });

  it("lists only valid instance stream files", async () => {
    const ws = await newWorkspace("pi-swarm-storage-ev7");
    const store = createEventStore(ws.paths, { instanceId: PRODUCER });
    await store.append(makeEvent(1, { role: "backend", instanceId: PRODUCER }));
    await appendRaw(ws.paths, "not-an-instance-id", "junk\n"); // invalid instance id name
    await appendRaw(ws.paths, OTHER, `${serializeEvent(makeEvent(2, { role: "frontend", instanceId: OTHER }))}\n`);
    await fsp.writeFile(`${ws.paths.eventsDir}/notes.txt`, "junk", "utf8");

    expect(await store.listStreams()).toEqual([PRODUCER, OTHER].sort());
  });

});

/**
 * Acceptance 8: createEventService emits a validated event through the event
 * store and throws clear errors on validation and size-cap failures.
 */
import { describe, expect, it, vi } from "vitest";
import { createEventService } from "../../../src/domain/event-service.js";
import type { EventStore } from "../../../src/storage/types.js";
import type { SwarmEvent } from "../../../src/protocol/schemas.js";
import { makeIdentity } from "../extension/fakes.js";

function fakeEventStore(): EventStore & { appended: SwarmEvent[] } {
  const appended: SwarmEvent[] = [];
  return {
    appended,
    append: vi.fn(async (event: SwarmEvent) => {
      appended.push(event);
    }),
    readFrom: vi.fn(async () => ({ events: [], offset: 0, trailingIncomplete: false, malformed: [] })),
    listStreams: vi.fn(async () => []),
    streamSize: vi.fn(async () => 0),
  };
}

describe("createEventService", () => {
  it("emits a validated event through the store and returns it", async () => {
    const store = fakeEventStore();
    const service = createEventService({ eventStore: store });
    const identity = makeIdentity("backend");

    const event = await service.emit(
      {
        type: "task.claimed",
        route: { mode: "direct", role: "tester" },
        context: { taskId: "TASK-0001" },
        data: { note: "mine" },
      },
      identity,
    );

    expect(event.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(event.time).toMatch(/Z$/);
    expect(event.type).toBe("task.claimed");
    expect(event.from).toEqual({ role: "backend", instanceId: identity.instanceId });
    expect(event.route).toEqual({ mode: "direct", role: "tester" });
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]).toEqual(event);
  });

  it("throws a clear error for schema-invalid events (bad route)", async () => {
    const store = fakeEventStore();
    const service = createEventService({ eventStore: store });
    await expect(
      service.emit(
        { type: "task.claimed", route: { mode: "direct", role: "NOT A ROLE" } },
        makeIdentity("backend"),
      ),
    ).rejects.toThrow(/invalid event/);
    expect(store.appended).toHaveLength(0);
  });

  it("throws a clear error for schema-invalid event types", async () => {
    const service = createEventService({ eventStore: fakeEventStore() });
    await expect(
      service.emit({ type: "NotDotted", route: { mode: "broadcast", topic: "tasks" } }, makeIdentity("backend")),
    ).rejects.toThrow(/invalid event/);
  });

  it("throws when serialized data exceeds MAX_EVENT_BYTES", async () => {
    const store = fakeEventStore();
    const service = createEventService({ eventStore: store });
    await expect(
      service.emit(
        {
          type: "blackboard.updated",
          route: { mode: "broadcast", topic: "tasks" },
          data: { blob: "x".repeat(200 * 1024) },
        },
        makeIdentity("backend"),
      ),
    ).rejects.toThrow(/MAX_EVENT_BYTES/);
    expect(store.appended).toHaveLength(0);
  });
});

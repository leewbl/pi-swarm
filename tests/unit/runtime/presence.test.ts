import { describe, expect, it } from "vitest";
import { createPresenceManager } from "../../../src/runtime/presence.js";
import { MemoryPresenceStore, makeIdentity, tickClock } from "./fakes.js";

describe("createPresenceManager", () => {
  it("start() upserts an idle record with startedAt == heartbeatAt", async () => {
    const store = new MemoryPresenceStore();
    const identity = makeIdentity();
    const now = tickClock();
    const manager = createPresenceManager({ identity, presenceStore: store, now });

    await manager.start();

    const record = store.records.get(identity.instanceId);
    expect(record).toBeDefined();
    expect(record!.state).toBe("idle");
    expect(record!.startedAt).toBe(record!.heartbeatAt);
    expect(record!.pid).toBe(identity.pid);
    expect(record!.sessionId).toBe(identity.sessionId);
  });

  it("beat() advances heartbeatAt without changing state", async () => {
    const store = new MemoryPresenceStore();
    const now = tickClock();
    const manager = createPresenceManager({
      identity: makeIdentity(),
      presenceStore: store,
      now,
    });
    await manager.start();
    const startedHeartbeat = store.records.values().next().value!.heartbeatAt;

    await manager.beat();

    const record = store.records.values().next().value!;
    expect(record.heartbeatAt > startedHeartbeat).toBe(true);
    expect(record.state).toBe("idle");
    expect(record.startedAt).toBe(startedHeartbeat);
  });

  it("beat(state) transitions state alongside the heartbeat", async () => {
    const store = new MemoryPresenceStore();
    const manager = createPresenceManager({
      identity: makeIdentity(),
      presenceStore: store,
      now: tickClock(),
    });
    await manager.start();

    await manager.beat("busy");
    expect(store.records.values().next().value!.state).toBe("busy");

    await manager.beat();
    expect(store.records.values().next().value!.state).toBe("busy");
  });

  it("setBusy()/setIdle() flip the persisted state", async () => {
    const store = new MemoryPresenceStore();
    const manager = createPresenceManager({
      identity: makeIdentity(),
      presenceStore: store,
      now: tickClock(),
    });
    await manager.start();

    await manager.setBusy();
    expect(store.records.values().next().value!.state).toBe("busy");

    await manager.setIdle();
    expect(store.records.values().next().value!.state).toBe("idle");
  });

  it("stop(at) marks the record stopped and later beats are ignored", async () => {
    const store = new MemoryPresenceStore();
    const now = tickClock();
    const identity = makeIdentity();
    const manager = createPresenceManager({ identity, presenceStore: store, now });
    await manager.start();
    const before = store.records.get(identity.instanceId)!;

    await manager.stop("2026-09-11T10:00:00Z");
    const stopped = store.records.get(identity.instanceId)!;
    expect(stopped.state).toBe("stopped");
    expect(stopped.heartbeatAt).toBe("2026-09-11T10:00:00Z");
    expect(stopped.startedAt).toBe(before.startedAt);

    await manager.beat();
    expect(store.records.get(identity.instanceId)).toEqual(stopped);
  });
});

/**
 * OMP lifecycle / presence regressions (structural liveness fix §20/§33):
 * heartbeats follow the HOST idle truth (wake port), agent_end carries no
 * authoritative idle transition, and a failed wake delivery keeps the batch
 * queued for the next flush.
 */
import { describe, expect, it } from "vitest";
import { SwarmRuntime } from "../../../src/runtime/runtime.js";
import { DEFAULT_SWARM_CONFIG } from "../../../src/protocol/schemas.js";
import {
  FakeTaskService,
  FakeWakePort,
  MemoryCursorStore,
  MemoryEventStore,
  MemoryPresenceStore,
  makeIdentity,
  makeManifest,
} from "./fakes.js";
import { fixedClock } from "../domain/fakes.js";

function setup(idle: boolean) {
  const identity = makeIdentity("backend");
  const wake = new FakeWakePort();
  wake.idle = idle;
  const presenceStore = new MemoryPresenceStore();
  const clock = fixedClock("2026-09-24T17:00:00Z");
  const taskService = new FakeTaskService(clock.now);
  const runtime = new SwarmRuntime({
    identity,
    manifest: makeManifest(),
    config: DEFAULT_SWARM_CONFIG,
    taskService,
    eventStore: new MemoryEventStore(identity.instanceId),
    cursorStore: new MemoryCursorStore(),
    presenceStore,
    wake,
    now: clock.now,
  });
  return { runtime, wake, presenceStore, clock, identity, taskService };
}

describe("presence sync (fix §20)", () => {
  it("heartbeats write busy while the host reports the agent busy", async () => {
    const { runtime, presenceStore, identity } = setup(false);
    await runtime.start();
    await runtime.syncPresence();
    const record = presenceStore.records.get(identity.instanceId);
    expect(record?.state).toBe("busy");
    await runtime.stop();
  });

  it("heartbeats write idle when the host reports idle (agent_end is not consulted)", async () => {
    const { runtime, presenceStore, identity } = setup(true);
    await runtime.start();
    // markBusy is an agent_start fast hint; the next host-sync overrules it.
    await runtime.markBusy();
    await runtime.syncPresence();
    const record = presenceStore.records.get(identity.instanceId);
    expect(record?.state).toBe("idle");
    await runtime.stop();
  });

  it("a failed wake delivery keeps the batch queued and is retried by the next flush", async () => {
    const { runtime, wake, taskService } = setup(true);
    await taskService.addTask({ title: "Work" });
    await runtime.start();
    let fail = true;
    const originalDeliver = wake.deliver.bind(wake);
    wake.deliver = async (message, delivery) => {
      if (fail) throw new Error("sendMessage exploded");
      return originalDeliver(message, delivery);
    };
    // An actionable task surfaces but delivery fails: the poll rejects and
    // the batch survives.
    await expect(runtime.scanTasksOnce()).rejects.toThrow("sendMessage exploded");
    expect(runtime.status().pendingWake).toBeGreaterThan(0);

    // Delivery recovers: the SAME batch is delivered on the next flush.
    fail = false;
    await runtime.scanTasksOnce();
    expect(wake.deliveries.length).toBeGreaterThan(0);
    expect(wake.deliveries[0].message.kind).toBe("actionable");
    await runtime.stop();
  });
});

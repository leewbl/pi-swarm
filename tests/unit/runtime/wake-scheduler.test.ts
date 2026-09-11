import { describe, expect, it } from "vitest";
import { createWakeScheduler, decideDelivery } from "../../../src/runtime/wake-scheduler.js";
import type { SwarmInboxMessage, WakeKind } from "../../../src/runtime/ports.js";
import { FakeWakePort, captureLogger } from "./fakes.js";

describe("decideDelivery (architecture §16 mapping)", () => {
  const cases: { kind: WakeKind; actionable: boolean; isIdle: boolean; expected: string[] }[] = [
    { kind: "actionable", actionable: true, isIdle: true, expected: ["aside", "triggerTurn"] },
    { kind: "actionable", actionable: false, isIdle: true, expected: ["aside", "triggerTurn"] },
    { kind: "informational", actionable: false, isIdle: true, expected: ["followUp"] },
    { kind: "informational", actionable: false, isIdle: false, expected: ["aside"] },
    { kind: "actionable", actionable: true, isIdle: false, expected: ["followUp"] },
    { kind: "warning", actionable: false, isIdle: true, expected: ["followUp"] },
    { kind: "warning", actionable: false, isIdle: false, expected: ["followUp"] },
  ];

  it.each(cases)(
    "kind=$kind actionable=$actionable idle=$isIdle -> $expected",
    ({ kind, actionable, isIdle, expected }) => {
      const delivery = decideDelivery(kind, actionable, isIdle);
      expect(delivery.deliverAs).toBe(expected[0]);
      if (expected[1] === "triggerTurn") {
        expect(delivery).toEqual({ deliverAs: "aside", triggerTurn: true });
      } else {
        expect("triggerTurn" in delivery).toBe(false);
      }
    },
  );

  it("never steers", () => {
    for (const kind of ["actionable", "informational", "warning"] as WakeKind[]) {
      for (const isIdle of [true, false]) {
        expect(decideDelivery(kind, true, isIdle).deliverAs).not.toBe("steer");
      }
    }
  });
});

describe("createWakeScheduler", () => {
  const message: SwarmInboxMessage = {
    kind: "actionable",
    title: "SWARM INBOX — 1 task",
    body: "Actionable tasks:\nTASK-0001 [P50] T — tasks/TASK-0001.md",
  };

  it("delivers idle+actionable as an aside with a triggered turn", async () => {
    const wake = new FakeWakePort();
    const scheduler = createWakeScheduler({ wake, logger: captureLogger().logger });

    await scheduler.deliver(message, "actionable", true);

    expect(wake.deliveries).toHaveLength(1);
    expect(wake.deliveries[0]!.delivery).toEqual({ deliverAs: "aside", triggerTurn: true });
    expect(wake.deliveries[0]!.message).toBe(message);
  });

  it("delivers active+informational as a plain aside", async () => {
    const wake = new FakeWakePort();
    wake.idle = false;
    const scheduler = createWakeScheduler({ wake, logger: captureLogger().logger });
    const informational: SwarmInboxMessage = { ...message, kind: "informational" };

    await scheduler.deliver(informational, "informational", false);

    expect(wake.deliveries[0]!.delivery).toEqual({ deliverAs: "aside" });
  });

  it("delivers active+actionable as a follow-up", async () => {
    const wake = new FakeWakePort();
    wake.idle = false;
    const scheduler = createWakeScheduler({ wake, logger: captureLogger().logger });

    await scheduler.deliver(message, "actionable", true);

    expect(wake.deliveries[0]!.delivery).toEqual({ deliverAs: "followUp" });
  });

  it("reads the idle state at delivery time, not construction time", async () => {
    const wake = new FakeWakePort();
    const scheduler = createWakeScheduler({ wake, logger: captureLogger().logger });

    wake.idle = false;
    await scheduler.deliver(message, "actionable", true);
    expect(wake.deliveries[0]!.delivery).toEqual({ deliverAs: "followUp" });

    wake.idle = true;
    await scheduler.deliver(message, "actionable", true);
    expect(wake.deliveries[1]!.delivery).toEqual({ deliverAs: "aside", triggerTurn: true });
  });
});

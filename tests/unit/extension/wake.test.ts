/**
 * Acceptance 7: the OMP wake adapter maps WakeDelivery policies onto
 * sendMessage options and reflects ctx.isIdle().
 */
import { describe, expect, it } from "vitest";
import { createOmpWakePort, createCtxRef, ctxTimerPort } from "../../../src/extension/pi-api.js";
import { FakeCtx, FakePi } from "./fakes.js";

const message = { kind: "actionable" as const, title: "SWARM INBOX", body: "2 actionable tasks" };

describe("createOmpWakePort", () => {
  it("maps idle+actionable to {deliverAs:'aside', triggerTurn:true} and an inbox payload", () => {
    const pi = new FakePi();
    const ctx = new FakeCtx("/tmp/ws", true);
    const port = createOmpWakePort(pi, () => ctx);

    port.deliver(message, { deliverAs: "aside", triggerTurn: true });

    expect(pi.sentMessages).toHaveLength(1);
    const { payload, opts } = pi.sentMessages[0]!;
    expect(payload.customType).toBe("pi-swarm.inbox");
    expect(payload.content).toBe("2 actionable tasks");
    expect(payload.display).toBe("info");
    expect(payload.details).toEqual({ kind: "actionable", title: "SWARM INBOX" });
    expect(opts).toEqual({ deliverAs: "aside", triggerTurn: true });
  });

  it("maps followUp delivery to {deliverAs:'followUp'} with no triggerTurn key", () => {
    const pi = new FakePi();
    const port = createOmpWakePort(pi, () => new FakeCtx("/tmp/ws", false));

    port.deliver({ ...message, kind: "warning" }, { deliverAs: "followUp" });

    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0]!.opts).toEqual({ deliverAs: "followUp" });
    expect("triggerTurn" in (pi.sentMessages[0]!.opts ?? {})).toBe(false);
  });

  it("maps active+informational to plain aside without triggerTurn", () => {
    const pi = new FakePi();
    const port = createOmpWakePort(pi, () => new FakeCtx("/tmp/ws", false));
    port.deliver({ ...message, kind: "informational" }, { deliverAs: "aside" });
    expect(pi.sentMessages[0]!.opts).toEqual({ deliverAs: "aside" });
    expect("triggerTurn" in (pi.sentMessages[0]!.opts ?? {})).toBe(false);
  });

  it("isIdle reflects the context; defaults to idle when no context yet", () => {
    const pi = new FakePi();
    const port = createOmpWakePort(pi, () => new FakeCtx("/tmp/ws", false));
    expect(port.isIdle()).toBe(false);

    const portIdle = createOmpWakePort(pi, () => new FakeCtx("/tmp/ws", true));
    expect(portIdle.isIdle()).toBe(true);

    const portNoCtx = createOmpWakePort(pi, () => null);
    expect(portNoCtx.isIdle()).toBe(true);
  });
});

describe("pi-api adapters", () => {
  it("ctxRef stores and replaces the session context", () => {
    const ref = createCtxRef();
    expect(ref.get()).toBeNull();
    const ctx = new FakeCtx("/a");
    ref.set(ctx);
    expect(ref.get()).toBe(ctx);
    ref.set(null);
    expect(ref.get()).toBeNull();
  });

  it("ctxTimerPort uses managed ctx timers and clears through ctx", () => {
    const ctx = new FakeCtx("/tmp/ws");
    const timers = ctxTimerPort(ctx);
    const fn = () => undefined;
    timers.setInterval(fn, 500);
    expect(ctx.timers).toEqual([{ fn, ms: 500 }]);
    expect(() => timers.clearInterval(ctx.timers.length - 1)).not.toThrow();
  });
});

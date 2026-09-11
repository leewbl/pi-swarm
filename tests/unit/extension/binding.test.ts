/**
 * Session binding marker: rebuildBindingFromSession finds the latest bound
 * role from session history; persistBinding writes the canonical marker; the
 * in-memory registry swaps roles and stops the previous runtime.
 */
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  BINDING_CUSTOM_TYPE,
  clearActiveBindings,
  defaultIsProcessAlive,
  getActiveBinding,
  newIdentityLocally,
  persistBinding,
  rebuildBindingFromSession,
  setActiveBinding,
} from "../../../src/extension/binding.js";
import { makeFakeRuntime, makeIdentity, makeManifest, makeFakeStack, FakeCtx, FakePi } from "./fakes.js";

describe("rebuildBindingFromSession", () => {
  it("returns the latest binding role from custom entries", () => {
    const ctx = new FakeCtx("/ws");
    ctx.branch.push(
      { type: "custom", customType: "pi-swarm.other", data: { role: "nope" } },
      { type: "custom", customType: BINDING_CUSTOM_TYPE, data: { role: "backend" } },
      { type: "custom", customType: BINDING_CUSTOM_TYPE, data: { role: "tester" } },
      { type: "custom", customType: "pi-swarm.inbox", data: {} },
    );
    expect(rebuildBindingFromSession(ctx)).toBe("tester");
  });

  it("returns null with no session manager or no marker", () => {
    const bare: { cwd: string; ui: { notify(): void } } = { cwd: "/ws", ui: { notify: () => undefined } };
    expect(rebuildBindingFromSession(bare)).toBeNull();
    const ctx = new FakeCtx("/ws");
    ctx.branch.push({ type: "custom", customType: "pi-swarm.inbox", data: {} });
    expect(rebuildBindingFromSession(ctx)).toBeNull();
  });

  it("accepts (type, data) hosts that store the marker in type", () => {
    const ctx = new FakeCtx("/ws");
    ctx.branch.push({ type: BINDING_CUSTOM_TYPE, data: { role: "researcher" } });
    expect(rebuildBindingFromSession(ctx)).toBe("researcher");
  });
});

describe("binding persistence and registry", () => {
  it("persistBinding appends the canonical custom entry", () => {
    const pi = new FakePi();
    persistBinding(pi, "backend");
    expect(pi.entries).toEqual([
      { type: "custom", customType: BINDING_CUSTOM_TYPE, data: { role: "backend" } },
    ]);
  });

  it("replaces the active role and stops the previous runtime", async () => {
    clearActiveBindings();
    const first = makeFakeRuntime("backend-01aaaaaaaaaaaaaaaaaaaaaaaa");
    const second = makeFakeRuntime("tester-01dddddddddddddddddddddddd");
    setActiveBinding({
      role: "backend",
      identity: makeIdentity("backend"),
      manifest: makeManifest("backend"),
      stack: makeFakeStack(),
      runtime: first,
    });
    expect(getActiveBinding()?.role).toBe("backend");

    setActiveBinding({
      role: "tester",
      identity: { ...makeIdentity("tester"), instanceId: "tester-01dddddddddddddddddddddddd" },
      manifest: makeManifest("tester"),
      stack: makeFakeStack(),
      runtime: second,
    });
    expect(getActiveBinding()?.role).toBe("tester");
    // stop() is async-fire-and-forget; let the microtask queue drain.
    await Promise.resolve();
    expect(first.stopped).toBe(1);
    expect(second.stopped).toBe(0);
    clearActiveBindings();
    expect(getActiveBinding()).toBeNull();
  });
});

describe("identity and liveness helpers", () => {
  it("newIdentityLocally produces a schema-valid instance id for the role", () => {
    const identity = newIdentityLocally("backend", 4242);
    expect(identity.role).toBe("backend");
    expect(identity.pid).toBe(4242);
    expect(identity.instanceId).toMatch(/^backend-[0-9a-z]{26}$/);
  });

  it("defaultIsProcessAlive reports own pid alive and a reaped child pid dead", () => {
    expect(defaultIsProcessAlive(process.pid)).toBe(true);
    const child = spawnSync(process.execPath, ["-e", ""]);
    expect(child.pid !== undefined && child.pid > 0).toBe(true);
    // The child exited synchronously and was reaped, so the pid is not alive.
    expect(defaultIsProcessAlive(child.pid as number)).toBe(false);
  });
});

describe("getActiveBinding stop callback isolation", () => {
  it("a throwing stop() does not reject (caught internally)", async () => {
    clearActiveBindings();
    const bad = { ...makeFakeRuntime(), stop: vi.fn(async () => Promise.reject(new Error("boom"))) };
    setActiveBinding({
      role: "backend",
      identity: makeIdentity("backend"),
      manifest: makeManifest("backend"),
      stack: makeFakeStack(),
      runtime: bad,
    });
    setActiveBinding({
      role: "tester",
      identity: makeIdentity("tester"),
      manifest: makeManifest("tester"),
      stack: makeFakeStack(),
      runtime: makeFakeRuntime(),
    });
    await Promise.resolve();
    expect(getActiveBinding()?.role).toBe("tester");
    clearActiveBindings();
  });
});

/**
 * Acceptance 3: /swarm role rejects unknown roles, blocks duplicate live
 * instances of a role (fresh heartbeat + alive pid), and on success persists
 * the binding marker, upserts presence, and starts the runtime built from the
 * per-instance stack.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpWorkspaceDir } from "../../../src/util/atomic-file.js";
import { SwarmPaths } from "../../../src/util/paths.js";
import { registerSwarmCommands, bindRole } from "../../../src/extension/commands.js";
import { clearActiveBindings, getActiveBinding } from "../../../src/extension/binding.js";
import type { SwarmCommandDeps } from "../../../src/extension/commands.js";
import {
  FakeCtx,
  FakePi,
  makeAgentManifestDoc,
  makeFakeRuntime,
  makeFakeStack,
  makeIdentity,
  makePresence,
} from "./fakes.js";

const NOW = "2026-09-11T12:00:00Z";

let ws: string;
let paths: SwarmPaths;
let pi: FakePi;
let ctx: FakeCtx;

beforeEach(async () => {
  clearActiveBindings();
  ws = await tmpWorkspaceDir("pi-swarm-role");
  paths = new SwarmPaths(ws);
  await paths.ensureLayout();
  pi = new FakePi();
  ctx = new FakeCtx(ws);
});

afterEach(async () => {
  clearActiveBindings();
  await fsp.rm(ws, { recursive: true, force: true });
});

function deps(overrides: Partial<SwarmCommandDeps> = {}): SwarmCommandDeps {
  return {
    buildStack: vi.fn(async () =>
      makeFakeStack({ paths, manifests: [makeAgentManifestDoc("backend")] }),
    ),
    createRuntime: vi.fn(() => makeFakeRuntime()),
    newIdentity: () => makeIdentity("backend"),
    now: () => NOW,
    isProcessAlive: () => false,
    ...overrides,
  };
}

async function runRole(): Promise<string> {
  await pi.commands.get("swarm")!.handler(["role", "backend"], ctx);
  return ctx.notifications.at(-1)!.message;
}

describe("/swarm role <role>", () => {
  it("rejects an unknown role with the available roles listed", async () => {
    registerSwarmCommands(pi, deps());
    await pi.commands.get("swarm")!.handler(["role", "ghost"], ctx);
    const message = ctx.notifications[0]!.message;
    expect(ctx.notifications[0]!.level).toBe("error");
    expect(message).toContain('Unknown role "ghost"');
    expect(message).toContain("backend");
    expect(getActiveBinding()).toBeNull();
  });

  it("requires a workspace when none exists", async () => {
    const emptyWs = await tmpWorkspaceDir("pi-swarm-role-empty");
    try {
      const emptyPi = new FakePi();
      const emptyCtx = new FakeCtx(emptyWs);
      registerSwarmCommands(emptyPi, deps());
      await emptyPi.commands.get("swarm")!.handler(["role", "backend"], emptyCtx);
      expect(emptyCtx.notifications[0]!.message).toContain("Run /swarm init first");
    } finally {
      await fsp.rm(emptyWs, { recursive: true, force: true });
    }
  });

  it("blocks a duplicate live instance of the same role", async () => {
    const stack = makeFakeStack({
      paths,
      manifests: [makeAgentManifestDoc("backend")],
      presence: [makePresence({ pid: 99999, state: "busy", heartbeatAt: "2026-09-11T11:59:55Z" })],
    });
    const commandDeps = deps({
      buildStack: vi.fn(async () => stack),
      isProcessAlive: () => true,
    });
    registerSwarmCommands(pi, commandDeps);
    const message = await runRole();

    expect(ctx.notifications[0]!.level).toBe("error");
    expect(message).toContain("already has an active instance");
    expect(message).toContain("pid 99999");
    expect(getActiveBinding()).toBeNull();
    expect(pi.entries).toHaveLength(0);
  });

  it("allows binding when the duplicate heartbeat is stale or the pid is dead", async () => {
    const cases = [
      makePresence({ pid: 99999, heartbeatAt: "2026-09-11T11:00:00Z" }), // stale
      makePresence({ pid: 99999, heartbeatAt: "2026-09-11T11:59:55Z", state: "stopped" }),
    ];
    for (const presence of cases) {
      clearActiveBindings();
      const stack = makeFakeStack({
        paths,
        manifests: [makeAgentManifestDoc("backend")],
        presence: [presence],
      });
      const commandDeps = deps({
        buildStack: vi.fn(async () => stack),
        isProcessAlive: () => true,
      });
      const localPi = new FakePi();
      const localCtx = new FakeCtx(ws);
      registerSwarmCommands(localPi, commandDeps);
      await localPi.commands.get("swarm")!.handler(["role", "backend"], localCtx);
      expect(localCtx.notifications[0]!.message).toContain("Bound to role backend");
    }
  });

  it("binds successfully: presence upsert, runtime start, binding marker, per-instance stack", async () => {
    const runtime = makeFakeRuntime();
    const buildStack = vi.fn(async (_root: string, _opts?: { instanceId?: string }) =>
      makeFakeStack({ paths, manifests: [makeAgentManifestDoc("backend")] }),
    );
    const commandDeps = deps({
      buildStack,
      createRuntime: vi.fn(() => runtime),
    });
    registerSwarmCommands(pi, commandDeps);
    const message = await runRole();

    expect(ctx.notifications[0]!.level).toBe("info");
    expect(message).toContain("Bound to role backend as backend-01aaaaaaaaaaaaaaaaaaaaaaaa");

    // Runtime started once, from the per-instance stack (second buildStack call).
    expect(runtime.started).toBe(1);
    expect(buildStack).toHaveBeenCalledTimes(2);
    expect(buildStack.mock.calls[1]![1]).toEqual({ instanceId: "backend-01aaaaaaaaaaaaaaaaaaaaaaaa" });
    const runtimeArgs = (commandDeps.createRuntime as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(runtimeArgs.identity.role).toBe("backend");
    expect(runtimeArgs.manifest.role).toBe("backend");
    expect(runtimeArgs.timers).toBeDefined();
    expect(runtimeArgs.wake).toBeDefined();

    // Presence upserted with the new idle instance (first stack call).
    const firstStack = await buildStack.mock.results[0]!.value;
    const upsert = firstStack.stores.presence.upsert as ReturnType<typeof vi.fn>;
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]![0]).toMatchObject({
      role: "backend",
      instanceId: "backend-01aaaaaaaaaaaaaaaaaaaaaaaa",
      state: "idle",
      heartbeatAt: NOW,
      startedAt: NOW,
    });

    // Durable binding marker appended to session history.
    expect(pi.entries).toEqual([
      { type: "custom", customType: "pi-swarm.binding.v1", data: { role: "backend" } },
    ]);

    // Registry now serves the session stack + runtime.
    const binding = getActiveBinding();
    expect(binding?.role).toBe("backend");
    expect(binding?.runtime).toBe(runtime);
    expect(binding?.identity.instanceId).toBe("backend-01aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("re-binding the same role in the same session replaces the instance (own pid is exempt)", async () => {
    const stack = makeFakeStack({
      paths,
      manifests: [makeAgentManifestDoc("backend")],
      presence: [makePresence({ pid: process.pid, instanceId: "backend-01eeeeeeeeeeeeeeeeeeeeeeee" })],
    });
    const commandDeps = deps({
      buildStack: vi.fn(async () => stack),
      isProcessAlive: () => true,
    });
    registerSwarmCommands(pi, commandDeps);
    const message = await runRole();
    expect(message).toContain("Bound to role backend");
  });

  it("reports command failures without throwing", async () => {
    registerSwarmCommands(
      pi,
      deps({ buildStack: vi.fn(async () => { throw new Error("disk on fire"); }) }),
    );
    await expect(pi.commands.get("swarm")!.handler(["role", "backend"], ctx)).resolves.toBeUndefined();
    expect(ctx.notifications[0]!.message).toContain("disk on fire");
    expect(ctx.notifications[0]!.level).toBe("error");
  });
});

describe("bindRole (used by session_start re-bind)", () => {
  it("returns a structured result instead of notifying", async () => {
    const commandDeps = deps();
    const result = await bindRole(pi, ctx, "backend", commandDeps);
    expect(result.ok).toBe(true);
    expect(result.instanceId).toBe("backend-01aaaaaaaaaaaaaaaaaaaaaaaa");
    // Usage and no-workspace results.
    const usage = await bindRole(pi, ctx, "", deps());
    expect(usage.ok).toBe(false);
    expect(usage.message).toContain("Usage");
    const outside = await tmpWorkspaceDir("pi-swarm-role-outside");
    try {
      const missing = await bindRole(pi, new FakeCtx(outside), "backend", deps());
      expect(missing.ok).toBe(false);
      expect(missing.message).toContain("Run /swarm init first");
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});

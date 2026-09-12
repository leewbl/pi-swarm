/**
 * Acceptance 2: /swarm init creates the layout plus the 7 template files
 * (swarm.yaml + 6 manifests), validates them, and a second init skips every
 * existing file without overwriting.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { AgentManifestSchema, SwarmConfigSchema } from "../../../src/protocol/schemas.js";
import { tmpWorkspaceDir } from "../../../src/util/atomic-file.js";
import { registerSwarmCommands } from "../../../src/extension/commands.js";
import { FakeCtx, FakePi, makeFakeStack } from "./fakes.js";

const workspaces: string[] = [];

afterAll(async () => {
  await Promise.all(workspaces.map((ws) => fsp.rm(ws, { recursive: true, force: true })));
});

async function freshWorkspace(): Promise<{ pi: FakePi; ctx: FakeCtx }> {
  const ws = await tmpWorkspaceDir("pi-swarm-init");
  workspaces.push(ws);
  const pi = new FakePi();
  registerSwarmCommands(pi, {
    buildStack: vi.fn(async () => makeFakeStack()),
    createRuntime: vi.fn(),
  });
  return { pi, ctx: new FakeCtx(ws) };
}

describe("/swarm init", () => {
  let dir: string;

  afterEach(async () => {
    if (dir !== undefined) await fsp.rm(dir, { recursive: true, force: true });
    dir = undefined as unknown as string;
  });

  it("creates the layout and all 7 template files, then skips them on re-init", async () => {
    const { pi, ctx } = await freshWorkspace();
    dir = ctx.cwd;

    await pi.commands.get("swarm")!.handler(["init"], ctx);
    const first = ctx.notifications[0]!.message;
    expect(first).toContain("[ok] created swarm.yaml");
    expect(first.match(/\[ok\] created agents\/[a-z]+\.yaml/g)).toHaveLength(6);
    expect(first).not.toContain("[skip]");

    const swarmRoot = path.join(ctx.cwd, ".pi", "swarm");
    for (const sub of [
      "agents",
      "tasks",
      "claims",
      "events",
      "blackboard",
      "artifacts",
      "runtime/instances",
      "runtime/cursors",
    ]) {
      const stat = await fsp.stat(path.join(swarmRoot, sub));
      expect(stat.isDirectory(), `${sub} should be a directory`).toBe(true);
    }
    expect((await fsp.readFile(path.join(swarmRoot, "swarm.yaml"), "utf8")).length).toBeGreaterThan(0);

    // Templates validate: manifests against AgentManifestSchema, config against SwarmConfigSchema.
    for (const role of ["coordinator", "architect", "researcher", "frontend", "backend", "tester"]) {
      const raw = await fsp.readFile(path.join(swarmRoot, "agents", `${role}.yaml`), "utf8");
      const parsed = AgentManifestSchema.safeParse(parseYaml(raw));
      expect(parsed.success, `${role} manifest should validate`).toBe(true);
      if (parsed.success) expect(parsed.data.agent.role).toBe(role);
    }
    const config = SwarmConfigSchema.parse(
      parseYaml(await fsp.readFile(path.join(swarmRoot, "swarm.yaml"), "utf8")),
    );
    expect(config.runtime.presenceStaleMs).toBe(15000);

    // Second init: everything exists, nothing overwritten.
    const manifestPath = path.join(swarmRoot, "agents", "backend.yaml");
    const before = await fsp.readFile(manifestPath, "utf8");
    await pi.commands.get("swarm")!.handler(["init"], ctx);
    const second = ctx.notifications[1]!.message;
    expect(second.match(/\[skip\] existing/g)).toHaveLength(7);
    expect(second).not.toContain("[ok] created");
    expect(await fsp.readFile(manifestPath, "utf8")).toBe(before);
    expect(ctx.notifications).toHaveLength(2);
  });

  it("adopts an existing workspace found above cwd (locateSwarmRoot)", async () => {
    const { pi: piOuter, ctx: ctxOuter } = await freshWorkspace();
    await piOuter.commands.get("swarm")!.handler(["init"], ctxOuter);
    const swarmRoot = path.join(ctxOuter.cwd, ".pi", "swarm");

    // A subdirectory of the workspace: init must locate the same root, not create a new one.
    const nested = path.join(ctxOuter.cwd, "packages", "app");
    await fsp.mkdir(nested, { recursive: true });
    const pi = new FakePi();
    registerSwarmCommands(pi, {
      buildStack: vi.fn(async () => makeFakeStack()),
      createRuntime: vi.fn(),
    });
    const ctx = new FakeCtx(nested);
    await pi.commands.get("swarm")!.handler(["init"], ctx);

    expect(ctx.notifications[0]!.message).toContain(swarmRoot);
    expect(ctx.notifications[0]!.message.match(/\[skip\] existing/g)).toHaveLength(7);
  });

  it("shows usage for unknown subcommands without touching the filesystem", async () => {
    const { pi, ctx } = await freshWorkspace();
    dir = ctx.cwd;
    await pi.commands.get("swarm")!.handler(["bogus"], ctx);
    expect(ctx.notifications[0]!.message).toContain("Usage: /swarm");
    await pi.commands.get("swarm")!.handler([], ctx);
    expect(ctx.notifications[1]!.message).toContain("Usage: /swarm");
  });

  it("accepts the omp 18.1.10 single-string args form ('/swarm init' → 'init')", async () => {
    const { pi, ctx } = await freshWorkspace();
    dir = ctx.cwd;

    await pi.commands.get("swarm")!.handler("init", ctx);

    expect(ctx.notifications[0]!.message).toContain("[ok] created swarm.yaml");
    expect(await fsp.stat(path.join(ctx.cwd, ".pi", "swarm", "swarm.yaml"))).toBeTruthy();
  });
 });

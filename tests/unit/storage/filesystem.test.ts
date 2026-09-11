/**
 * ConfigStore + ManifestStore unit tests (PRD Workstream A acceptance #9).
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigStore, createManifestStore } from "../../../src/storage/filesystem.js";
import { DEFAULT_SWARM_CONFIG, SwarmConfigSchema } from "../../../src/protocol/schemas.js";
import { makeManifest, newWorkspace } from "./fixtures.js";

describe("ConfigStore", () => {
  it("returns DEFAULT_SWARM_CONFIG when swarm.yaml is missing", async () => {
    const { paths } = await newWorkspace();
    const store = createConfigStore(paths);
    await expect(store.exists()).resolves.toBe(false);
    expect(await store.load()).toEqual(DEFAULT_SWARM_CONFIG);
  });

  it("round-trips a saved config", async () => {
    const { paths } = await newWorkspace();
    const store = createConfigStore(paths);
    const config = SwarmConfigSchema.parse({
      version: 1,
      project: { name: "pi-swarm" },
      runtime: { eventPollIntervalMs: 120 },
      blackboard: { hotspots: { "project.md": ["coordinator"], "api.md": ["backend"] } },
    });
    await store.save(config);
    await expect(store.exists()).resolves.toBe(true);
    expect(await store.load()).toEqual(config);
    // Defaults resolved on save survive the round trip.
    expect((await store.load()).runtime.taskScanIntervalMs).toBe(
      DEFAULT_SWARM_CONFIG.runtime.taskScanIntervalMs,
    );
  });

  it("rejects an invalid swarm.yaml with the file path in the message", async () => {
    const { paths } = await newWorkspace("pi-swarm-storage-cfg-bad");
    const file = paths.swarmConfigFile();
    await fsp.writeFile(file, "version: 2\nproject: {name: x}\n", "utf8");
    const store = createConfigStore(paths);
    await expect(store.load()).rejects.toThrow(new RegExp(path.basename(file).replace(".", "\\.")));
    await expect(store.load()).rejects.toThrow(/version/);
  });

  it("rejects unparseable YAML with the file path in the message", async () => {
    const { paths } = await newWorkspace("pi-swarm-storage-cfg-yaml");
    const file = paths.swarmConfigFile();
    await fsp.writeFile(file, ":\n  - not: [valid\n", "utf8");
    await expect(createConfigStore(paths).load()).rejects.toThrow(/swarm\.yaml/);
  });
});

describe("ManifestStore", () => {
  it("saves, lists sorted by role, and gets by role", async () => {
    const { paths } = await newWorkspace();
    const store = createManifestStore(paths);
    await store.save(makeManifest("backend", "Backend Agent"));
    await store.save(makeManifest("architect", "Architect Agent"));

    const listed = await store.list();
    expect(listed.map((m) => m.agent.role)).toEqual(["architect", "backend"]);
    expect(await store.get("backend")).toMatchObject({ agent: { role: "backend", name: "Backend Agent" } });
    expect(await store.get("missing")).toBeNull();
    expect(await store.validate()).toEqual([]);
  });

  it("round-trips manifest content through YAML", async () => {
    const { paths } = await newWorkspace();
    const store = createManifestStore(paths);
    await store.save({
      version: 1,
      agent: { role: "backend", name: "Backend" },
      capabilities: ["rust", "api"],
      blackboard: { read: ["findings/**"], write: ["findings/backend/**"] },
      wakeup: { taskAvailable: true, events: ["task.opened"] },
    });
    const loaded = await store.get("backend");
    expect(loaded).toEqual({
      version: 1,
      agent: { role: "backend", name: "Backend" },
      capabilities: ["rust", "api"],
      blackboard: { read: ["findings/**"], write: ["findings/backend/**"] },
      wakeup: { taskAvailable: true, events: ["task.opened"] },
    });
  });

  it("reports YAML and schema failures as issues and excludes them from list()", async () => {
    const { paths } = await newWorkspace();
    await fsp.writeFile(path.join(paths.agentsDir, "broken.yaml"), "agent: {role: [}\n", "utf8");
    await fsp.writeFile(
      path.join(paths.agentsDir, "wrong.yaml"),
      "version: 1\nagent: {role: 'Bad Role', name: x}\n",
      "utf8",
    );
    const store = createManifestStore(paths);
    expect(await store.list()).toEqual([]);
    const issues = await store.validate();
    expect(issues.map((i) => i.file).sort()).toEqual(["broken.yaml", "wrong.yaml"]);
    expect(issues.find((i) => i.file === "broken.yaml")?.error).toMatch(/YAML/);
    expect(issues.find((i) => i.file === "wrong.yaml")?.error).toMatch(/role/);
  });

  it("detects duplicate declared roles across files", async () => {
    const { paths } = await newWorkspace();
    const store = createManifestStore(paths);
    await store.save(makeManifest("architect"));
    // backend.yaml also claims to be the architect role.
    await fsp.writeFile(
      path.join(paths.agentsDir, "backend.yaml"),
      "version: 1\nagent: {role: architect, name: Impostor}\ncapabilities: []\n",
      "utf8",
    );

    const issues = await store.validate();
    expect(issues).toEqual([
      { file: "backend.yaml", error: expect.stringMatching(/duplicate agent role 'architect'.*architect\.yaml/) },
    ]);
    // First declaration (sorted file order) wins the list slot.
    expect((await store.list()).map((m) => m.agent.role)).toEqual(["architect"]);
  });

  it("rejects an invalid manifest on save", async () => {
    const { paths } = await newWorkspace();
    const store = createManifestStore(paths);
    await expect(
      store.save({ version: 1, agent: { role: "NOPE", name: "x" }, capabilities: [] }),
    ).rejects.toThrow();
  });
});

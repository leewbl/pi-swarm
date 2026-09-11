/**
 * PresenceStore unit tests (acceptance #7).
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPresenceStore } from "../../../src/storage/presence-store.js";
import { instanceId, makePresence, newWorkspace, T1, T2 } from "./fixtures.js";

describe("PresenceStore", () => {
  it("upserts and reads back presence records", async () => {
    const { paths } = await newWorkspace();
    const store = createPresenceStore(paths);
    const record = makePresence(1, "busy");
    await store.upsert(record);

    expect(await store.get(record.instanceId)).toEqual(record);
    expect(await store.list()).toEqual([record]);
    expect(await store.issues()).toEqual([]);

    // Upsert replaces the previous record wholesale.
    const updated = { ...record, state: "idle" as const, heartbeatAt: T1 };
    await store.upsert(updated);
    expect(await store.get(record.instanceId)).toEqual(updated);
    expect(await store.list()).toEqual([updated]);
  });

  it("marks stopped while preserving all other fields", async () => {
    const { paths } = await newWorkspace();
    const store = createPresenceStore(paths);
    const record = makePresence(1, "busy", "backend");
    await store.upsert(record);

    await store.markStopped(record.instanceId, T2);

    const stopped = await store.get(record.instanceId);
    expect(stopped).toEqual({ ...record, state: "stopped", heartbeatAt: T2 });
  });

  it("treats markStopped on a missing instance as a no-op", async () => {
    const { paths } = await newWorkspace();
    const store = createPresenceStore(paths);
    const missing = instanceId("ghost", "g");
    await expect(store.markStopped(missing, T2)).resolves.toBeUndefined();
    expect(await store.get(missing)).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("isolates invalid presence files from list() and reports them via issues()", async () => {
    const { paths } = await newWorkspace();
    const store = createPresenceStore(paths);
    const good = makePresence(1, "idle");
    await store.upsert(good);

    await fsp.writeFile(path.join(paths.instancesDir, "garbage.yaml"), "state: [broken\n", "utf8");
    await fsp.writeFile(
      path.join(paths.instancesDir, "badschema.yaml"),
      "version: 1\nrole: backend\ninstanceId: backend-aaaaaaaaaaaaaaaaaaaaaaaaaa\npid: 1\nstate: partying\nheartbeatAt: 2026-01-01T00:00:00.000Z\nstartedAt: 2026-01-01T00:00:00.000Z\n",
      "utf8",
    );

    expect(await store.list()).toEqual([good]);
    const issues = await store.issues();
    expect(issues.map((i) => i.file).sort()).toEqual(["badschema.yaml", "garbage.yaml"]);
    expect(issues.find((i) => i.file === "garbage.yaml")?.error).toMatch(/YAML/);
    expect(issues.find((i) => i.file === "badschema.yaml")?.error).toMatch(/state/);
  });

  it("skips markStopped for unreadable records instead of fabricating fields", async () => {
    const { paths } = await newWorkspace();
    const store = createPresenceStore(paths);
    const record = makePresence(1, "busy");
    await store.upsert(record);
    await fsp.writeFile(paths.presenceFile(record.instanceId), "not: valid\n", "utf8");

    await expect(store.markStopped(record.instanceId, T2)).resolves.toBeUndefined();
    expect(await store.get(record.instanceId)).toBeNull();
  });

  it("rejects schema-invalid records on upsert", async () => {
    const { paths } = await newWorkspace();
    const store = createPresenceStore(paths);
    await expect(store.upsert({ ...makePresence(1), pid: 0 })).rejects.toThrow(/pid/);
  });
});

/**
 * TaskStore unit tests (PRD Workstream A acceptance #5).
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskStore } from "../../../src/storage/task-store.js";
import { TaskExistsError } from "../../../src/storage/types.js";
import { makeTask, newWorkspace, taskId } from "./fixtures.js";

describe("TaskStore", () => {
  it("saves with exclusive create and reads the document back", async () => {
    const { paths } = await newWorkspace();
    const store = createTaskStore(paths);
    const task = makeTask(1, { kind: "refactor", priority: 10 });
    await store.save(task, { create: true });

    const loaded = await store.get(taskId(1));
    expect(loaded).toEqual(task);
    expect(await store.list()).toEqual([task]);
  });

  it("throws TaskExistsError when create collides", async () => {
    const { paths } = await newWorkspace();
    const store = createTaskStore(paths);
    await store.save(makeTask(1), { create: true });
    const second = makeTask(1, { kind: "other" });

    await expect(store.save(second, { create: true })).rejects.toBeInstanceOf(TaskExistsError);
    await expect(store.save(second, { create: true })).rejects.toThrow(/TASK-0001/);
    // Original content survives the collision.
    expect(await store.get(taskId(1))).toEqual(makeTask(1));
  });

  it("overwrites in default save mode (task updates)", async () => {
    const { paths } = await newWorkspace();
    const store = createTaskStore(paths);
    await store.save(makeTask(1), { create: true });
    const updated = makeTask(1, { status: "claimed", updatedAt: "2026-01-02T00:00:00.000Z" });
    await store.save(updated);
    expect(await store.get(taskId(1))).toEqual(updated);
    expect(await store.list()).toHaveLength(1);
  });

  it("isolates malformed task files from list() and reports them via issues()", async () => {
    const { paths } = await newWorkspace();
    const store = createTaskStore(paths);
    await store.save(makeTask(1), { create: true });

    // No front matter at all.
    await fsp.writeFile(path.join(paths.tasksDir, "README-notes.md"), "just prose\n", "utf8");
    // Front matter present but schema-invalid (status not in enum).
    await fsp.writeFile(
      path.join(paths.tasksDir, "TASK-0500.md"),
      "---\nid: TASK-0500\nstatus: bogus\nkind: general\npriority: 50\ncreatedBy: {role: coordinator, instanceId: coordinator-cccccccccccccccccccccccccc}\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\ndependsOn: []\ninputs: []\noutputs: []\n---\n\n# broken\n",
      "utf8",
    );

    expect((await store.list()).map((t) => t.metadata.id)).toEqual([taskId(1)]);
    const issues = await store.issues();
    expect(issues.map((i) => i.file).sort()).toEqual(["README-notes.md", "TASK-0500.md"]);
    expect(issues.find((i) => i.file === "README-notes.md")?.error).toMatch(/front matter/);
    expect(issues.find((i) => i.file === "TASK-0500.md")?.error).toMatch(/status/);
    expect(await store.get(taskId(500))).toBeNull();
  });

  it("returns null for missing or unknown-shape ids", async () => {
    const { paths } = await newWorkspace();
    const store = createTaskStore(paths);
    expect(await store.get(taskId(99))).toBeNull();
    expect(await store.get("../escape")).toBeNull();
    expect(await store.get("TASK-12")).toBeNull();
  });

  it("allocates zero-padded sequential ids from the highest existing number", async () => {
    const { paths } = await newWorkspace();
    const store = createTaskStore(paths);
    await expect(store.nextTaskId()).resolves.toBe("TASK-0001");

    await store.save(makeTask(1), { create: true });
    await expect(store.nextTaskId()).resolves.toBe("TASK-0002");

    await store.save(makeTask(99), { create: true });
    await store.save(makeTask(100), { create: true });
    await expect(store.nextTaskId()).resolves.toBe("TASK-0101");

    // Five-digit ids keep their width; unrelated files are ignored.
    await fsp.writeFile(path.join(paths.tasksDir, "TASK-12345.md"), "---\nnope\n", "utf8");
    await fsp.writeFile(path.join(paths.tasksDir, "scratch.md"), "---\nnope\n", "utf8");
    await expect(store.nextTaskId()).resolves.toBe("TASK-12346");
  });

  it("rejects schema-invalid documents on save", async () => {
    const { paths } = await newWorkspace();
    const store = createTaskStore(paths);
    const bad = makeTask(1, { priority: 999 });
    await expect(store.save(bad, { create: true })).rejects.toThrow(/priority/);
    // Nothing persisted.
    expect(await store.get(taskId(1))).toBeNull();
    expect(await store.issues()).toEqual([]);
  });
});

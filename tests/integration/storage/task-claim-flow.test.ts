/**
 * Integration: one workspace, all stores cooperating — task create → claim →
 * event append → cursor replay (the core loop the runtime drives).
 */
import { describe, expect, it } from "vitest";
import { createClaimStore } from "../../../src/storage/atomic-claim.js";
import { createConfigStore } from "../../../src/storage/filesystem.js";
import { createCursorStore } from "../../../src/storage/cursor-store.js";
import { createEventStore } from "../../../src/storage/event-store.js";
import { createTaskStore } from "../../../src/storage/task-store.js";
import { buildEvent } from "../../../src/protocol/events.js";
import { instanceId, makeClaim, makeTask, newWorkspace, taskId } from "../../unit/storage/fixtures.js";

const CLAIMANT = instanceId("backend", "b");
const COORDINATOR = instanceId("coordinator", "c");

describe("storage integration: task → claim → event → cursor", () => {
  it("walks the full lifecycle over a shared workspace", async () => {
    const { paths } = await newWorkspace("pi-swarm-storage-int");
    const configStore = createConfigStore(paths);
    const taskStore = createTaskStore(paths);
    const claimStore = createClaimStore(paths);
    const eventStore = createEventStore(paths, { instanceId: CLAIMANT });
    const cursorStore = createCursorStore(paths);

    // Workspace config persists and reloads.
    await configStore.save(await configStore.load());
    expect(await configStore.exists()).toBe(true);

    // Coordinator opens a task via exclusive create.
    const id = await taskStore.nextTaskId();
    expect(id).toBe(taskId(1));
    const task = makeTask(1, { eligibleRoles: ["backend"] });
    await taskStore.save(task, { create: true });

    // Exactly one claimant wins the atomic claim.
    const winner = makeClaim(1, id, "backend");
    const loser = makeClaim(2, id, "backend");
    expect(await claimStore.tryClaim(winner)).toEqual({ status: "claimed" });
    expect(await claimStore.tryClaim(loser)).toEqual({ status: "already_claimed" });
    expect((await claimStore.list()).map((c) => c.claimId)).toEqual([winner.claimId]);

    // Claimant announces progress on its own stream; consumer replays via cursor.
    const opened = buildEvent({
      type: "task.claimed",
      from: { role: "backend", instanceId: CLAIMANT },
      route: { mode: "direct", role: "coordinator" },
      context: { taskId: id, correlationId: "0000000000000000000000000C" },
      data: { claimId: winner.claimId },
    });
    const completed = buildEvent({
      type: "task.completed",
      from: { role: "backend", instanceId: CLAIMANT },
      route: { mode: "broadcast", topic: "tasks" },
      context: { taskId: id },
    });
    await eventStore.append(opened);
    await eventStore.append(completed);

    const cursor0 = await cursorStore.load(COORDINATOR);
    expect(cursor0.streams).toEqual({});
    const batch1 = await eventStore.readFrom(CLAIMANT, cursor0.streams[CLAIMANT]?.offset ?? 0);
    expect(batch1.events.map((e) => e.type)).toEqual(["task.claimed", "task.completed"]);
    expect(batch1.trailingIncomplete).toBe(false);

    await cursorStore.save(COORDINATOR, {
      streams: { [CLAIMANT]: { offset: batch1.offset, lastEventId: completed.id } },
    });

    // Second poll from the persisted offset sees nothing new.
    const cursor1 = await cursorStore.load(COORDINATOR);
    const batch2 = await eventStore.readFrom(CLAIMANT, cursor1.streams[CLAIMANT]!.offset);
    expect(batch2.events).toEqual([]);
    expect(batch2.offset).toBe(cursor1.streams[CLAIMANT]!.offset);

    // Task moves to done; the claim is released on its own claimId only.
    await taskStore.save({ ...task, metadata: { ...task.metadata, status: "done" } });
    expect((await taskStore.get(id))?.metadata.status).toBe("done");
    expect(await claimStore.remove(id, loser.claimId)).toBe(false);
    expect(await claimStore.remove(id, winner.claimId)).toBe(true);
    expect(await claimStore.list()).toEqual([]);
  });
});

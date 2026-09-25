import { describe, expect, it } from "vitest";
import { createInbox } from "../../../src/runtime/inbox.js";
import type { MatchedEvent } from "../../../src/runtime/ports.js";
import { makeEvent, makeIdentity } from "./fakes.js";

function matched(overrides: { type?: string; actionable?: boolean; direct?: boolean }): MatchedEvent {
  const producer = makeIdentity("coordinator");
  const event = makeEvent({
    type: overrides.type ?? "task.claimed",
    from: { role: producer.role, instanceId: producer.instanceId },
    route: overrides.direct
      ? { mode: "direct", role: "backend" }
      : { mode: "broadcast", topic: "tasks" },
  });
  return { event, channel: overrides.direct ? "direct" : "broadcast", actionable: overrides.actionable ?? false };
}

function taskCandidate(taskId: string, title = "Implement OAuth", priority = 70) {
  return { taskId, title, priority, path: `tasks/${taskId}.md` };
}

describe("createInbox peek/ack kinds", () => {
  it("returns null when nothing is queued", () => {
    expect(createInbox().peek()).toBeNull();
  });

  it("is actionable when tasks are queued", () => {
    const inbox = createInbox();
    inbox.enqueueTasks([taskCandidate("TASK-0001")]);
    expect(inbox.peek()!.kind).toBe("actionable");
  });

  it("is actionable when an actionable event is queued", () => {
    const inbox = createInbox();
    inbox.enqueueEvents([matched({ type: "review.completed", actionable: true })]);
    expect(inbox.peek()!.kind).toBe("actionable");
  });

  it("is warning when only warnings are queued", () => {
    const inbox = createInbox();
    inbox.enqueueWarning("cursor file unreadable");
    expect(inbox.peek()!.kind).toBe("warning");
  });

  it("is informational when only non-actionable events are queued", () => {
    const inbox = createInbox();
    inbox.enqueueEvents([matched({})]);
    expect(inbox.peek()!.kind).toBe("informational");
  });

  it("keeps warning precedence over informational events (never aside mid-turn)", () => {
    const inbox = createInbox();
    inbox.enqueueEvents([matched({})]);
    inbox.enqueueWarning("stream read failed");
    expect(inbox.peek()!.kind).toBe("warning");
  });

  it("ack clears the queue after delivery; nack retains it for retry", () => {
    const inbox = createInbox();
    inbox.enqueueTasks([taskCandidate("TASK-0001")]);
    expect(inbox.peek()).not.toBeNull();
    inbox.nack();
    expect(inbox.peek()).not.toBeNull(); // failed delivery keeps the batch
    inbox.ack();
    expect(inbox.peek()).toBeNull();
  });

  it("pendingCount sums queued items", () => {
    const inbox = createInbox();
    inbox.enqueueTasks([taskCandidate("TASK-0001")]);
    inbox.enqueueEvents([matched({}), matched({})]);
    inbox.enqueueWarning("w");
    expect(inbox.pendingCount()).toBe(4);
    inbox.ack();
    expect(inbox.pendingCount()).toBe(0);
  });
});

describe("createInbox rendering", () => {
  it("titles with counts of tasks and events", () => {
    const inbox = createInbox();
    inbox.enqueueTasks([taskCandidate("TASK-0001"), taskCandidate("TASK-0002")]);
    inbox.enqueueEvents([matched({}), matched({}), matched({})]);
    const message = inbox.peek()!;
    expect(message.title).toBe("SWARM INBOX — 2 tasks, 3 events");
  });

  it("uses singular nouns for single items and includes warnings", () => {
    const inbox = createInbox();
    inbox.enqueueTasks([taskCandidate("TASK-0001")]);
    inbox.enqueueWarning("cursor file unreadable");
    const message = inbox.peek()!;
    expect(message.title).toBe("SWARM INBOX — 1 task, 1 warning");
  });

  it("renders up to ten task lines with id, priority, title and path", () => {
    const inbox = createInbox();
    inbox.enqueueTasks(
      Array.from({ length: 12 }, (_, i) => taskCandidate(`TASK-${String(i + 1).padStart(4, "0")}`, `Task ${i + 1}`, 60)),
    );
    const body = inbox.peek()!.body;

    const lines = body.split("\n");
    expect(lines[0]).toBe("Actionable tasks:");
    expect(lines[1]).toBe("TASK-0001 [P60] Task 1 — tasks/TASK-0001.md");
    expect(lines.filter((l) => l.startsWith("TASK-"))).toHaveLength(10);
    expect(body).toContain("… and 2 more");
  });

  it("omits the empty-title middle segment when a candidate has no title", () => {
    const inbox = createInbox();
    inbox.enqueueTasks([taskCandidate("TASK-0007", "")]);
    const body = inbox.peek()!.body;
    expect(body).toContain("TASK-0007 [P70] — tasks/TASK-0007.md");
  });

  it("groups events by type/channel with counts, not per-event lines", () => {
    const inbox = createInbox();
    inbox.enqueueEvents([
      matched({ type: "task.claimed" }),
      matched({ type: "task.claimed" }),
      matched({ type: "task.claimed", direct: true }),
    ]);
    const body = inbox.peek()!.body;

    expect(body).toContain("Events:");
    expect(body).toContain("2 task.claimed (broadcast tasks)");
    expect(body).toContain("1 task.claimed (direct)");
    expect(body.split("\n").filter((l) => l.includes("task.claimed"))).toHaveLength(2);
  });

  it("renders warnings as lines", () => {
    const inbox = createInbox();
    inbox.enqueueWarning("cursor file unreadable");
    inbox.enqueueWarning("presence write failed");
    const body = inbox.peek()!.body;
    expect(body).toContain("Warnings:\ncursor file unreadable\npresence write failed");
  });

  it("appends the task hint only when actionable tasks exist", () => {
    const withTasks = createInbox();
    withTasks.enqueueTasks([taskCandidate("TASK-0001")]);
    expect(withTasks.peek()!.body).toContain("Open the task document before working.");

    const eventsOnly = createInbox();
    eventsOnly.enqueueEvents([matched({ actionable: true })]);
    expect(eventsOnly.peek()!.body).not.toContain("Open the task document");
  });
});

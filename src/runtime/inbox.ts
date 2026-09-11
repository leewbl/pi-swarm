/**
 * Inbox — consolidation buffer between the polling loops and the wake
 * scheduler (architecture §15, PRD Workstream C).
 *
 * Enqueued tasks/events/warnings coalesce into ONE SwarmInboxMessage per
 * drain: counts over dumps, task ids with titles and paths, never full event
 * bodies. Kind precedence is actionable > warning > informational (a batch
 * carrying a warning must never be delivered as an aside mid-turn).
 */
import type { MatchedEvent, SwarmInboxMessage, WakeKind } from "./ports.js";
import type { TaskCandidate } from "./task-poller.js";

const MAX_TASK_LINES = 10;

export interface Inbox {
  enqueueEvents(events: MatchedEvent[]): void;
  enqueueTasks(candidates: TaskCandidate[]): void;
  enqueueWarning(text: string): void;
  /** One consolidated message, or null when nothing is queued; clears the queue. */
  drain(): SwarmInboxMessage | null;
  /** Undelivered items waiting for the next wake flush. */
  pendingCount(): number;
}

interface InboxQueue {
  tasks: TaskCandidate[];
  events: MatchedEvent[];
  warnings: string[];
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function renderTitle(queue: InboxQueue): string {
  const parts: string[] = [];
  if (queue.tasks.length > 0) parts.push(plural(queue.tasks.length, "task"));
  if (queue.events.length > 0) parts.push(plural(queue.events.length, "event"));
  if (queue.warnings.length > 0) parts.push(plural(queue.warnings.length, "warning"));
  return `SWARM INBOX — ${parts.join(", ")}`;
}

function renderTaskLines(tasks: TaskCandidate[]): string[] {
  const lines = tasks.slice(0, MAX_TASK_LINES).map((t) => {
    const label = `${t.taskId} [P${t.priority}]${t.title.length > 0 ? ` ${t.title}` : ""}`;
    return `${label} — ${t.path}`;
  });
  if (tasks.length > MAX_TASK_LINES) {
    lines.push(`… and ${tasks.length - MAX_TASK_LINES} more`);
  }
  return lines;
}

function renderEventLines(events: MatchedEvent[]): string[] {
  const groups = new Map<string, { type: string; channel: string; topic: string; count: number }>();
  for (const { event, channel } of events) {
    const topic = event.route.mode === "broadcast" ? event.route.topic : "";
    const key = `${channel}|${topic}|${event.type}`;
    const group = groups.get(key) ?? { type: event.type, channel, topic, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].map((g) =>
    g.channel === "direct" ? `${g.count} ${g.type} (direct)` : `${g.count} ${g.type} (broadcast ${g.topic})`,
  );
}

function renderBody(queue: InboxQueue): string {
  const sections: string[] = [];
  if (queue.tasks.length > 0) {
    sections.push(["Actionable tasks:", ...renderTaskLines(queue.tasks)].join("\n"));
  }
  if (queue.events.length > 0) {
    sections.push(["Events:", ...renderEventLines(queue.events)].join("\n"));
  }
  if (queue.warnings.length > 0) {
    sections.push(["Warnings:", ...queue.warnings].join("\n"));
  }
  if (queue.tasks.length > 0) {
    sections.push("Open the task document before working.");
  }
  return sections.join("\n\n");
}

export function createInbox(): Inbox {
  let queue: InboxQueue = { tasks: [], events: [], warnings: [] };
  return {
    enqueueEvents(events): void {
      queue.events.push(...events);
    },
    enqueueTasks(candidates): void {
      queue.tasks.push(...candidates);
    },
    enqueueWarning(text): void {
      queue.warnings.push(text);
    },
    drain(): SwarmInboxMessage | null {
      const drained = queue;
      queue = { tasks: [], events: [], warnings: [] };
      if (drained.tasks.length === 0 && drained.events.length === 0 && drained.warnings.length === 0) {
        return null;
      }
      const actionable =
        drained.tasks.length > 0 || drained.events.some((m) => m.actionable);
      const kind: WakeKind = actionable
        ? "actionable"
        : drained.warnings.length > 0
          ? "warning"
          : "informational";
      return { kind, title: renderTitle(drained), body: renderBody(drained) };
    },
    pendingCount(): number {
      return queue.tasks.length + queue.events.length + queue.warnings.length;
    },
  };
}

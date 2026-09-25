/**
 * Inbox — consolidation buffer between the polling loops and the wake
 * scheduler (architecture §15, PRD Workstream C).
 *
 * Enqueued tasks/events/warnings coalesce into ONE SwarmInboxMessage per
 * flush: counts over dumps, task ids with titles and paths, never full event
 * bodies. Kind precedence is actionable > warning > informational (a batch
 * carrying a warning must never be delivered as an aside mid-turn).
 *
 * Structural liveness fix §19: delivery is peek → deliver → ack/nack instead
 * of a destructive drain. A failed wake keeps the batch queued so the next
 * flush retries it; ack clears it. One consolidated message exists at a
 * time, so batch ids are unnecessary — the queue itself is the batch.
 */
import type { MatchedEvent, SwarmInboxMessage, WakeKind } from "./ports.js";
import type { TaskCandidate } from "./task-poller.js";

const MAX_TASK_LINES = 10;

export interface Inbox {
  enqueueEvents(events: MatchedEvent[]): void;
  enqueueTasks(candidates: TaskCandidate[]): void;
  enqueueWarning(text: string): void;
  /** Render the consolidated message WITHOUT clearing the queue; null when empty. */
  peek(): SwarmInboxMessage | null;
  /** Clear the queue after a successful delivery. */
  ack(): void;
  /** Retain the queue after a failed delivery (next flush retries). */
  nack(): void;
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
    const tier = t.tier !== undefined ? `[${t.tier}] ` : "";
    const label = `${t.taskId} ${tier}[P${t.priority}]${t.title.length > 0 ? ` ${t.title}` : ""}`;
    const reason = t.tier === "fallback" && t.reason !== undefined ? `\n  ${t.reason}` : "";
    return `${label} — ${t.path}${reason}`;
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

function consolidatedKind(queue: InboxQueue): WakeKind {
  const actionable = queue.tasks.length > 0 || queue.events.some((m) => m.actionable);
  if (actionable) return "actionable";
  return queue.warnings.length > 0 ? "warning" : "informational";
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
    peek(): SwarmInboxMessage | null {
      if (queue.tasks.length === 0 && queue.events.length === 0 && queue.warnings.length === 0) {
        return null;
      }
      return {
        kind: consolidatedKind(queue),
        title: renderTitle(queue),
        body: renderBody(queue),
      };
    },
    ack(): void {
      queue = { tasks: [], events: [], warnings: [] };
    },
    nack(): void {
      // Retain for retry on the next wake flush.
    },
    pendingCount(): number {
      return queue.tasks.length + queue.events.length + queue.warnings.length;
    },
  };
}

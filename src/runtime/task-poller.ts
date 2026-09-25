/**
 * Task poller — the task-pool loop half of PRD Workstream C (architecture
 * §15.1). It scans eligible open tasks via the domain TaskService (never
 * claims anything) and suppresses candidates whose identity key
 * (`updatedAt|claimKey`) matches the batch already committed as delivered, so
 * a persistently ignored task does not re-wake the agent.
 *
 * `flushNotified()` commits the most recent poll's batch as delivered — the
 * runtime calls it only after a wake batch was actually delivered. Surfaced
 * candidates keep resurfacing until that commit, so a failed wake never loses
 * a task, and unchanged tasks never repeat once their batch is committed.
 * NOTE: TaskView (src/domain/types.ts) exposes metadata only — no body, no
 * title. Candidate titles are therefore read from the task documents through
 * the optional TaskStore; without it candidates carry an empty title.
 */
import type { AgentIdentity, NormalizedAgentManifest } from "../protocol/schemas.js";
import type { TaskService, TaskView } from "../domain/types.js";
import type { TaskStore } from "../storage/types.js";
import { nowIso } from "../util/clock.js";
import { createLogger } from "../util/logger.js";
import type { Logger } from "../util/logger.js";

export interface TaskCandidate {
  taskId: string;
  /** First body heading line with its `# ` marker stripped ("" when unavailable). */
  title: string;
  priority: number;
  /** Workspace-relative path: `tasks/<id>.md`. */
  path: string;
  /** Resolver tier explaining WHY this agent is eligible (fix §22). */
  tier?: "primary" | "secondary" | "fallback";
  /** Eligibility explanation (set for fallback candidates). */
  reason?: string;
}

export interface TaskPoller {
  /** Surfaces eligible candidates not yet committed as delivered. */
  poll(): Promise<TaskCandidate[]>;
  /** Commit the last surfaced batch as delivered (call after wake delivery). */
  flushNotified(): void;
  /** Drop the delivered-suppression for these taskIds (watchdog re-wake). */
  resurface(taskIds: readonly string[]): void;
  /** ISO time of the most recent scan, or null before the first. */
  readonly lastScanAt: string | null;
}
export interface TaskPollerDeps {
  identity: AgentIdentity;
  manifest: NormalizedAgentManifest;
  taskService: TaskService;
  /** Source of task bodies for candidate titles (TaskView has none). */
  taskStore?: TaskStore;
  now?: () => string;
  logger?: Logger;
}

/** First Markdown heading of the body, hashes stripped; first non-empty line otherwise. */
export function extractTaskTitle(body: string): string {
  const lines = body.split("\n");
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) return heading[1];
  }
  for (const line of lines) {
    if (line.trim().length > 0) return line.trim();
  }
  return "";
}

export function createTaskPoller(deps: TaskPollerDeps): TaskPoller {
  const { identity, manifest, taskService, taskStore } = deps;
  const now = deps.now ?? nowIso;
  const logger = deps.logger ?? createLogger("pi-swarm:task-poller");

  /** taskId -> key of the batch committed as delivered by flushNotified(). */
  const notified = new Map<string, string>();
  /** Keys of the most recent poll's eligible set, awaiting commit. */
  let pending: Map<string, string> | null = null;
  let lastScanAt: string | null = null;

  const candidateKey = (view: TaskView): string =>
    `${view.metadata.updatedAt}|${view.claim ? view.claim.claimId : "none"}`;

  return {
    async poll(): Promise<TaskCandidate[]> {
      lastScanAt = now();
      const views = await taskService.list({
        forAgent: { identity, manifest },
        statuses: ["open"],
        requireDependencies: true,
      });
      const current = new Map<string, string>();
      const fresh: TaskView[] = [];
      for (const view of views) {
        if (!view.eligible) continue;
        const key = candidateKey(view);
        current.set(view.metadata.id, key);
        if (notified.get(view.metadata.id) !== key) fresh.push(view);
      }
      pending = current;

      const candidates = await Promise.all(
        fresh.map(async (view): Promise<TaskCandidate> => {
          let title = "";
          if (taskStore) {
            const doc = await taskStore.get(view.metadata.id);
            if (doc) title = extractTaskTitle(doc.body);
          }
          return {
            taskId: view.metadata.id,
            title,
            priority: view.metadata.priority,
            path: `tasks/${view.metadata.id}.md`,
            ...(view.tier !== undefined ? { tier: view.tier } : {}),
            ...(view.tier === "fallback"
              ? { reason: `no active ${view.metadata.workDomain ?? "specialist"} specialist; you are an allowed fallback` }
              : {}),
          };
        }),
      );

      candidates.sort(
        (a, b) =>
          b.priority - a.priority ||
          (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
      );
      if (candidates.length > 0) {
        logger.debug("task candidates surfaced", { count: candidates.length });
      }
      return candidates;
    },

    flushNotified(): void {
      if (pending === null) return;
      notified.clear();
      for (const [id, key] of pending) notified.set(id, key);
      pending = null;
    },

    resurface(taskIds: readonly string[]): void {
      for (const id of taskIds) notified.delete(id);
    },
    get lastScanAt(): string | null {
      return lastScanAt;
    },
  };
}

/**
 * Recovery service (PRD FR-18, architecture §10): drift detection and repair.
 *
 * - `scan()`: classify claims (orphan / suspect), Markdown↔claim drift, and
 *   stale presence records. Read-only.
 * - `reconcile()`: repair the Markdown status from the canonical claim
 *   records in both directions. Never touches claims, done/failed/abandoned
 *   tasks. Idempotent.
 * - `recoverOrphans()`: for stale presence AND confirmed-dead claimants only —
 *   abandoned → claim removal → open, with events.
 * - `recoverTask()`: manual single-task recovery (`/swarm recover`), which
 *   proceeds even when the claimant is still alive.
 */
import type {
  ClaimantState,
  EventService,
  Inconsistency,
  RecoveryAction,
  RecoveryReport,
  RecoveryService,
} from "./types.js";
import type { ClaimStore, PresenceStore, TaskStore } from "../storage/types.js";
import type {
  AgentIdentity,
  ClaimRecord,
  PresenceRecord,
  SwarmConfig,
  TaskDocument,
  TaskStatus,
} from "../protocol/schemas.js";
import { TASK_TRANSITIONS } from "../protocol/schemas.js";
import { CLAIM_CONSISTENT_STATUSES } from "./policy-service.js";
import { isProcessAlive as probeProcessAlive } from "./process-alive.js";
import { nowIso } from "../util/clock.js";

export interface RecoveryServiceDeps {
  taskStore: TaskStore;
  claimStore: ClaimStore;
  presenceStore: PresenceStore;
  eventService: EventService;
  config: SwarmConfig;
  now?: () => string;
  /** Test seam; defaults to the local-host PID probe. */
  isProcessAlive?: (pid: number) => boolean;
}

export function createRecoveryService(deps: RecoveryServiceDeps): RecoveryService {
  return new RecoveryServiceImpl(deps);
}

class RecoveryServiceImpl implements RecoveryService {
  private readonly now: () => string;
  private readonly alive: (pid: number) => boolean;

  constructor(private readonly deps: RecoveryServiceDeps) {
    this.now = deps.now ?? nowIso;
    this.alive = deps.isProcessAlive ?? probeProcessAlive;
  }

  async scan(): Promise<RecoveryReport> {
    const claims = await this.deps.claimStore.list();
    const tasks = await this.deps.taskStore.list();
    const taskById = new Map(tasks.map((t) => [t.metadata.id, t] as const));
    const staleMs = this.deps.config.runtime.presenceStaleMs;
    const nowMs = Date.parse(this.now());

    const orphans: ClaimantState[] = [];
    const suspects: ClaimantState[] = [];
    const inconsistencies: Inconsistency[] = [];
    for (const claim of claims) {
      const presence = await this.deps.presenceStore.get(claim.agent.instanceId);
      const presenceStale =
        presence === null || nowMs - Date.parse(presence.heartbeatAt) > staleMs;
      const claimantAlive = this.alive(claim.pid);
      if (!presenceStale) continue;
      const state: ClaimantState = {
        taskId: claim.taskId,
        claim,
        presence,
        presenceStale,
        claimantAlive,
      };
      if (claimantAlive) suspects.push(state);
      else orphans.push(state);
    }

    for (const claim of claims) {
      const task = taskById.get(claim.taskId);
      if (task === undefined) {
        inconsistencies.push({
          taskId: claim.taskId,
          kind: "task_file_missing",
          detail: `claim ${claim.claimId} exists but the task file is missing`,
        });
      } else if (!CLAIM_CONSISTENT_STATUSES[task.metadata.status]) {
        inconsistencies.push({
          taskId: claim.taskId,
          kind: "claim_without_markdown_status",
          detail: `claim ${claim.claimId} exists but task status is ${task.metadata.status}`,
        });
      }
    }
    const claimedTaskIds = new Set(claims.map((c) => c.taskId));
    for (const task of tasks) {
      const status = task.metadata.status;
      if (
        (status === "claimed" || status === "in_progress" || status === "blocked") &&
        !claimedTaskIds.has(task.metadata.id)
      ) {
        inconsistencies.push({
          taskId: task.metadata.id,
          kind: "markdown_claimed_without_claim",
          detail: `task status is ${status} but no claim record exists`,
        });
      }
    }
    const statusIndexAll = new Map(tasks.map((t) => [t.metadata.id, t.metadata.status] as const));
    for (const task of tasks) {
      if (task.metadata.status !== "blocked") continue;
      for (const obligation of task.metadata.blockedOn) {
        if (!statusIndexAll.has(obligation)) {
          inconsistencies.push({
            taskId: task.metadata.id,
            kind: "blocked_on_missing",
            detail: `blocked task references missing obligation ${obligation}`,
          });
        }
      }
    }

    const staleInstances: PresenceRecord[] = [];
    for (const record of await this.deps.presenceStore.list()) {
      if (record.state !== "stopped" && nowMs - Date.parse(record.heartbeatAt) > staleMs) {
        staleInstances.push(record);
      }
    }
    return { orphans, suspects, inconsistencies, staleInstances };
  }

  async reconcile(): Promise<{ taskId: string; repaired: string }[]> {
    const claims = await this.deps.claimStore.list();
    const claimedTaskIds = new Set(claims.map((c) => c.taskId));
    const tasks = await this.deps.taskStore.list();
    const statusIndex = new Map(tasks.map((t) => [t.metadata.id, t.metadata.status] as const));
    const repairs: { taskId: string; repaired: string }[] = [];
    for (const task of tasks) {
      const status = task.metadata.status;
      const hasClaim = claimedTaskIds.has(task.metadata.id);
      // Claim canonical (§9.5): claim + open Markdown -> claimed. Claim
      // missing: claimed/in_progress Markdown -> open. done/failed/abandoned
      // and already-consistent files are never touched.
      let target: TaskStatus | null = null;
      if (hasClaim && status === "open") target = "claimed";
      else if (!hasClaim && (status === "claimed" || status === "in_progress")) target = "open";
      else if (status === "blocked") {
        // Structural liveness fix §26: a blocked task whose obligations are
        // all complete can resume (claim retained -> in_progress, claim lost
        // -> open). A blocked task without an owner always returns to open.
        const allDone =
          task.metadata.blockedOn.length > 0 &&
          task.metadata.blockedOn.every((id) => statusIndex.get(id) === "done");
        if (allDone && hasClaim) target = "in_progress";
        else if (!hasClaim || allDone) target = "open";
      }
      if (target === null) continue;
      await this.deps.taskStore.save({
        ...task,
        metadata: { ...task.metadata, status: target, updatedAt: this.now() },
      });
      repairs.push({ taskId: task.metadata.id, repaired: `${status}->${target}` });
    }
    return repairs;
  }

  async recoverOrphans(by: AgentIdentity): Promise<RecoveryAction[]> {
    const report = await this.scan();
    const actions: RecoveryAction[] = [];
    for (const orphan of report.orphans) {
      actions.push(
        await this.recoverClaim(orphan.taskId, orphan.claim, by, {
          abandonReason: "claimant_dead",
          detail: `claimant ${orphan.claim.agent.instanceId} (pid ${orphan.claim.pid}) is dead`,
        }),
      );
    }
    return actions;
  }

  async recoverTask(
    taskId: string,
    by: AgentIdentity,
  ): Promise<{ ok: boolean; message: string; action?: RecoveryAction }> {
    const task = await this.deps.taskStore.get(taskId);
    if (task === null) {
      return { ok: false, message: `task ${taskId} not found` };
    }
    const claim = await this.deps.claimStore.get(taskId);
    if (claim === null) {
      return { ok: false, message: `task ${taskId} has no claim record to recover` };
    }
    const liveness = this.alive(claim.pid) ? "alive" : "dead";
    const action = await this.recoverClaim(taskId, claim, by, {
      abandonReason: "manual_recovery",
      detail: `claimant ${claim.agent.instanceId} (pid ${claim.pid}) is ${liveness}; manual recovery`,
    });
    return { ok: true, message: `${action.action}: ${action.detail}`, action };
  }

  // -- internals ------------------------------------------------------------

  /**
   * abandon (when the state machine allows it) -> remove claim -> reopen.
   * Tasks already done/failed just get their stale claim removed; tasks
   * already abandoned skip straight to reopen.
   */
  private async recoverClaim(
    taskId: string,
    claim: ClaimRecord,
    by: AgentIdentity,
    opts: { abandonReason: string; detail: string },
  ): Promise<RecoveryAction> {
    let task: TaskDocument | null = await this.deps.taskStore.get(taskId);
    if (task === null) {
      await this.deps.claimStore.remove(taskId, claim.claimId);
      return {
        taskId,
        action: "skipped_not_orphan",
        detail: `task file missing; stale claim ${claim.claimId} removed (${opts.detail})`,
      };
    }

    const abandoned = TASK_TRANSITIONS[task.metadata.status].includes("abandoned");
    if (abandoned) {
      task = await this.saveStatus(task, "abandoned");
      await this.emitLifecycle("task.abandoned", taskId, by, {
        taskId,
        reason: opts.abandonReason,
      });
    }
    await this.deps.claimStore.remove(taskId, claim.claimId);
    if (task.metadata.status !== "abandoned") {
      return {
        taskId,
        action: "skipped_not_orphan",
        detail: `task already ${task.metadata.status}; stale claim removed (${opts.detail})`,
      };
    }
    task = await this.saveStatus(task, "open");
    await this.emitLifecycle("task.reopened", taskId, by, { taskId, reason: "recovered" });
    return {
      taskId,
      action: abandoned ? "abandoned_reopened" : "reopened_only",
      detail: opts.detail,
    };
  }

  private async saveStatus(task: TaskDocument, status: TaskStatus): Promise<TaskDocument> {
    const updated: TaskDocument = {
      ...task,
      metadata: { ...task.metadata, status, updatedAt: this.now() },
    };
    await this.deps.taskStore.save(updated);
    return updated;
  }

  private async emitLifecycle(
    type: string,
    taskId: string,
    by: AgentIdentity,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.eventService.emit(
      {
        type,
        route: { mode: "broadcast", topic: "tasks" },
        context: { taskId },
        data,
      },
      by,
    );
  }
}

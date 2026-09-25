/**
 * Liveness watchdog evaluation (structural liveness fix §21) — a final
 * safety net, never the scheduler. Pure: callers snapshot the task pool,
 * claims, and the current topology; this module classifies
 *
 * - STALLED: due, unblocked, serviceable work that has made no progress for
 *   longer than the warning threshold while an eligible candidate exists;
 * - UNSERVICEABLE: due work no active agent may legally claim (Invariant F —
 *   surfaced explicitly, never rendered as normal idle).
 *
 * The runtime uses this to re-surface/re-wake eligible idle agents and to
 * feed `/swarm status` and `/swarm doctor`.
 */
import type { ClaimRecord, TaskDocument, TaskStatus } from "../protocol/schemas.js";
import { classifyTaskServiceability } from "./serviceability.js";
import type { ServiceabilityView } from "./serviceability.js";
import type { ActiveTopology } from "./topology.js";

export interface LivenessInput {
  nowIso: string;
  /** Stall threshold in ms (swarm.yaml liveness.warningAfterMs). */
  warningAfterMs: number;
  /**
   * Global fallback gate (swarm.yaml scheduling.fallbackEnabled). MUST match
   * the claim-time resolver policy or the watchdog would report serviceable
   * work the resolver then denies (policy drift).
   */
  fallbackEnabled?: boolean;
  tasks: TaskDocument[];
  claims: ClaimRecord[];
  topology: ActiveTopology;
  statusIndex: ReadonlyMap<string, TaskStatus>;
  /**
   * Restrict STALLED findings to tasks whose candidate set includes at least
   * one of these instance ids (the local agent's re-wake view). Omit for the
   * global status/doctor view.
   */
  forInstanceIds?: string[];
}

export interface LivenessFinding {
  taskId: string;
  /** Serviceability tier or state explaining the finding. */
  state: string;
  reason: string;
  /** Eligible candidate instance ids (serviceable findings only). */
  candidates: string[];
}

export interface LivenessReport {
  /** Due + serviceable + eligible candidate exists + no progress threshold. */
  stalled: LivenessFinding[];
  /** Due but no legal claimant — requires user action or a new role. */
  unserviceable: LivenessFinding[];
}

function lastProgressMs(task: TaskDocument, claims: readonly ClaimRecord[], nowMs: number): number {
  const claim = claims.find((c) => c.taskId === task.metadata.id);
  const latest = Math.max(
    Date.parse(task.metadata.updatedAt),
    claim !== undefined ? Date.parse(claim.claimedAt) : 0,
  );
  return nowMs - latest;
}

export function evaluateLiveness(input: LivenessInput): LivenessReport {
  const nowMs = Date.parse(input.nowIso);
  const claimed = new Set(input.claims.map((c) => c.taskId));
  const stalled: LivenessFinding[] = [];
  const unserviceable: LivenessFinding[] = [];

  for (const task of input.tasks) {
    if (task.metadata.status !== "open" || claimed.has(task.metadata.id)) continue;
    const view: ServiceabilityView = classifyTaskServiceability(task, input.topology, {
      nowIso: input.nowIso,
      claimExists: false,
      sourceClaimantInstanceIds: [],
      statusIndex: input.statusIndex,
      ...(input.fallbackEnabled !== undefined ? { fallbackEnabled: input.fallbackEnabled } : {}),
    });
    if (view.state === "scheduled" || view.state === "blocked" || view.state === "waiting_dependencies") {
      continue;
    }
    if (view.state === "unserviceable" || view.state === "legacy") {
      if (lastProgressMs(task, input.claims, nowMs) > input.warningAfterMs) {
        unserviceable.push({
          taskId: view.taskId,
          state: view.state,
          reason: view.reason ?? "no eligible agent",
          candidates: [],
        });
      }
      continue;
    }
    if (view.state !== "ready") continue; // in_flight / terminal
    if (input.forInstanceIds !== undefined) {
      const overlap = view.candidates.filter((id) => input.forInstanceIds!.includes(id));
      if (overlap.length === 0) continue;
    }
    if (lastProgressMs(task, input.claims, nowMs) > input.warningAfterMs) {
      stalled.push({
        taskId: view.taskId,
        state: view.state === "ready" ? (view.tier ?? "ready") : view.state,
        reason:
          view.reason ??
          `serviceable (${view.tier ?? "ready"} tier) with ${view.candidates.length} eligible candidate(s) but no claim`,
        candidates: view.candidates,
      });
    }
  }
  return { stalled, unserviceable };
}

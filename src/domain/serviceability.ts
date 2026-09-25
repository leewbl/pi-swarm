/**
 * Serviceability (structural liveness fix §10): an explicit runtime concept
 * INDEPENDENT of task lifecycle state. Lifecycle answers "where is this task
 * in its state machine"; serviceability answers "can the current topology
 * actually progress it". An unserviceable task is not a deadlock — it is an
 * explicit topology/capability gap that must be surfaced (Invariant F), never
 * rendered as normal idle.
 */
import type { TaskDocument } from "../protocol/schemas.js";
import type { CandidateTier, ResolverContext } from "./candidate-resolver.js";
import { resolveTaskCandidates } from "./candidate-resolver.js";
import type { ActiveTopology } from "./topology.js";

export type ServiceabilityState =
  | "ready" // open, due, unblocked, serviceable (tier set)
  | "scheduled" // open but availableAt is in the future
  | "blocked" // blocked on durable obligations
  | "waiting_dependencies" // open but dependsOn incomplete
  | "in_flight" // claimed / in_progress
  | "terminal" // done / failed / abandoned
  | "unserviceable" // due + open, but no legal claimant
  | "legacy"; // no workDomain: legacy eligibility path

export interface ServiceabilityView {
  taskId: string;
  state: ServiceabilityState;
  /** Present when state === "ready". */
  tier?: CandidateTier;
  /** Eligible candidate instance ids (ready tiers). */
  candidates: string[];
  /** Explanation for scheduled/blocked/unserviceable/legacy states. */
  reason?: string;
  /** Missing hard capabilities when unserviceable. */
  missing?: string[];
}

/** Compute the serviceability dimension for one task (pure). */
export function classifyTaskServiceability(
  task: TaskDocument,
  topology: ActiveTopology,
  ctx: ResolverContext,
): ServiceabilityView {
  const meta = task.metadata;
  const base = { taskId: meta.id, candidates: [] as string[] };

  if (meta.status === "done" || meta.status === "failed" || meta.status === "abandoned") {
    return { ...base, state: "terminal" };
  }
  if (meta.status === "blocked") {
    return { ...base, state: "blocked", reason: `blocked on ${meta.blockedOn.join(", ") || "(no registered obligation)"}` };
  }
  if (meta.status === "claimed" || meta.status === "in_progress") {
    return { ...base, state: "in_flight" };
  }

  // open tasks: scheduling and obligation gates first, then resolution.
  if (meta.availableAt !== undefined && Date.parse(ctx.nowIso) < Date.parse(meta.availableAt)) {
    return { ...base, state: "scheduled", reason: `due at ${meta.availableAt}` };
  }
  const pendingObligation = meta.blockedOn.find((id) => ctx.statusIndex.get(id) !== "done");
  if (pendingObligation !== undefined) {
    return { ...base, state: "blocked", reason: `blocked on ${pendingObligation} (${ctx.statusIndex.get(pendingObligation) ?? "missing"})` };
  }
  const pendingDep = meta.dependsOn.find((id) => ctx.statusIndex.get(id) !== "done");
  if (pendingDep !== undefined) {
    return { ...base, state: "waiting_dependencies", reason: `depends on ${pendingDep} (${ctx.statusIndex.get(pendingDep) ?? "missing"})` };
  }

  const resolution = resolveTaskCandidates(task, topology, ctx);
  switch (resolution.state) {
    case "primary":
    case "secondary":
    case "fallback":
      return {
        ...base,
        state: "ready",
        tier: resolution.state,
        candidates: resolution.candidates.map((a) => a.instanceId),
        ...(resolution.state === "fallback" ? { reason: resolution.reason } : {}),
      };
    case "unserviceable":
      return { ...base, state: "unserviceable", reason: resolution.reason, missing: resolution.missing };
    case "legacy":
      return { ...base, state: "legacy", reason: resolution.reason };
    case "not_actionable":
      return { ...base, state: "waiting_dependencies", reason: resolution.reason };
  }
}

/** Counts keyed by state for `/swarm status` (fix §10 suggested output). */
export function summarizeServiceability(
  views: readonly ServiceabilityView[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const view of views) counts[view.state] = (counts[view.state] ?? 0) + 1;
  return counts;
}

/** One-line diagnostic for an unserviceable task (fix §21.2). */
export function renderUnserviceable(view: ServiceabilityView): string {
  const missing =
    view.missing !== undefined && view.missing.length > 0
      ? `\nMissing hard capability: ${view.missing.join(", ")}`
      : "";
  return `UNSERVICEABLE TASK\n${view.taskId}${missing}\n${view.reason ?? "no eligible agent"}\nNo active agent can legally claim this task.`;
}

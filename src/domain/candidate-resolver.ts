/**
 * Boundary Gate + tier candidate resolver (structural liveness fix §9).
 *
 * The central scheduling rule: hard constraints first, then the specialist
 * presence boundary. Tier is NOT a weighted race — when an active primary
 * specialist exists for the task's work domain, every other agent is NOT
 * ELIGIBLE (hard gate, Invariant D). Secondary opens only when no primary is
 * active; fallback opens only when neither exists and both the task and the
 * global config allow it; otherwise the task is explicitly UNSERVICEABLE
 * (Invariant F) — never silently idle.
 *
 * Atomic claim answers "which allowed candidate wins ownership". This resolver
 * answers "who is allowed to compete".
 *
 * Pure and host-free: no I/O, no clocks — callers supply time, claim state,
 * dependency statuses, and the current ActiveTopology.
 */
import type { TaskDocument, TaskStatus } from "../protocol/schemas.js";
import type { ActiveAgent, ActiveTopology } from "./topology.js";

export type CandidateTier = "primary" | "secondary" | "fallback";

export type CandidateResolution =
  | { state: "not_actionable"; reason: string }
  /** No workDomain: the legacy eligibleRoles/requiredCapabilities path applies (fix §6.3). */
  | { state: "legacy"; reason: string }
  | { state: "primary"; candidates: ActiveAgent[] }
  | { state: "secondary"; candidates: ActiveAgent[] }
  | { state: "fallback"; candidates: ActiveAgent[]; reason: string }
  | { state: "unserviceable"; missing: string[]; reason: string };

export interface ResolverContext {
  nowIso: string;
  /** Whether the canonical claim record exists for this task. */
  claimExists: boolean;
  /** Instance ids excluded by constraints.excludeCurrentClaimant. */
  sourceClaimantInstanceIds: readonly string[];
  /** taskId -> status for dependsOn/blockedOn resolution. */
  statusIndex: ReadonlyMap<string, TaskStatus>;
  /** Global fallback gate (swarm.yaml scheduling.fallbackEnabled). Default true. */
  fallbackEnabled?: boolean;
}

/** Hard-capability requirements fallback cannot bypass (new + legacy fields). */
export function hardCapabilityRequirements(task: TaskDocument): string[] {
  const meta = task.metadata;
  const caps = new Set<string>(meta.hardRequirements?.capabilities ?? []);
  // Legacy requiredCapabilities stay hard constraints on the new path too.
  for (const cap of meta.requiredCapabilities ?? []) caps.add(cap);
  return [...caps];
}

function passesHardConstraints(
  task: TaskDocument,
  agent: ActiveAgent,
  ctx: ResolverContext,
): boolean {
  const meta = task.metadata;
  const have = new Set(agent.capabilities);
  for (const cap of hardCapabilityRequirements(task)) {
    if (!have.has(cap)) return false;
  }
  if (meta.constraints?.excludeTaskAuthor && meta.createdBy.instanceId === agent.instanceId) {
    return false;
  }
  if (
    meta.constraints?.excludeCurrentClaimant &&
    ctx.sourceClaimantInstanceIds.includes(agent.instanceId)
  ) {
    return false;
  }
  return true;
}

function notActionableReason(task: TaskDocument, ctx: ResolverContext): string | null {
  const meta = task.metadata;
  if (meta.status !== "open") return `task ${meta.id} is ${meta.status}, not open`;
  if (ctx.claimExists) return `task ${meta.id} already has an owner`;
  if (meta.availableAt !== undefined && Date.parse(ctx.nowIso) < Date.parse(meta.availableAt)) {
    return `task ${meta.id} is not due until ${meta.availableAt}`;
  }
  for (const dep of meta.dependsOn) {
    const status = ctx.statusIndex.get(dep);
    if (status === undefined) return `task ${meta.id} depends on ${dep}, which does not exist`;
    if (status !== "done") return `task ${meta.id} depends on ${dep}, which is ${status}`;
  }
  for (const obligation of meta.blockedOn) {
    const status = ctx.statusIndex.get(obligation);
    if (status === undefined) {
      return `task ${meta.id} is blocked on ${obligation}, which does not exist`;
    }
    if (status !== "done") return `task ${meta.id} is blocked on ${obligation} (${status})`;
  }
  return null;
}

/**
 * Resolve candidates for one task against the current topology (fix §9.1).
 *
 * 0. actionable gate: open, due, dependencies complete, no claim;
 * 1. hard constraints (capabilities, author/claimant exclusion) — no fallback bypass;
 * 2. active primary specialists for workDomain -> primary only;
 * 3. else active secondary specialists -> secondary only;
 * 4. else fallback pool when task + config + agent allow it;
 * 5. else UNSERVICEABLE with the missing hard requirements.
 */
export function resolveTaskCandidates(
  task: TaskDocument,
  topology: ActiveTopology,
  ctx: ResolverContext,
): CandidateResolution {
  const actionable = notActionableReason(task, ctx);
  if (actionable !== null) return { state: "not_actionable", reason: actionable };

  const domain = task.metadata.workDomain;
  if (domain === undefined) {
    return {
      state: "legacy",
      reason: `task ${task.metadata.id} has no workDomain; legacy eligibleRoles/requiredCapabilities path applies`,
    };
  }

  const hardOk = (agent: ActiveAgent): boolean => passesHardConstraints(task, agent, ctx);
  const hardCaps = hardCapabilityRequirements(task);

  const primary = (topology.primaryCoverage.get(domain) ?? []).filter(hardOk);
  if (primary.length > 0) return { state: "primary", candidates: primary };

  const secondary = (topology.secondaryCoverage.get(domain) ?? []).filter(hardOk);
  if (secondary.length > 0) return { state: "secondary", candidates: secondary };

  const taskFallbackAllowed = task.metadata.fallback?.allowed ?? true;
  const globalFallback = ctx.fallbackEnabled ?? true;
  if (taskFallbackAllowed && globalFallback) {
    const pool = topology.agents.filter((agent) => agent.fallbackEnabled && hardOk(agent));
    if (pool.length > 0) {
      return {
        state: "fallback",
        candidates: pool,
        reason: `no active ${domain} specialist; fallback is open`,
      };
    }
  }

  const missingCaps = hardCaps.filter(
    (cap) => !topology.capabilityCoverage.has(cap) ||
      (topology.capabilityCoverage.get(cap) ?? []).length === 0,
  );
  if (missingCaps.length > 0) {
    return {
      state: "unserviceable",
      missing: missingCaps,
      reason: `no active agent has hard capability: ${missingCaps.join(", ")}`,
    };
  }
  if (topology.agents.length === 0) {
    return { state: "unserviceable", missing: [], reason: "no active agents in the swarm" };
  }
  return {
    state: "unserviceable",
    missing: [],
    reason:
      "every active agent is excluded by hard constraints or fallback is disabled for this task",
  };
}

/** Whether `instanceId` may compete for `task` right now (poller/claim gate). */
export function isEligibleCandidate(
  resolution: CandidateResolution,
  instanceId: string,
): boolean {
  if (resolution.state === "primary" || resolution.state === "secondary" || resolution.state === "fallback") {
    return resolution.candidates.some((agent) => agent.instanceId === instanceId);
  }
  return false;
}

/**
 * Stable in-tier ranking by preferred capabilities (fix §9.3): agents covering
 * more preferred capabilities first. Ranking only orders/surfaces candidates;
 * it never replaces the atomic claim.
 */
export function rankByPreferredCapabilities(
  candidates: readonly ActiveAgent[],
  preferred: readonly string[],
): ActiveAgent[] {
  if (preferred.length === 0) return [...candidates];
  const score = (agent: ActiveAgent): number => {
    let n = 0;
    for (const cap of preferred) if (agent.capabilities.includes(cap)) n += 1;
    return n;
  };
  return [...candidates].sort((a, b) => score(b) - score(a));
}

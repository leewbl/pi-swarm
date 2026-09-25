/**
 * Topology view helpers shared by `/swarm status|doctor` and the
 * swarm_topology / swarm_task_candidates tools: build the current
 * ActiveTopology from a stack's shared stores and render it (or one task's
 * candidate resolution) as text. Read-only — no mutation, no events.
 */
import { buildActiveTopology } from "../domain/topology.js";
import type { ActiveTopology } from "../domain/topology.js";
import { resolveTaskCandidates } from "../domain/candidate-resolver.js";
import { rankByPreferredCapabilities } from "../domain/candidate-resolver.js";
import { nowIso } from "../util/clock.js";
import type { SwarmStack } from "./compose.js";

export interface TopologyViewResult {
  text: string;
  details: Record<string, unknown>;
}

async function currentTopology(stack: SwarmStack): Promise<ActiveTopology> {
  const [presence, manifests] = await Promise.all([
    stack.stores.presence.list(),
    stack.stores.manifest.list(),
  ]);
  return buildActiveTopology(presence, manifests, {
    nowIso: nowIso(),
    presenceStaleMs: stack.config.runtime.presenceStaleMs,
  });
}

export async function renderTopologyView(stack: SwarmStack): Promise<TopologyViewResult> {
  const topology = await currentTopology(stack);
  const lines: string[] = [];
  if (topology.agents.length === 0) {
    lines.push("Active topology: (no active agents)");
  } else {
    lines.push("Active topology:");
    for (const agent of topology.agents) {
      lines.push(
        `  ${agent.role.padEnd(14)} ${agent.presence.padEnd(6)} primary: ${agent.primaryDomains.join(", ") || "(none)"}`,
      );
      if (agent.secondaryDomains.length > 0) {
        lines.push(`  ${"".padEnd(14)} ${"".padEnd(6)} secondary: ${agent.secondaryDomains.join(", ")}`);
      }
      if (!agent.fallbackEnabled) {
        lines.push(`  ${"".padEnd(14)} ${"".padEnd(6)} fallback: disabled`);
      }
    }
  }
  if (topology.suspectInstanceIds.length > 0) {
    lines.push(`Suspect (stale, excluded): ${topology.suspectInstanceIds.join(", ")}`);
  }
  return {
    text: lines.join("\n"),
    details: {
      agents: topology.agents.map((a) => ({
        role: a.role,
        instanceId: a.instanceId,
        presence: a.presence,
        primaryDomains: a.primaryDomains,
        secondaryDomains: a.secondaryDomains,
        fallbackEnabled: a.fallbackEnabled,
      })),
      suspect: topology.suspectInstanceIds,
    },
  };
}

export type CandidateViewResult =
  | { ok: true; text: string; details: Record<string, unknown> }
  | { ok: false; message: string };

export async function resolveTaskCandidatesForStatus(
  stack: SwarmStack,
  taskId: string,
): Promise<CandidateViewResult> {
  const task = await stack.stores.task.get(taskId);
  if (task === null) return { ok: false, message: `Task ${taskId} not found.` };
  const [topology, claims, tasks] = await Promise.all([
    currentTopology(stack),
    stack.stores.claim.list(),
    stack.stores.task.list(),
  ]);
  const statusIndex = new Map(tasks.map((t) => [t.metadata.id, t.metadata.status] as const));
  const claim = claims.find((c) => c.taskId === taskId) ?? null;
  const sourceClaimants: string[] = [];
  if (task.metadata.constraints?.excludeCurrentClaimant) {
    const sourceId = task.metadata.origin?.sourceTaskId ?? task.metadata.parentTask;
    if (sourceId !== undefined) {
      const sourceClaim = claims.find((c) => c.taskId === sourceId);
      if (sourceClaim !== undefined) sourceClaimants.push(sourceClaim.agent.instanceId);
    }
  }
  const resolution = resolveTaskCandidates(task, topology, {
    nowIso: nowIso(),
    claimExists: claim !== null,
    sourceClaimantInstanceIds: sourceClaimants,
    statusIndex,
    fallbackEnabled: stack.config.scheduling.fallbackEnabled,
  });
  const lines: string[] = [`Task ${taskId} [${task.metadata.status}] kind ${task.metadata.kind}`];
  const detail: Record<string, unknown> = { taskId, state: resolution.state };
  switch (resolution.state) {
    case "primary":
    case "secondary":
    case "fallback": {
      const ranked = rankByPreferredCapabilities(
        resolution.candidates,
        task.metadata.preferredCapabilities ?? [],
      );
      lines.push(`Tier: ${resolution.state}`);
      if (resolution.state === "fallback") lines.push(resolution.reason);
      for (const agent of ranked) {
        lines.push(`  ${agent.role} (${agent.instanceId}, ${agent.presence})`);
      }
      detail.candidates = ranked.map((a) => a.instanceId);
      break;
    }
    case "unserviceable":
      lines.push(`UNSERVICEABLE: ${resolution.reason}`);
      if (resolution.missing.length > 0) lines.push(`Missing hard capability: ${resolution.missing.join(", ")}`);
      detail.missing = resolution.missing;
      break;
    case "not_actionable":
      lines.push(`Not actionable: ${resolution.reason}`);
      break;
    case "legacy":
      lines.push(`Legacy task (no workDomain): ${resolution.reason}`);
      break;
  }
  return { ok: true, text: lines.join("\n"), details: detail };
}

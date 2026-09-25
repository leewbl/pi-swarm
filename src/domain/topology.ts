/**
 * Active topology (structural liveness fix §8): the runtime's explicit view of
 * which agents are currently participating and which work domains they cover.
 *
 * Host-free and I/O-free: callers hand in presence records and manifests;
 * `buildActiveTopology` merges them deterministically. Only live, non-stale
 * instances participate in normal candidate resolution. Stale-but-not-stopped
 * instances become `suspect` — surfaced for diagnostics, never silently
 * treated as active coverage.
 */
import type { AgentManifest, NormalizedAgentManifest, PresenceRecord } from "../protocol/schemas.js";
import { normalizeAgentManifest } from "../protocol/schemas.js";

/** Presence-derived participation state used by candidate resolution. */
export type TopologyPresence = "idle" | "busy" | "suspect";

export interface ActiveAgent {
  role: string;
  instanceId: string;
  /** Display identity for diagnostics; not used by resolution. */
  pid: number;
  primaryDomains: string[];
  secondaryDomains: string[];
  capabilities: string[];
  fallbackEnabled: boolean;
  presence: TopologyPresence;
}

export interface ActiveTopology {
  /** Participating agents (suspect ones included, flagged). */
  agents: ActiveAgent[];
  /** domain -> agents owning it as primary. */
  primaryCoverage: Map<string, ActiveAgent[]>;
  /** domain -> agents covering it as secondary. */
  secondaryCoverage: Map<string, ActiveAgent[]>;
  /** capability -> agents declaring it. */
  capabilityCoverage: Map<string, ActiveAgent[]>;
  /** Instance ids excluded from resolution (stale presence), for diagnostics. */
  suspectInstanceIds: string[];
}

export interface BuildTopologyOptions {
  /** ISO now; defaults are not allowed here — callers own time. */
  nowIso: string;
  /** Staleness window in ms (swarm.yaml runtime.presenceStaleMs). */
  presenceStaleMs: number;
}

function push<K>(map: Map<K, ActiveAgent[]>, key: K, agent: ActiveAgent): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [agent]);
  else if (!list.includes(agent)) list.push(agent);
}

/**
 * Build the current topology. Presence rules:
 * - state "stopped" records are ignored entirely;
 * - heartbeat older than presenceStaleMs -> `suspect` (excluded from coverage);
 * - fresh heartbeat -> idle/busy per the record.
 *
 * A presence record whose manifest no longer exists is ignored (doctor flags
 * orphan manifests separately).
 */
export function buildActiveTopology(
  presence: readonly PresenceRecord[],
  manifests: readonly AgentManifest[],
  opts: BuildTopologyOptions,
): ActiveTopology {
  const byRole = new Map<string, NormalizedAgentManifest>();
  for (const m of manifests) byRole.set(m.agent.role, normalizeAgentManifest(m));

  const nowMs = Date.parse(opts.nowIso);
  const agents: ActiveAgent[] = [];
  const primaryCoverage = new Map<string, ActiveAgent[]>();
  const secondaryCoverage = new Map<string, ActiveAgent[]>();
  const capabilityCoverage = new Map<string, ActiveAgent[]>();
  const suspectInstanceIds: string[] = [];

  for (const record of presence) {
    if (record.state === "stopped") continue;
    const manifest = byRole.get(record.role);
    if (!manifest) continue;
    const fresh = nowMs - Date.parse(record.heartbeatAt) <= opts.presenceStaleMs;
    if (!fresh) {
      suspectInstanceIds.push(record.instanceId);
      continue;
    }
    const agent: ActiveAgent = {
      role: manifest.role,
      instanceId: record.instanceId,
      pid: record.pid,
      primaryDomains: manifest.primaryDomains,
      secondaryDomains: manifest.secondaryDomains,
      capabilities: manifest.capabilities,
      fallbackEnabled: manifest.fallbackEnabled,
      presence: record.state === "busy" ? "busy" : "idle",
    };
    agents.push(agent);
    for (const domain of agent.primaryDomains) push(primaryCoverage, domain, agent);
    for (const domain of agent.secondaryDomains) push(secondaryCoverage, domain, agent);
    for (const capability of agent.capabilities) push(capabilityCoverage, capability, agent);
  }

  return { agents, primaryCoverage, secondaryCoverage, capabilityCoverage, suspectInstanceIds };
}

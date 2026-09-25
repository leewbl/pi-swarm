/**
 * Topology regression matrix (structural liveness fix §30, Cases A–H).
 *
 * The Boundary Gate + tier resolver must produce exactly the documented
 * candidate sets for every topology configuration, including N=1 fallback,
 * active-specialist exclusion, hard-constraint unserviceability, and the
 * self-review constraint. Pure unit tests over buildActiveTopology +
 * resolveTaskCandidates.
 */
import { describe, expect, it } from "vitest";
import { buildActiveTopology } from "../../../src/domain/topology.js";
import { resolveTaskCandidates, rankByPreferredCapabilities } from "../../../src/domain/candidate-resolver.js";
import type { CandidateResolution } from "../../../src/domain/candidate-resolver.js";
import type { TaskDocument } from "../../../src/protocol/schemas.js";
import { makeIdentity, makePresence } from "./fakes.js";

const NOW = "2026-09-24T17:16:34Z";
const STALE_MS = 15_000;

function manifestDoc(opts: {
  role: string;
  primary?: string[];
  secondary?: string[];
  capabilities?: string[];
  fallback?: boolean;
}) {
  return {
    version: 1 as const,
    agent: { role: opts.role, name: opts.role },
    capabilities: opts.capabilities ?? [],
    ...(opts.primary !== undefined || opts.secondary !== undefined
      ? {
          domains: {
            ...(opts.primary !== undefined ? { primary: opts.primary } : {}),
            ...(opts.secondary !== undefined ? { secondary: opts.secondary } : {}),
          },
        }
      : {}),
    ...(opts.fallback !== undefined ? { fallback: { enabled: opts.fallback } } : {}),
  };
}

function topologyOf(
  agents: { role: string; primary?: string[]; secondary?: string[]; capabilities?: string[]; fallback?: boolean; stale?: boolean }[],
) {
  const presence = agents.map((a) =>
    makePresence({
      identity: makeIdentity(a.role),
      heartbeatAt: a.stale === true ? "2026-09-24T16:00:00Z" : NOW,
    }),
  );
  const manifests = agents.map((a) =>
    manifestDoc({
      role: a.role,
      primary: a.primary,
      secondary: a.secondary,
      capabilities: a.capabilities,
      fallback: a.fallback,
    }),
  );
  return buildActiveTopology(presence, manifests, { nowIso: NOW, presenceStaleMs: STALE_MS });
}

let counter = 0;
function task(opts: {
  workDomain: string;
  hardCapabilities?: string[];
  fallbackAllowed?: boolean;
  excludeTaskAuthor?: boolean;
  authorRole?: string;
  availableAt?: string;
  status?: TaskDocument["metadata"]["status"];
}): TaskDocument {
  counter += 1;
  return {
    metadata: {
      id: `TASK-${String(counter).padStart(4, "0")}`,
      status: opts.status ?? "open",
      kind: "general",
      priority: 50,
      workDomain: opts.workDomain,
      ...(opts.hardCapabilities !== undefined && opts.hardCapabilities.length > 0
        ? { hardRequirements: { capabilities: opts.hardCapabilities } }
        : {}),
      ...(opts.fallbackAllowed !== undefined ? { fallback: { allowed: opts.fallbackAllowed } } : {}),
      ...(opts.excludeTaskAuthor !== undefined
        ? { constraints: { excludeTaskAuthor: opts.excludeTaskAuthor } }
        : {}),
      ...(opts.availableAt !== undefined ? { availableAt: opts.availableAt } : {}),
      createdBy: { role: opts.authorRole ?? "tester", instanceId: makeIdentity(opts.authorRole ?? "tester").instanceId },
      createdAt: NOW,
      updatedAt: NOW,
      dependsOn: [],
      blockedOn: [],
      inputs: [],
      outputs: [],
    },
    body: "# t\n\nb",
  };
}

const emptyStatusIndex = new Map<string, TaskDocument["metadata"]["status"]>();

function resolve(t: TaskDocument, topology: ReturnType<typeof topologyOf>): CandidateResolution {
  return resolveTaskCandidates(t, topology, {
    nowIso: NOW,
    claimExists: false,
    sourceClaimantInstanceIds: [],
    statusIndex: emptyStatusIndex,
  });
}


function roles(resolution: CandidateResolution): string[] {
  if (resolution.state === "primary" || resolution.state === "secondary" || resolution.state === "fallback") {
    return resolution.candidates.map((a) => a.role).sort();
  }
  return [];
}

describe("topology regression matrix (fix §30)", () => {
  it("Case A — coordinator only: backend task falls back to coordinator", () => {
    const topology = topologyOf([{ role: "coordinator" }]);
    const resolution = resolve(task({ workDomain: "backend" }), topology);
    expect(resolution.state).toBe("fallback");
    expect(roles(resolution)).toEqual(["coordinator"]);
  });

  it("Case B — backend only: research task falls back to backend", () => {
    const topology = topologyOf([{ role: "backend" }]);
    const resolution = resolve(task({ workDomain: "research" }), topology);
    expect(resolution.state).toBe("fallback");
    expect(roles(resolution)).toEqual(["backend"]);
  });

  it("Case C — coordinator + backend: backend task is primary-only; coordinator NOT eligible", () => {
    const topology = topologyOf([{ role: "coordinator" }, { role: "backend" }]);
    const resolution = resolve(task({ workDomain: "backend" }), topology);
    expect(resolution.state).toBe("primary");
    expect(roles(resolution)).toEqual(["backend"]);
  });

  it("Case D — coordinator + architect (backend secondary), no backend: secondary-only", () => {
    const topology = topologyOf([
      { role: "coordinator" },
      { role: "architect", secondary: ["backend", "planning"] },
    ]);
    const resolution = resolve(task({ workDomain: "backend" }), topology);
    expect(resolution.state).toBe("secondary");
    expect(roles(resolution)).toEqual(["architect"]);
  });

  it("Case E — researcher + backend + tester, decision task: backend secondary wins", () => {
    const topology = topologyOf([
      { role: "researcher" },
      { role: "backend", secondary: ["decision"] },
      { role: "tester" },
    ]);
    const resolution = resolve(task({ workDomain: "decision" }), topology);
    expect(resolution.state).toBe("secondary");
    expect(roles(resolution)).toEqual(["backend"]);
  });

  it("Case F — full swarm: every domain stays inside its active primary", () => {
    const topology = topologyOf([
      { role: "coordinator", primary: ["planning", "coordination", "decision"], secondary: ["architecture", "research"] },
      { role: "architect", primary: ["architecture", "design"] },
      { role: "researcher", primary: ["research"] },
      { role: "frontend", primary: ["frontend", "ui"] },
      { role: "backend", primary: ["backend", "api"] },
      { role: "tester", primary: ["testing", "verification"] },
    ]);
    expect(roles(resolve(task({ workDomain: "backend" }), topology))).toEqual(["backend"]);
    expect(roles(resolve(task({ workDomain: "decision" }), topology))).toEqual(["coordinator"]);
    expect(roles(resolve(task({ workDomain: "testing" }), topology))).toEqual(["tester"]);
    expect(roles(resolve(task({ workDomain: "frontend" }), topology))).toEqual(["frontend"]);
  });

  it("Case G — hard capability present nowhere: unserviceable; fallback cannot bypass", () => {
    const topology = topologyOf([
      { role: "coordinator" },
      { role: "backend", capabilities: ["typescript"] },
    ]);
    const resolution = resolve(task({ workDomain: "backend", hardCapabilities: ["ios-device-access"] }), topology);
    expect(resolution.state).toBe("unserviceable");
    if (resolution.state === "unserviceable") {
      expect(resolution.missing).toEqual(["ios-device-access"]);
    }
  });

  it("Case H — only the task author alive but excludeTaskAuthor: unserviceable is correct", () => {
    const topology = topologyOf([{ role: "tester" }]);
    const resolution = resolve(
      task({ workDomain: "verification", excludeTaskAuthor: true, authorRole: "tester" }),
      topology,
    );
    expect(resolution.state).toBe("unserviceable");
  });

  it("stale presence agents are excluded from resolution and flagged suspect", () => {
    const topology = topologyOf([
      { role: "backend", stale: true },
      { role: "tester" },
    ]);
    expect(topology.agents.map((a) => a.role)).toEqual(["tester"]);
    expect(topology.suspectInstanceIds).toHaveLength(1);
    const resolution = resolve(task({ workDomain: "backend" }), topology);
    expect(resolution.state).toBe("fallback");
    expect(roles(resolution)).toEqual(["tester"]);
  });

  it("task-level fallback opt-out closes the fallback tier", () => {
    const topology = topologyOf([{ role: "coordinator" }]);
    const resolution = resolve(task({ workDomain: "backend", fallbackAllowed: false }), topology);
    expect(resolution.state).toBe("unserviceable");
  });

  it("agent-level fallback opt-out excludes an agent from the fallback pool", () => {
    const topology = topologyOf([
      { role: "coordinator", fallback: false },
      { role: "tester" },
    ]);
    const resolution = resolve(task({ workDomain: "backend" }), topology);
    expect(resolution.state).toBe("fallback");
    expect(roles(resolution)).toEqual(["tester"]);
  });

  it("not-yet-due scheduled work is not actionable; becomes actionable after availableAt", () => {
    const topology = topologyOf([{ role: "backend" }]);
    const before = resolve(
      task({ workDomain: "backend", availableAt: "2026-09-24T18:00:00Z" }),
      topology,
    );
    expect(before.state).toBe("not_actionable");
    if (before.state === "not_actionable") {
      expect(before.reason).toContain("not due until");
    }
    const after = resolve(
      task({ workDomain: "backend", availableAt: "2026-09-24T16:00:00Z" }),
      topology,
    );
    expect(after.state).toBe("primary");
  });

  it("legacy tasks without workDomain take the legacy path (no silent reinterpretation)", () => {
    const topology = topologyOf([{ role: "backend" }]);
    counter += 1;
    const legacy: TaskDocument = {
      metadata: {
        id: `TASK-${String(counter).padStart(4, "0")}`,
        status: "open",
        kind: "general",
        priority: 50,
        eligibleRoles: ["backend"],
        createdBy: { role: "coordinator", instanceId: makeIdentity("coordinator").instanceId },
        createdAt: NOW,
        updatedAt: NOW,
        dependsOn: [],
        blockedOn: [],
        inputs: [],
        outputs: [],
      },
      body: "# t\n\nb",
    };
    const resolution = resolve(legacy, topology);
    expect(resolution.state).toBe("legacy");
  });

  it("rankByPreferredCapabilities orders within a tier without changing membership", () => {
    const topology = topologyOf([
      { role: "architect", secondary: ["decision"], capabilities: ["decision", "architecture-analysis"] },
      { role: "backend", secondary: ["decision"], capabilities: ["decision"] },
    ]);
    const resolution = resolve(task({ workDomain: "decision" }), topology);
    expect(resolution.state).toBe("secondary");
    if (resolution.state !== "secondary") return;
    const ranked = rankByPreferredCapabilities(resolution.candidates, ["architecture-analysis"]);
    expect(ranked.map((a) => a.role)).toEqual(["architect", "backend"]);
    expect(new Set(ranked).size).toBe(resolution.candidates.length);
  });
});

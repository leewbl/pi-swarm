/**
 * Shared deterministic fixtures for storage-layer tests.
 *
 * Every test gets a fresh temp workspace via `newWorkspace()`; the module
 * tracks them so `cleanupWorkspaces()` (registered in each test file's
 * afterEach) removes everything.
 */
import { promises as fsp } from "node:fs";
import { afterEach } from "vitest";
import { SwarmPaths } from "../../../src/util/paths.js";
import { tmpWorkspaceDir } from "../../../src/util/atomic-file.js";
import { buildEvent } from "../../../src/protocol/events.js";
import type {
  AgentManifest,
  ClaimRecord,
  PresenceRecord,
  SwarmEvent,
  TaskDocument,
} from "../../../src/protocol/schemas.js";

/** Crockford base32 alphabet (ULID charset); index n gives a distinct 26-char id. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const T0 = "2026-01-01T00:00:00.000Z";
export const T1 = "2026-01-01T00:00:01.000Z";
export const T2 = "2026-01-01T00:00:02.000Z";

export function pad26(ch: string): string {
  return ch.repeat(26);
}

/** Distinct valid instanceId per (role, ch). */
export function instanceId(role: string, ch: string): string {
  return `${role}-${ch.repeat(26)}`;
}

/** Distinct valid ULID-shaped id (event ids, claim ids). */
export function crockfordId(n: number): string {
  return `${"0".repeat(25)}${CROCKFORD[n % CROCKFORD.length]}`;
}

export function taskId(n: number): string {
  return `TASK-${String(n).padStart(4, "0")}`;
}

export interface FixtureWorkspace {
  root: string;
  paths: SwarmPaths;
}

const workspaces: FixtureWorkspace[] = [];

export async function newWorkspace(prefix = "pi-swarm-storage"): Promise<FixtureWorkspace> {
  const root = await tmpWorkspaceDir(`${prefix}-`);
  const paths = new SwarmPaths(root);
  await paths.ensureLayout();
  const ws = { root, paths };
  workspaces.push(ws);
  return ws;
}

export async function cleanupWorkspaces(): Promise<void> {
  while (workspaces.length > 0) {
    const ws = workspaces.pop()!;
    await fsp.rm(ws.root, { recursive: true, force: true });
  }
}

afterEach(cleanupWorkspaces);

export function makeTask(n: number, overrides: Partial<TaskDocument["metadata"]> = {}): TaskDocument {
  return {
    metadata: {
      id: taskId(n),
      status: "open",
      kind: "general",
      priority: 50,
      createdBy: { role: "coordinator", instanceId: instanceId("coordinator", "c") },
      createdAt: T0,
      updatedAt: T0,
      dependsOn: [],
      inputs: [],
      outputs: [],
      ...overrides,
    },
    body: `# ${taskId(n)}\n\nDo the thing.\n`,
  };
}

export function makeClaim(n: number, task: string, role = "backend"): ClaimRecord {
  return {
    version: 1,
    taskId: task,
    claimId: `CLM-${crockfordId(n)}`,
    agent: { role, instanceId: instanceId(role, String.fromCharCode(97 + (n % 26))) },
    pid: 4000 + n,
    claimedAt: T0,
  };
}

export function makeEvent(n: number, from: { role: string; instanceId: string }): SwarmEvent {
  return buildEvent(
    {
      type: "test.event",
      from,
      route: { mode: "broadcast", topic: "tasks" },
      data: { seq: n },
      id: crockfordId(n),
      time: T0,
    },
  );
}

export function makePresence(
  n: number,
  state: PresenceRecord["state"] = "idle",
  role = "backend",
): PresenceRecord {
  return {
    version: 1,
    role,
    instanceId: instanceId(role, String.fromCharCode(97 + (n % 26))),
    pid: 5000 + n,
    state,
    heartbeatAt: T0,
    startedAt: T0,
  };
}

export function makeManifest(role: string, name = `Agent ${role}`): AgentManifest {
  return {
    version: 1,
    agent: { role, name },
    capabilities: [],
  };
}

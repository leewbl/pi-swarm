/**
 * `/swarm` command surface (PRD FR-1, FR-3, FR-18 through FR-20; architecture
 * §20): init | role <role> | status | tasks | agents | recover [taskId] |
 * doctor. This layer only orchestrates — stores, services, and the runtime
 * come from injected seams (compose.buildSwarmStack / createSwarmRuntime)
 * so the module stays unit-testable against fakes.
 */
import path from "node:path";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type {
  AgentIdentity,
  AgentManifest,
  PresenceRecord,
  TaskDocument,
  TaskStatus,
} from "../protocol/schemas.js";
import { AgentManifestSchema, normalizeAgentManifest } from "../protocol/schemas.js";
import { nowIso } from "../util/clock.js";
import { locateSwarmRoot, SwarmPaths } from "../util/paths.js";
import { tryCreateExclusive } from "../util/atomic-file.js";
import type { Logger } from "../util/logger.js";
import { createOmpWakePort, ctxTimerPort } from "./pi-api.js";
import type { CtxRef, PiCtxLike, PiLike } from "./pi-api.js";
import {
  defaultIsProcessAlive,
  getActiveBinding,
  newIdentityLocally,
  persistBinding,
  setActiveBinding,
} from "./binding.js";
import type { RuntimeHandle, RuntimeInitArgs } from "./binding.js";
import { renderDoctorReport, runDoctor } from "./doctor.js";
import { formatZodError } from "./tools.js";
import type { SwarmStack } from "./compose.js";

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));

export const AGENT_TEMPLATE_ROLES = [
  "coordinator",
  "architect",
  "researcher",
  "frontend",
  "backend",
  "tester",
] as const;

export interface SwarmCommandDeps {
  /** Composition seam — compose.buildSwarmStack in production. */
  buildStack: (workspaceRoot: string, opts?: { instanceId?: string }) => Promise<SwarmStack>;
  /** Runtime factory seam — runtime.createSwarmRuntime in production. */
  createRuntime: (args: RuntimeInitArgs) => RuntimeHandle;
  /** Identity factory seam — runtime.newIdentity in production. */
  newIdentity?: (role: string, pid: number, sessionId?: string) => AgentIdentity;
  now?: () => string;
  logger?: Logger;
  isProcessAlive?: (pid: number) => boolean;
  ctxRef?: CtxRef;
}

export interface BindRoleResult {
  ok: boolean;
  message: string;
  instanceId?: string;
}

function notify(ctx: PiCtxLike, message: string, level: "info" | "warn" | "error" = "info"): void {
  ctx.ui?.notify?.(message, level);
}

function ageSeconds(iso: string, nowIsoValue: string): number {
  return Math.max(0, Math.round((Date.parse(nowIsoValue) - Date.parse(iso)) / 1000));
}

/** First Markdown heading of a task body, falling back to the first line. */
export function taskHeading(body: string): string {
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading?.[1] !== undefined) return heading[1].trim();
  const firstLine = body.split("\n").find((line) => line.trim().length > 0);
  return (firstLine ?? "").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function loadTemplate(rel: string): Promise<string> {
  return fsp.readFile(path.join(TEMPLATES_DIR, rel), "utf8");
}

async function materialize(target: string, content: string, rel: string): Promise<string> {
  const created = await tryCreateExclusive(target, content);
  return created ? `[ok] created ${rel}` : `[skip] existing ${rel}`;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function runInit(ctx: PiCtxLike): Promise<void> {
  const located = await locateSwarmRoot(ctx.cwd);
  const paths = located ?? new SwarmPaths(ctx.cwd);
  await paths.ensureLayout();
  const lines: string[] = [`Swarm workspace: ${paths.swarmRoot}`];

  lines.push(await materialize(paths.swarmConfigFile(), await loadTemplate("swarm.yaml"), "swarm.yaml"));
  for (const role of AGENT_TEMPLATE_ROLES) {
    const rel = `agents/${role}.yaml`;
    const text = await loadTemplate(`agents/${role}.yaml`);
    const parsed = AgentManifestSchema.safeParse(parseYaml(text));
    if (!parsed.success) {
      lines.push(`[error] template ${rel} failed schema validation: ${formatZodError(parsed.error)} — not written`);
      continue;
    }
    lines.push(await materialize(paths.agentManifestFile(role), text, rel));
  }
  notify(ctx, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// role binding
// ---------------------------------------------------------------------------

interface DuplicateCheck {
  nowIsoValue: string;
  staleMs: number;
  ownPid: number;
  isProcessAlive: (pid: number) => boolean;
}

function findActiveDuplicate(
  records: readonly PresenceRecord[],
  role: string,
  check: DuplicateCheck,
): PresenceRecord | null {
  for (const record of records) {
    if (record.role !== role || record.state === "stopped") continue;
    // Rebinding this same session (same pid) replaces its own instance.
    if (record.pid === check.ownPid) continue;
    const heartbeatFresh =
      Date.parse(check.nowIsoValue) - Date.parse(record.heartbeatAt) <= check.staleMs;
    if (heartbeatFresh && check.isProcessAlive(record.pid)) return record;
  }
  return null;
}

/**
 * Validate and bind this session to `role` (command path and session_start
 * re-bind): duplicate-active-role check, presence upsert, per-instance stack,
 * runtime with OMP wake + managed timers, durable binding marker.
 */
export async function bindRole(
  pi: PiLike,
  ctx: PiCtxLike,
  role: string,
  deps: SwarmCommandDeps,
): Promise<BindRoleResult> {
  if (role.length === 0) {
    return { ok: false, message: "Usage: /swarm role <role> (see /swarm agents)" };
  }
  const paths = await locateSwarmRoot(ctx.cwd);
  if (!paths) {
    return {
      ok: false,
      message: `No swarm workspace found at or above ${ctx.cwd}. Run /swarm init first.`,
    };
  }
  const now = deps.now ?? nowIso;
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;

  const stack = await deps.buildStack(paths.workspaceRoot);
  const manifests = await stack.stores.manifest.list();
  const manifestDoc: AgentManifest | undefined = manifests.find((m) => m.agent.role === role);
  if (!manifestDoc) {
    const available = manifests.map((m) => m.agent.role).join(", ");
    return {
      ok: false,
      message: `Unknown role "${role}". Available roles: ${available || "(none — check agents/)"}`,
    };
  }
  const manifest = normalizeAgentManifest(manifestDoc);

  const duplicate = findActiveDuplicate(await stack.stores.presence.list(), role, {
    nowIsoValue: now(),
    staleMs: stack.config.runtime.presenceStaleMs,
    ownPid: process.pid,
    isProcessAlive,
  });
  if (duplicate) {
    return {
      ok: false,
      message:
        `Role "${role}" already has an active instance: ${duplicate.instanceId} (pid ${duplicate.pid}, ` +
        `state ${duplicate.state}, heartbeat ${ageSeconds(duplicate.heartbeatAt, now())}s ago). ` +
        "Stop that session, or bind this session to a different role.",
    };
  }

  const identity = deps.newIdentity ? deps.newIdentity(role, process.pid) : newIdentityLocally(role);
  const startedAt = now();
  await stack.stores.presence.upsert({
    version: 1,
    role,
    instanceId: identity.instanceId,
    ...(identity.sessionId !== undefined ? { sessionId: identity.sessionId } : {}),
    pid: identity.pid,
    state: "idle",
    heartbeatAt: startedAt,
    startedAt,
  });

  // Event-store ownership: build the session's stack under its own instanceId.
  const ownStack = await deps.buildStack(paths.workspaceRoot, { instanceId: identity.instanceId });
  const runtime = deps.createRuntime({
    identity,
    manifest,
    config: ownStack.config,
    taskService: ownStack.services.task,
    taskStore: ownStack.stores.task,
    eventStore: ownStack.stores.event,
    cursorStore: ownStack.stores.cursor,
    presenceStore: ownStack.stores.presence,
    wake: createOmpWakePort(pi, () => deps.ctxRef?.get() ?? ctx),
    timers: ctxTimerPort(ctx),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
  await runtime.start?.();
  setActiveBinding({ role, identity, manifest, stack: ownStack, runtime });
  persistBinding(pi, role);
  return {
    ok: true,
    message:
      `Bound to role ${role} as ${identity.instanceId}. ` +
      "The role contract is injected before each agent run; task tools are now available.",
    instanceId: identity.instanceId,
  };
}

// ---------------------------------------------------------------------------
// status / tasks / agents
// ---------------------------------------------------------------------------

function countByStatus(statuses: readonly TaskStatus[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

async function presenceTable(stack: SwarmStack, nowIsoValue: string): Promise<string[]> {
  const records = await stack.stores.presence.list();
  if (records.length === 0) return ["Presence: (no instances)"];
  return [
    "Presence:",
    "  role            state     heartbeat  instance",
    ...records.map(
      (r) =>
        `  ${r.role.padEnd(16)} ${r.state.padEnd(9)} ${`${ageSeconds(r.heartbeatAt, nowIsoValue)}s`.padEnd(10)} ${r.instanceId}`,
    ),
  ];
}

async function runStatus(ctx: PiCtxLike, deps: SwarmCommandDeps): Promise<void> {
  const now = deps.now ?? nowIso;
  const active = getActiveBinding();
  if (!active) {
    const paths = await locateSwarmRoot(ctx.cwd);
    if (!paths) {
      notify(
        ctx,
        `Not bound to a swarm role, and no workspace found at or above ${ctx.cwd}.\nRun /swarm init, then /swarm role <role>.`,
      );
      return;
    }
    const stack = await deps.buildStack(paths.workspaceRoot);
    const counts = countByStatus(
      (await stack.services.task.list({ statuses: ["open", "claimed", "in_progress"] })).map(
        (v) => v.metadata.status,
      ),
    );
    notify(
      ctx,
      [
        "Not bound to a swarm role. Run /swarm role <role> (see /swarm agents).",
        "",
        `Tasks: ${counts.open ?? 0} open / ${counts.claimed ?? 0} claimed / ${counts.in_progress ?? 0} in_progress`,
        ...(await presenceTable(stack, now())),
      ].join("\n"),
    );
    return;
  }
  const st = active.runtime.status();
  const counts = countByStatus(
    (await active.stack.services.task.list({ statuses: ["open", "claimed", "in_progress"] })).map(
      (v) => v.metadata.status,
    ),
  );
  notify(
    ctx,
    [
      `Role: ${active.role} (${active.manifest.name})`,
      `Instance: ${active.identity.instanceId}`,
      `Runtime: running=${String(st.running)} pendingWake=${st.pendingWake} consumedEvents=${st.consumedEvents}`,
      `Loops: lastTaskScan=${st.lastTaskScanAt ?? "never"} lastEventPoll=${st.lastEventPollAt ?? "never"}`,
      "",
      `Tasks: ${counts.open ?? 0} open / ${counts.claimed ?? 0} claimed / ${counts.in_progress ?? 0} in_progress`,
      ...(await presenceTable(active.stack, now())),
    ].join("\n"),
  );
}

async function resolveWorkspaceStack(
  ctx: PiCtxLike,
  deps: SwarmCommandDeps,
  purpose: string,
): Promise<SwarmStack | null> {
  const active = getActiveBinding();
  if (active) return active.stack;
  const paths = await locateSwarmRoot(ctx.cwd);
  if (!paths) {
    notify(
      ctx,
      `No swarm workspace found at or above ${ctx.cwd}. Run /swarm init first (needed to ${purpose}).`,
      "error",
    );
    return null;
  }
  return deps.buildStack(paths.workspaceRoot);
}

async function runTasks(ctx: PiCtxLike, deps: SwarmCommandDeps): Promise<void> {
  const stack = await resolveWorkspaceStack(ctx, deps, "list tasks");
  if (!stack) return;
  const docs: TaskDocument[] = await stack.stores.task.list();
  if (docs.length === 0) {
    notify(ctx, "No tasks. Create one with the swarm_task_create tool.");
    return;
  }
  const claims = new Map(
    (await stack.stores.claim.list()).map((c) => [c.taskId, c.agent.role] as const),
  );
  const sorted = [...docs].sort((a, b) => a.metadata.id.localeCompare(b.metadata.id));
  const lines = [
    "  id          status       pri  claimant    title",
    ...sorted.map(
      (doc) =>
        `  ${doc.metadata.id.padEnd(12)} ${doc.metadata.status.padEnd(12)} ${String(doc.metadata.priority).padEnd(4)} ${(claims.get(doc.metadata.id) ?? "—").padEnd(11)} ${truncate(taskHeading(doc.body), 48)}`,
    ),
  ];
  notify(ctx, lines.join("\n"));
}

async function runAgents(ctx: PiCtxLike, deps: SwarmCommandDeps): Promise<void> {
  const stack = await resolveWorkspaceStack(ctx, deps, "list agents");
  if (!stack) return;
  const manifests = await stack.stores.manifest.list();
  if (manifests.length === 0) {
    notify(ctx, "No role manifests found under agents/.");
    return;
  }
  const presence = (await stack.stores.presence.list()).filter((p) => p.state !== "stopped");
  const nowIsoValue = (deps.now ?? nowIso)();
  const lines = manifests.map((m) => {
    const forRole = presence.filter((p) => p.role === m.agent.role);
    const latest =
      forRole.length > 0
        ? forRole.reduce((a, b) => (a.heartbeatAt >= b.heartbeatAt ? a : b))
        : null;
    const state = latest
      ? `${latest.state} (${ageSeconds(latest.heartbeatAt, nowIsoValue)}s)`
      : "no active instance";
    return `  ${m.agent.role.padEnd(14)} ${m.agent.name.padEnd(22)} ${state}`;
  });
  notify(ctx, ["Role manifests:", ...lines].join("\n"));
}

// ---------------------------------------------------------------------------
// recover / doctor
// ---------------------------------------------------------------------------

async function runRecover(ctx: PiCtxLike, deps: SwarmCommandDeps, taskId?: string): Promise<void> {
  const stack = await resolveWorkspaceStack(ctx, deps, "recover");
  if (!stack) return;
  const active = getActiveBinding();
  const report = await stack.services.recovery.scan();
  const lines = [
    `Recovery scan: ${report.orphans.length} orphan(s), ${report.suspects.length} suspect(s), ${report.inconsistencies.length} inconsistency(ies), ${report.staleInstances.length} stale instance(s)`,
  ];

  if (taskId !== undefined) {
    if (!active) {
      notify(
        ctx,
        "recover <taskId> needs a bound role for event attribution. Run /swarm role <role> first.",
        "error",
      );
      return;
    }
    const result = await stack.services.recovery.recoverTask(taskId, active.identity);
    lines.push(
      result.ok
        ? `  ${taskId}: ${result.action?.action ?? "recovered"} — ${result.action?.detail ?? ""}`
        : `  ${taskId}: ${result.message}`,
    );
    notify(ctx, lines.join("\n"), result.ok ? "info" : "error");
    return;
  }

  for (const c of report.inconsistencies) lines.push(`  inconsistency ${c.taskId}: ${c.kind} — ${c.detail}`);
  for (const o of report.orphans) {
    lines.push(`  orphan ${o.taskId}: claimant ${o.claim.agent.instanceId} stale and dead`);
  }
  for (const s of report.suspects) {
    lines.push(`  suspect ${s.taskId}: claimant ${s.claim.agent.instanceId} alive — not auto-recovered`);
  }
  for (const r of await stack.services.recovery.reconcile()) {
    lines.push(`  reconciled ${r.taskId}: ${r.repaired}`);
  }
  if (active) {
    for (const a of await stack.services.recovery.recoverOrphans(active.identity)) {
      lines.push(`  recovered ${a.taskId}: ${a.action} — ${a.detail}`);
    }
  } else if (report.orphans.length > 0) {
    lines.push("  note: orphan recovery requires a bound role (/swarm role <role>)");
  }
  notify(ctx, lines.join("\n"));
}

async function runDoctorCommand(ctx: PiCtxLike, deps: SwarmCommandDeps): Promise<void> {
  const stack = await resolveWorkspaceStack(ctx, deps, "run doctor");
  if (!stack) return;
  const report = await runDoctor(stack, {
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.isProcessAlive !== undefined ? { isProcessAlive: deps.isProcessAlive } : {}),
  });
  notify(ctx, renderDoctorReport(report), report.errors > 0 ? "error" : "info");
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

const USAGE = [
  "Usage: /swarm <command>",
  "  init              create or repair the swarm workspace (.pi/swarm)",
  "  role <role>       bind this session to a role manifest",
  "  status            bound role, runtime state, task counts, presence",
  "  tasks             all tasks with claimants",
  "  agents            role manifests and live instances",
  "  recover [taskId]  scan + reconcile + recover orphans, or recover one task",
  "  doctor            workspace diagnostics",
].join("\n");

export function registerSwarmCommands(pi: PiLike, deps: SwarmCommandDeps): void {
  pi.registerCommand("swarm", {
    description: "Pi Swarm: init | role <role> | status | tasks | agents | recover | doctor",
    handler: (args, ctx) => handleSwarmCommand(pi, ctx, args ?? [], deps),
  });
}

async function handleSwarmCommand(
  pi: PiLike,
  ctx: PiCtxLike,
  args: readonly string[],
  deps: SwarmCommandDeps,
): Promise<void> {
  deps.ctxRef?.set(ctx);
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case "init":
        await runInit(ctx);
        return;
      case "role": {
        const result = await bindRole(pi, ctx, rest[0] ?? "", deps);
        notify(ctx, result.message, result.ok ? "info" : "error");
        return;
      }
      case "status":
        await runStatus(ctx, deps);
        return;
      case "tasks":
        await runTasks(ctx, deps);
        return;
      case "agents":
        await runAgents(ctx, deps);
        return;
      case "recover":
        await runRecover(ctx, deps, rest[0]);
        return;
      case "doctor":
        await runDoctorCommand(ctx, deps);
        return;
      default:
        notify(ctx, USAGE, "warn");
        return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger?.error(`swarm ${sub ?? ""} failed`, { error: message });
    notify(ctx, `/swarm ${sub ?? ""} failed: ${message}`, "error");
  }
}

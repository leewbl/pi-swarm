/**
 * `/swarm doctor` (PRD FR-20): read-only workspace diagnostics — layout,
 * manifest schemas, duplicate active role instances, task validity,
 * claim/task consistency, orphan/suspect claims, JSONL integrity, cursor
 * validity, blackboard permission configuration, and the atomic-create
 * capability probe. Doctor never mutates state (the probe file is created and
 * immediately removed).
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { fileExists, readFileIfExists, tryCreateExclusive } from "../util/atomic-file.js";
import { nowIso } from "../util/clock.js";
import { ulid } from "../util/ulid.js";
import { CursorStateSchema, normalizeAgentManifest } from "../protocol/schemas.js";
import type { PresenceRecord } from "../protocol/schemas.js";
import { buildActiveTopology } from "../domain/topology.js";
import { classifyTaskServiceability } from "../domain/serviceability.js";
import { evaluateLiveness } from "../domain/liveness-service.js";
import { defaultIsProcessAlive } from "./binding.js";
import type { SwarmStack } from "./compose.js";

export type DoctorLevel = "error" | "warning" | "info" | "ok";

export interface DoctorFinding {
  level: DoctorLevel;
  check: string;
  message: string;
  hint?: string;
}

export interface DoctorReport {
  findings: DoctorFinding[];
  errors: number;
  warnings: number;
}

export interface DoctorOptions {
  now?: () => string;
  isProcessAlive?: (pid: number) => boolean;
}

interface AddFinding {
  (level: DoctorLevel, check: string, message: string, hint?: string): void;
}

function zodMessage(err: ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "value"}: ${issue.message}`)
    .join("; ");
}

async function checkLayout(stack: SwarmStack, add: AddFinding): Promise<void> {
  const { paths } = stack;
  const required: [string, string][] = [
    ["agents", paths.agentsDir],
    ["tasks", paths.tasksDir],
    ["claims", paths.claimsDir],
    ["events", paths.eventsDir],
    ["blackboard", paths.blackboardDir],
    ["artifacts", paths.artifactsDir],
    ["runtime", paths.runtimeDir],
    ["runtime/instances", paths.instancesDir],
    ["runtime/cursors", paths.cursorsDir],
  ];
  for (const [label, dir] of required) {
    const isDir = await fsp.stat(dir).then((s) => s.isDirectory()).catch(() => false);
    if (!isDir) {
      add("error", "layout", `missing directory ${label}/`, "run /swarm init to repair the layout");
    }
  }
  if (!(await fileExists(paths.swarmConfigFile()))) {
    add("warning", "layout", "swarm.yaml is missing", "run /swarm init (it never overwrites existing files)");
  }
}

async function checkManifests(stack: SwarmStack, add: AddFinding): Promise<void> {
  const issues = await stack.stores.manifest.validate();
  for (const issue of issues) {
    add("error", "manifests", `${issue.file}: ${issue.error}`, "fix the YAML fields listed above; invalid manifests are skipped by the runtime");
  }
  if (issues.length === 0 && (await stack.stores.manifest.list()).length === 0) {
    add("warning", "manifests", "no role manifests found under agents/", "run /swarm init to install the built-in templates");
  }
}

async function checkPresenceDuplicates(
  stack: SwarmStack,
  add: AddFinding,
  nowIsoValue: string,
  isProcessAlive: (pid: number) => boolean,
): Promise<void> {
  const records = await stack.stores.presence.list();
  const staleMs = stack.config.runtime.presenceStaleMs;
  const nowMs = Date.parse(nowIsoValue);
  const byRole = new Map<string, PresenceRecord[]>();
  for (const record of records) {
    if (record.state === "stopped") continue;
    const list = byRole.get(record.role) ?? [];
    list.push(record);
    byRole.set(record.role, list);
  }
  for (const [role, recs] of byRole) {
    const fresh = recs.filter(
      (r) => nowMs - Date.parse(r.heartbeatAt) <= staleMs && isProcessAlive(r.pid),
    );
    if (fresh.length > 1) {
      add(
        "error",
        "presence",
        `role ${role} has ${fresh.length} active instances (${fresh.map((r) => `${r.instanceId} pid ${r.pid}`).join(", ")})`,
        "stop all but one session, or bind one session to a different role with /swarm role",
      );
    }
    for (const r of recs) {
      if (!fresh.includes(r)) {
        add("info", "presence", `stale instance record ${r.instanceId} (role ${role}, state ${r.state})`, "run /swarm recover to inspect");
      }
    }
  }
}

async function checkTasks(stack: SwarmStack, add: AddFinding): Promise<void> {
  for (const issue of await stack.stores.task.issues()) {
    add("error", "tasks", `${issue.file}: ${issue.error}`, "fix the front matter; the scan loop skips malformed files");
  }
}

async function checkConsistency(stack: SwarmStack, add: AddFinding): Promise<void> {
  const report = await stack.services.recovery.scan();
  for (const c of report.inconsistencies) {
    add("warning", "consistency", `task ${c.taskId}: ${c.kind} — ${c.detail}`, "run /swarm recover to reconcile claim/task drift");
  }
  for (const o of report.orphans) {
    add("warning", "consistency", `orphan claim on ${o.taskId} (claimant ${o.claim.agent.instanceId} stale and dead)`, "run /swarm recover to abandon and reopen");
  }
  for (const s of report.suspects) {
    add("info", "consistency", `suspect claim on ${s.taskId} (claimant ${s.claim.agent.instanceId} alive but heartbeat stale) — never auto-recovered while alive`);
  }
  for (const i of report.staleInstances) {
    add("info", "consistency", `stale instance ${i.instanceId} (role ${i.role})`);
  }
}

async function checkStreams(stack: SwarmStack, add: AddFinding): Promise<void> {
  for (const producer of await stack.stores.event.listStreams()) {
    const result = await stack.stores.event.readFrom(producer, 0);
    for (const m of result.malformed) {
      add("error", "events", `events/${producer}.jsonl line ${m.line}: ${m.error}`, "malformed lines are skipped automatically; inspect the file if this persists");
    }
    if (result.trailingIncomplete) {
      add("warning", "events", `events/${producer}.jsonl has an incomplete trailing line`, "normal after a crash mid-append; it is retried once completed");
    }
  }
}

async function checkCursors(stack: SwarmStack, add: AddFinding): Promise<void> {
  const cursorFiles = (await fsp.readdir(stack.paths.cursorsDir).catch(() => [] as string[])).filter(
    (f) => f.endsWith(".json"),
  );
  for (const file of cursorFiles) {
    const consumer = file.replace(/\.json$/, "");
    const raw = await readFileIfExists(path.join(stack.paths.cursorsDir, file));
    if (raw === null) continue;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      add("error", "cursors", `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, `delete runtime/cursors/${file} to rescan from offset 0`);
      continue;
    }
    const parsed = CursorStateSchema.safeParse(parsedJson);
    if (!parsed.success) {
      add("error", "cursors", `${file} fails cursor schema: ${zodMessage(parsed.error)}`, `delete runtime/cursors/${file} to rescan from offset 0`);
      continue;
    }
    for (const [streamFile, cursor] of Object.entries(parsed.data.streams)) {
      const producer = streamFile.replace(/\.jsonl$/, "");
      const size = await stack.stores.event.streamSize(producer).catch(() => null);
      if (size === null) {
        add("info", "cursors", `${file} references unknown stream ${streamFile}`, "harmless leftover; the stream may belong to a removed instance");
        continue;
      }
      if (cursor.offset > size) {
        add("warning", "cursors", `cursor ${consumer} offset ${cursor.offset} is beyond stream ${streamFile} size ${size}`, `stream may have been truncated; delete runtime/cursors/${file} to rescan`);
      }
    }
  }
}

async function checkBlackboardConfig(stack: SwarmStack, add: AddFinding): Promise<void> {
  for (const manifest of await stack.stores.manifest.list()) {
    const normalized = normalizeAgentManifest(manifest);
    if (normalized.blackboard.write.length === 0) {
      add("info", "blackboard", `role ${normalized.role} has no blackboard write permissions`, `edit agents/${normalized.role}.yaml blackboard.write if this role should publish notes`);
    }
  }
}

async function checkAtomicCreate(stack: SwarmStack, add: AddFinding): Promise<void> {
  const probePath = path.join(stack.paths.claimsDir, `.probe-${ulid()}.yaml`);
  try {
    const created = await tryCreateExclusive(probePath, "probe\n");
    await fsp.rm(probePath, { force: true });
    if (created) {
      add("ok", "atomic-create", "exclusive create (O_EXCL) works — atomic claims are supported");
    } else {
      add("warning", "atomic-create", "probe file unexpectedly already existed", "unexpected, but exclusive create itself is supported");
    }
  } catch (err) {
    add(
      "error",
      "atomic-create",
      `filesystem cannot support atomic claims: ${err instanceof Error ? err.message : String(err)}`,
      "claims require O_EXCL support on this filesystem; check the workspace location and permissions",
    );
  }
}

async function checkObligations(stack: SwarmStack, add: AddFinding): Promise<void> {
  const tasks = await stack.stores.task.list();
  const statusIndex = new Map(tasks.map((t) => [t.metadata.id, t.metadata.status] as const));
  for (const task of tasks) {
    const meta = task.metadata;
    if (meta.status !== "blocked") continue;
    for (const obligation of meta.blockedOn) {
      if (!statusIndex.has(obligation)) {
        add(
          "error",
          "obligations",
          `blocked task ${meta.id} references missing obligation ${obligation}`,
          "remove the stale blockedOn entry or recreate the referenced work",
        );
      }
    }
    const allDone =
      meta.blockedOn.length > 0 && meta.blockedOn.every((id) => statusIndex.get(id) === "done");
    if (allDone) {
      add(
        "warning",
        "obligations",
        `blocked task ${meta.id} has all obligations done but has not resumed`,
        "run /swarm recover to reconcile and resume it",
      );
    }
  }
  for (const task of tasks) {
    const meta = task.metadata;
    if (meta.workDomain === undefined && meta.eligibleRoles !== undefined) {
      add(
        "info",
        "obligations",
        `task ${meta.id} uses legacy eligibleRoles without workDomain`,
        "legacy tasks keep the role-gate path; new tasks should use workDomain + constraints",
      );
    }
  }
}

async function checkServiceability(
  stack: SwarmStack,
  add: AddFinding,
  nowIsoValue: string,
): Promise<void> {
  const [tasks, presence, manifests, claims] = await Promise.all([
    stack.stores.task.list(),
    stack.stores.presence.list(),
    stack.stores.manifest.list(),
    stack.stores.claim.list(),
  ]);
  for (const manifest of manifests) {
    const normalized = normalizeAgentManifest(manifest);
    if (normalized.primaryDomains.length === 0) {
      add(
        "warning",
        "domains",
        `role ${normalized.role} declares no primary domains`,
        "set domains.primary in agents/<role>.yaml or remove the explicit empty list",
      );
    }
  }
  const topology = buildActiveTopology(presence, manifests, {
    nowIso: nowIsoValue,
    presenceStaleMs: stack.config.runtime.presenceStaleMs,
  });
  const statusIndex = new Map(tasks.map((t) => [t.metadata.id, t.metadata.status] as const));
  const claimed = new Set(claims.map((c) => c.taskId));
  for (const task of tasks) {
    const view = classifyTaskServiceability(task, topology, {
      nowIso: nowIsoValue,
      claimExists: claimed.has(task.metadata.id),
      sourceClaimantInstanceIds: [],
      statusIndex,
    });
    if (view.state === "unserviceable") {
      add(
        "warning",
        "serviceability",
        `task ${view.taskId} is unserviceable: ${view.reason}`,
        "start an agent with the missing capability, widen fallback, or redefine the task",
      );
    }
  }
  const report = evaluateLiveness({
    nowIso: nowIsoValue,
    warningAfterMs: stack.config.liveness.warningAfterMs,
    tasks,
    claims,
    topology,
    statusIndex,
  });
  for (const finding of report.stalled) {
    add(
      "warning",
      "liveness",
      `task ${finding.taskId} is due and serviceable but stalled: ${finding.reason}`,
      "eligible agents are not claiming; check their sessions or run /swarm recover",
    );
  }
}

export async function runDoctor(stack: SwarmStack, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const now = opts.now ?? nowIso;
  const isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  const findings: DoctorFinding[] = [];
  const add: AddFinding = (level, check, message, hint) => {
    findings.push({ level, check, message, ...(hint !== undefined ? { hint } : {}) });
  };
  const checks: [string, () => Promise<void>][] = [
    ["layout", () => checkLayout(stack, add)],
    ["manifests", () => checkManifests(stack, add)],
    ["presence", () => checkPresenceDuplicates(stack, add, now(), isProcessAlive)],
    ["tasks", () => checkTasks(stack, add)],
    ["consistency", () => checkConsistency(stack, add)],
    ["obligations", () => checkObligations(stack, add)],
    ["serviceability", () => checkServiceability(stack, add, now())],
    ["events", () => checkStreams(stack, add)],
    ["cursors", () => checkCursors(stack, add)],
    ["blackboard", () => checkBlackboardConfig(stack, add)],
    ["atomic-create", () => checkAtomicCreate(stack, add)],
  ];
  for (const [name, run] of checks) {
    try {
      await run();
    } catch (err) {
      add("error", name, `check crashed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    findings,
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warning").length,
  };
}

const LEVEL_TAGS: Record<DoctorLevel, string> = {
  error: "[error]",
  warning: "[warn] ",
  info: "[info] ",
  ok: "[ok]   ",
};

export function renderDoctorReport(report: DoctorReport): string {
  const lines = [
    `Swarm doctor — ${report.errors} error(s), ${report.warnings} warning(s), ${report.findings.length} finding(s)`,
  ];
  for (const finding of report.findings) {
    lines.push(`${LEVEL_TAGS[finding.level]} ${finding.check}: ${finding.message}`);
    if (finding.hint !== undefined) {
      lines.push(`        hint: ${finding.hint}`);
    }
  }
  return lines.join("\n");
}

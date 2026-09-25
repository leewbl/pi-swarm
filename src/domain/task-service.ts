/**
 * Task domain service (PRD Workstream B + structural liveness fix): creation,
 * discovery, atomic claim, lifecycle transitions (including `blocked`), and
 * obligation-driven resume. All mutations are funneled through the stores;
 * events carry signals (references, not payloads). The claim record is the
 * canonical ownership truth — the Markdown status update after a successful
 * claim is best-effort and repaired by the reconciler (architecture §9.5).
 *
 * Liveness rules (fix §2/§9/§13/§15):
 * - claim() RE-RESOLVES the current topology for tasks with a workDomain —
 *   a stale poll result never crosses an active specialist boundary;
 * - tasks with unresolved `blockedOn` obligations are not actionable;
 * - completing an obligation resumes every parent it unblocks (blocked ->
 *   in_progress with the claim retained, or -> open when the claim is lost);
 * - verification contradictions create rework work; `done` history is never
 *   silently rewritten (Invariant I).
 */
import type {
  ClaimOutcome,
  CreateTaskInput,
  CreateTaskResult,
  EventService,
  LifecycleResult,
  PolicyService,
  TaskListQuery,
  TaskService,
  TaskView,
} from "./types.js";
import type { IneligibleReason } from "./types.js";
import { TaskExistsError } from "../storage/types.js";
import type { ClaimStore, ManifestStore, PresenceStore, TaskStore } from "../storage/types.js";
import type {
  AgentIdentity,
  ClaimRecord,
  NormalizedAgentManifest,
  SwarmConfig,
  TaskDocument,
  TaskStatus,
} from "../protocol/schemas.js";
import {
  DOMAIN_RE,
  ISO_TIME_RE,
  TASK_ID_RE,
  TASK_TRANSITIONS,
  ROLE_ID_RE,
} from "../protocol/schemas.js";
import { buildActiveTopology } from "./topology.js";
import type { ActiveTopology } from "./topology.js";
import {
  isEligibleCandidate,
  resolveTaskCandidates,
} from "./candidate-resolver.js";
import type { CandidateResolution, CandidateTier } from "./candidate-resolver.js";
import { ulid } from "../util/ulid.js";
import { nowIso } from "../util/clock.js";

export interface TaskServiceDeps {
  taskStore: TaskStore;
  claimStore: ClaimStore;
  policy: PolicyService;
  eventService: EventService;
  /** Presence records for claim-time topology re-resolution (workDomain tasks). */
  presenceStore?: PresenceStore;
  /** Manifests for claim-time topology re-resolution (workDomain tasks). */
  manifestStore?: ManifestStore;
  /** Workspace config: staleness window + global fallback gate. */
  config?: SwarmConfig;
  /** Optional local-host PID probe: dead processes never hold boundaries. */
  isProcessAlive?: (pid: number) => boolean;
  now?: () => string;
}

const MAX_TITLE_CHARS = 200;
const MAX_ID_ATTEMPTS = 3;

/** Input shape after create() validation, with all defaults resolved. */
interface ValidatedCreate {
  title: string;
  body: string;
  kind: string;
  priority: number;
  eligibleRoles?: string[];
  requiredCapabilities?: string[];
  workDomain?: string;
  preferredCapabilities?: string[];
  hardRequirements?: { capabilities: string[] };
  constraints?: { excludeTaskAuthor?: boolean; excludeCurrentClaimant?: boolean };
  fallback?: { allowed?: boolean };
  availableAt?: string;
  dependsOn: string[];
  parentTask?: string;
  origin?: { type: string; sourceTaskId?: string; requestKey?: string };
  inputs: string[];
}

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

export function createTaskService(deps: TaskServiceDeps): TaskService {
  return new TaskServiceImpl(deps);
}

class TaskServiceImpl implements TaskService {
  private readonly now: () => string;

  constructor(private readonly deps: TaskServiceDeps) {
    this.now = deps.now ?? nowIso;
  }

  async create(input: CreateTaskInput, by: AgentIdentity): Promise<CreateTaskResult> {
    const validated = validateCreate(input);
    if (!validated.ok) {
      return { ok: false, code: "invalid_input", message: validated.message };
    }
    const v = validated.value;

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const id = await this.deps.taskStore.nextTaskId();
      const ts = this.now();
      const task: TaskDocument = {
        metadata: {
          id,
          status: "open",
          kind: v.kind,
          priority: v.priority,
          ...(v.eligibleRoles !== undefined ? { eligibleRoles: v.eligibleRoles } : {}),
          ...(v.requiredCapabilities !== undefined ? { requiredCapabilities: v.requiredCapabilities } : {}),
          ...(v.workDomain !== undefined ? { workDomain: v.workDomain } : {}),
          ...(v.preferredCapabilities !== undefined
            ? { preferredCapabilities: v.preferredCapabilities }
            : {}),
          ...(v.hardRequirements !== undefined ? { hardRequirements: v.hardRequirements } : {}),
          ...(v.constraints !== undefined ? { constraints: v.constraints } : {}),
          ...(v.fallback !== undefined ? { fallback: { allowed: v.fallback.allowed ?? true } } : {}),
          ...(v.availableAt !== undefined ? { availableAt: v.availableAt } : {}),
          createdBy: { role: by.role, instanceId: by.instanceId },
          createdAt: ts,
          updatedAt: ts,
          ...(v.parentTask !== undefined ? { parentTask: v.parentTask } : {}),
          ...(v.origin !== undefined ? { origin: v.origin } : {}),
          dependsOn: v.dependsOn,
          blockedOn: [],
          inputs: v.inputs,
          outputs: [],
        },
        body: `# ${v.title}\n\n${v.body}`,
      };
      try {
        await this.deps.taskStore.save(task, { create: true });
      } catch (err) {
        // A concurrent creator won this id; re-allocate (last attempt rethrows).
        if (err instanceof TaskExistsError && attempt < MAX_ID_ATTEMPTS - 1) continue;
        throw err;
      }
      await this.deps.eventService.emit(
        {
          type: "task.opened",
          route: { mode: "broadcast", topic: "tasks" },
          context: { taskId: id },
          data: {
            taskId: id,
            title: v.title,
            kind: v.kind,
            priority: v.priority,
            ...(v.eligibleRoles !== undefined ? { eligibleRoles: v.eligibleRoles } : {}),
            ...(v.requiredCapabilities !== undefined
              ? { requiredCapabilities: v.requiredCapabilities }
              : {}),
            ...(v.workDomain !== undefined ? { workDomain: v.workDomain } : {}),
            ...(v.availableAt !== undefined ? { availableAt: v.availableAt } : {}),
            dependsOn: v.dependsOn,
          },
        },
        by,
      );
      return { ok: true, task };
    }
    // Unreachable: the last attempt either returned or threw.
    throw new Error("task id allocation exhausted");
  }

  async list(query: TaskListQuery): Promise<TaskView[]> {
    const tasks = await this.deps.taskStore.list();
    const statusIndex = new Map(tasks.map((t) => [t.metadata.id, t.metadata.status] as const));
    const claims = new Map((await this.deps.claimStore.list()).map((c) => [c.taskId, c] as const));
    const statuses = new Set(query.statuses ?? ["open", "claimed", "in_progress"]);
    const views: TaskView[] = [];

    // One topology + source-claimant preload per query for workDomain tasks
    // (both null when the topology deps are not configured).
    let topology: ActiveTopology | null = null;
    if (query.forAgent !== undefined && tasks.some((t) => t.metadata.workDomain !== undefined)) {
      topology = await this.buildTopology();
    }
    const sourceClaimants = new Map<string, string[]>();
    if (topology !== null) {
      for (const task of tasks) {
        const meta = task.metadata;
        if (!meta.constraints?.excludeCurrentClaimant) continue;
        const sourceId = meta.origin?.sourceTaskId ?? meta.parentTask;
        if (sourceId === undefined) continue;
        const sourceClaim = await this.deps.claimStore.get(sourceId);
        if (sourceClaim !== null) sourceClaimants.set(meta.id, [sourceClaim.agent.instanceId]);
      }
    }

    const decideFor = (
      task: TaskDocument,
      hasClaim: boolean,
    ): {
      eligible: boolean;
      reason?: IneligibleReason;
      detail?: string;
      tier?: CandidateTier;
    } => {
      if (task.metadata.workDomain === undefined) {
        const d = this.deps.policy.checkClaim(
          query.forAgent!.manifest,
          task,
          hasClaim,
          statusIndex,
          { now: this.now() },
        );
        return { eligible: d.eligible, reason: d.reason, detail: d.detail };
      }
      if (topology === null) {
        return {
          eligible: false,
          reason: "unserviceable" as IneligibleReason,
          detail: `task ${task.metadata.id} requires topology resolution but no presence/manifest stores are configured`,
        };
      }
      const resolution = resolveTaskCandidates(task, topology, {
        nowIso: this.now(),
        claimExists: hasClaim,
        sourceClaimantInstanceIds: sourceClaimants.get(task.metadata.id) ?? [],
        statusIndex,
        fallbackEnabled: this.deps.config?.scheduling.fallbackEnabled,
      });
      return resolutionDecision(resolution, query.forAgent!.identity.instanceId);
    };

    for (const task of [...tasks].sort((a, b) => a.metadata.id.localeCompare(b.metadata.id))) {
      if (!statuses.has(task.metadata.status)) continue;
      const claim = claims.get(task.metadata.id) ?? null;
      if (query.forAgent === undefined) {
        views.push({ metadata: task.metadata, claim, eligible: true });
        continue;
      }
      const decision = decideFor(task, claim !== null);
      if (decision.eligible) {
        views.push({
          metadata: task.metadata,
          claim,
          eligible: true,
          ...(decision.tier !== undefined ? { tier: decision.tier } : {}),
        });
        continue;
      }
      // Dependency-blocked tasks can be surfaced explicitly via
      // requireDependencies: false even when ineligible tasks are hidden.
      const dependencyOnly =
        decision.reason === "dependencies" || decision.reason === "not_due" || decision.reason === "blocked_on";
      const skip =
        query.includeIneligible !== true && !(dependencyOnly && query.requireDependencies === false);
      if (skip) continue;
      views.push({
        metadata: task.metadata,
        claim,
        eligible: false,
        ineligibleReason: decision.reason,
      });
    }
    return views;
  }

  async get(taskId: string): Promise<TaskView | null> {
    const task = await this.deps.taskStore.get(taskId);
    if (task === null) return null;
    return { metadata: task.metadata, claim: await this.deps.claimStore.get(taskId), eligible: true };
  }

  async claim(
    taskId: string,
    by: { identity: AgentIdentity; manifest: NormalizedAgentManifest },
  ): Promise<ClaimOutcome> {
    if (!TASK_ID_RE.test(taskId)) {
      return { status: "invalid_task", message: `invalid task id: ${taskId}` };
    }
    const task = await this.deps.taskStore.get(taskId);
    if (task === null) {
      return { status: "invalid_task", message: `task ${taskId} does not exist` };
    }
    const existing = await this.deps.claimStore.get(taskId);
    // Canonical ownership precedence (architecture §9.5): a live claim record
    // wins over the Markdown view. Terminal tasks keep their claim record as
    // history — the work is over, so report not_open rather than ownership.
    if (existing !== null) {
      const terminal =
        task.metadata.status === "done" ||
        task.metadata.status === "failed" ||
        task.metadata.status === "abandoned";
      if (terminal) {
        return { status: "not_open", message: `task ${taskId} is ${task.metadata.status}` };
      }
      return {
        status: "already_claimed",
        message: `task ${taskId} is claimed by ${existing.agent.role} (${existing.agent.instanceId})`,
      };
    }
    const statusIndex = new Map(
      (await this.deps.taskStore.list()).map((t) => [t.metadata.id, t.metadata.status] as const),
    );

    // Claim-time re-resolution (fix §25): rebuild the CURRENT topology and
    // confirm this agent is still an allowed candidate. A stale poll result
    // must never cross an active specialist boundary.
    if (task.metadata.workDomain !== undefined) {
      const resolution = await this.resolveNow(task, existing !== null, statusIndex);
      if (resolution.state === "not_actionable") {
        return { status: "not_open", message: resolution.reason };
      }
      if (resolution.state !== "legacy" && !isEligibleCandidate(resolution, by.identity.instanceId)) {
        return {
          status: "not_eligible",
          message: describeResolution(taskId, resolution, by.identity.role),
        };
      }
      if (resolution.state === "legacy") {
        // No topology deps configured: refuse to silently reinterpret.
        return {
          status: "not_eligible",
          message: `task ${taskId} requires topology resolution but no presence/manifest stores are configured`,
        };
      }
    } else {
      const decision = this.deps.policy.checkClaim(by.manifest, task, existing !== null, statusIndex, {
        now: this.now(),
      });
      if (!decision.eligible) {
        if (decision.reason === "status") {
          return { status: "not_open", message: decision.detail ?? `task ${taskId} is not open` };
        }
        return { status: "not_eligible", message: decision.detail ?? `not eligible for ${taskId}` };
      }
    }

    const claim: ClaimRecord = {
      version: 1,
      taskId,
      claimId: `CLM-${ulid()}`,
      agent: { role: by.identity.role, instanceId: by.identity.instanceId },
      ...(by.identity.sessionId !== undefined ? { sessionId: by.identity.sessionId } : {}),
      pid: by.identity.pid,
      claimedAt: this.now(),
    };
    const outcome = await this.deps.claimStore.tryClaim(claim);
    if (outcome.status === "already_claimed") {
      return { status: "already_claimed", message: `task ${taskId} was claimed by another agent` };
    }

    // Best-effort Markdown update: the claim file is canonical, and the
    // reconciler repairs the drift if this write (or the process) fails.
    const claimedTask: TaskDocument = {
      ...task,
      metadata: { ...task.metadata, status: "claimed", updatedAt: this.now() },
    };
    try {
      await this.deps.taskStore.save(claimedTask);
    } catch {
      // intentional: ownership is already durable in claims/<taskId>.yaml
    }
    await this.deps.eventService.emit(
      {
        type: "task.claimed",
        route: { mode: "broadcast", topic: "tasks" },
        context: { taskId },
        data: { taskId, claimantRole: by.identity.role, claimId: claim.claimId },
      },
      by.identity,
    );
    return { status: "claimed", claim, task: claimedTask };
  }

  async start(taskId: string, claimId: string, by: AgentIdentity): Promise<LifecycleResult> {
    const loaded = await this.loadOwned(taskId, claimId, by, "in_progress");
    if (!loaded.ok) return loaded;
    const task = await this.setStatus(loaded.task, "in_progress");
    await this.emitTaskEvent("task.started", task, by, { taskId: task.metadata.id });
    return { ok: true, task };
  }

  async complete(
    taskId: string,
    claimId: string,
    by: AgentIdentity,
    result: { summary?: string; outputs?: string[] },
  ): Promise<LifecycleResult> {
    const outputs = validateRefList(result?.outputs, "outputs");
    if (!outputs.ok) return { ok: false, code: "invalid_input", message: outputs.message };
    if (
      result?.summary !== undefined &&
      (typeof result.summary !== "string" || result.summary.trim().length === 0)
    ) {
      return { ok: false, code: "invalid_input", message: "summary must be a non-empty string" };
    }
    const loaded = await this.loadOwned(taskId, claimId, by, "done");
    if (!loaded.ok) return loaded;
    const merged = [...loaded.task.metadata.outputs];
    for (const ref of outputs.value) {
      if (!merged.includes(ref)) merged.push(ref);
    }
    const task: TaskDocument = {
      ...loaded.task,
      metadata: { ...loaded.task.metadata, status: "done", updatedAt: this.now(), outputs: merged },
      ...(result?.summary !== undefined
        ? { body: appendSection(loaded.task.body, "Completion", result.summary) }
        : {}),
    };
    await this.deps.taskStore.save(task);

    // Durable obligations: completing this task may unblock parents (fix
    // §13.4). Persist the resume BEFORE emitting events so a crash between
    // the two leaves consistent durable state.
    const resumed = await this.resumeUnblockedParents(taskId);

    await this.emitTaskEvent("task.completed", task, by, { taskId: task.metadata.id });
    for (const parent of resumed) {
      await this.deps.eventService.emit(
        {
          type: "task.unblocked",
          route:
            parent.claimantRole !== null
              ? { mode: "direct", role: parent.claimantRole }
              : { mode: "broadcast", topic: "tasks" },
          context: { taskId: parent.taskId },
          data: { taskId: parent.taskId, resolvedObligation: taskId, status: parent.status },
        },
        by,
      );
    }
    return { ok: true, task };
  }

  async fail(
    taskId: string,
    claimId: string,
    by: AgentIdentity,
    result: { reason: string },
  ): Promise<LifecycleResult> {
    if (typeof result?.reason !== "string" || result.reason.trim().length === 0) {
      return { ok: false, code: "invalid_input", message: "fail requires a non-empty reason" };
    }
    const loaded = await this.loadOwned(taskId, claimId, by, "failed");
    if (!loaded.ok) return loaded;
    const task: TaskDocument = {
      ...loaded.task,
      metadata: { ...loaded.task.metadata, status: "failed", updatedAt: this.now() },
      body: appendSection(loaded.task.body, "Failure", result.reason),
    };
    await this.deps.taskStore.save(task);
    await this.emitTaskEvent("task.failed", task, by, {
      taskId: task.metadata.id,
      reason: result.reason,
    });
    return { ok: true, task };
  }

  async abandon(
    taskId: string,
    claimId: string,
    by: AgentIdentity,
    result?: { reason?: string },
  ): Promise<LifecycleResult> {
    if (
      result?.reason !== undefined &&
      (typeof result.reason !== "string" || result.reason.trim().length === 0)
    ) {
      return { ok: false, code: "invalid_input", message: "reason must be a non-empty string" };
    }
    const loaded = await this.loadOwned(taskId, claimId, by, "abandoned");
    if (!loaded.ok) return loaded;
    // Persist first, then release ownership: a crash between the two leaves
    // "abandoned + claim", which recovery can clean up, instead of losing the
    // abandoned state to a reconciler "repair".
    const task = await this.setStatus(loaded.task, "abandoned");
    await this.deps.claimStore.remove(taskId, claimId);
    await this.emitTaskEvent(
      "task.abandoned",
      task,
      by,
      result?.reason !== undefined
        ? { taskId: task.metadata.id, reason: result.reason }
        : { taskId: task.metadata.id },
    );
    return { ok: true, task };
  }

  async block(
    taskId: string,
    claimId: string,
    by: AgentIdentity,
    result: { reason: string; blockedOn?: string[] },
  ): Promise<LifecycleResult> {
    if (typeof result?.reason !== "string" || result.reason.trim().length === 0) {
      return { ok: false, code: "invalid_input", message: "block requires a non-empty reason" };
    }
    const obligations = result.blockedOn ?? [];
    // Durable Obligation invariant (fix §7): `blocked` MUST wait on at least
    // one durable obligation — blocking "until somebody acts" without one
    // recreates the silent-wait deadlock this fix exists to eliminate.
    if (obligations.length === 0) {
      return {
        ok: false,
        code: "invalid_input",
        message: "block requires at least one durable obligation in blockedOn; create it first (swarm_request_create)",
      };
    }
    for (const id of obligations) {
      if (typeof id !== "string" || !TASK_ID_RE.test(id)) {
        return { ok: false, code: "invalid_input", message: `blockedOn contains invalid task id: ${String(id)}` };
      }
    }
    const tasks = await this.deps.taskStore.list();
    const known = new Set(tasks.map((t) => t.metadata.id));
    for (const id of obligations) {
      if (!known.has(id)) {
        return { ok: false, code: "invalid_input", message: `blockedOn target ${id} does not exist` };
      }
    }
    const loaded = await this.loadOwned(taskId, claimId, by, "blocked");
    if (!loaded.ok) return loaded;
    const merged = [...new Set([...loaded.task.metadata.blockedOn, ...obligations])];
    const task: TaskDocument = {
      ...loaded.task,
      metadata: { ...loaded.task.metadata, status: "blocked", blockedOn: merged, updatedAt: this.now() },
      body: appendSection(loaded.task.body, "Blocked", result.reason),
    };
    await this.deps.taskStore.save(task);
    await this.emitTaskEvent("task.blocked", task, by, {
      taskId: task.metadata.id,
      reason: result.reason,
      blockedOn: merged,
    });
    return { ok: true, task };
  }

  async unblock(taskId: string, claimId: string, by: AgentIdentity): Promise<LifecycleResult> {
    const loaded = await this.loadOwned(taskId, claimId, by, "in_progress");
    if (!loaded.ok) return loaded;
    const statusIndex = new Map(
      (await this.deps.taskStore.list()).map((t) => [t.metadata.id, t.metadata.status] as const),
    );
    const pending = loaded.task.metadata.blockedOn.filter((id) => statusIndex.get(id) !== "done");
    if (pending.length > 0) {
      return {
        ok: false,
        code: "invalid_input",
        message: `task ${taskId} is still blocked on ${pending.join(", ")}; complete or abandon those obligations first`,
      };
    }
    const task = await this.setStatus(loaded.task, "in_progress");
    await this.emitTaskEvent("task.unblocked", task, by, { taskId: task.metadata.id });
    return { ok: true, task };
  }

  async reopen(taskId: string, by: AgentIdentity): Promise<LifecycleResult> {
    const task = await this.loadTask(taskId);
    if (!task.ok) return task;
    if (!TASK_TRANSITIONS[task.value.metadata.status].includes("open")) {
      return {
        ok: false,
        code: "invalid_transition",
        message: `only abandoned tasks can be reopened; task ${taskId} is ${task.value.metadata.status}`,
      };
    }
    const updated = await this.setStatus(task.value, "open");
    await this.emitTaskEvent("task.reopened", updated, by, { taskId });
    return { ok: true, task: updated };
  }

  // -- internals ------------------------------------------------------------


  /** Build the current topology from the shared stores (null when unconfigured). */
  private async buildTopology(): Promise<ActiveTopology | null> {
    if (!this.deps.presenceStore || !this.deps.manifestStore || !this.deps.config) return null;
    const [presence, manifests] = await Promise.all([
      this.deps.presenceStore.list(),
      this.deps.manifestStore.list(),
    ]);
    return buildActiveTopology(presence, manifests, {
      nowIso: this.now(),
      presenceStaleMs: this.deps.config.runtime.presenceStaleMs,
      ...(this.deps.isProcessAlive !== undefined
        ? { isProcessAlive: this.deps.isProcessAlive }
        : {}),
    });
  }

  /** Resolve `task` against a freshly built topology (claim-time truth). */
  private async resolveNow(
    task: TaskDocument,
    claimExists: boolean,
    statusIndex: ReadonlyMap<string, TaskStatus>,
  ): Promise<CandidateResolution> {
    const topology = await this.buildTopology();
    if (topology === null) {
      return {
        state: "legacy",
        reason: `task ${task.metadata.id} has a workDomain but topology stores are not configured`,
      };
    }
    const sourceClaimantInstanceIds: string[] = [];
    if (task.metadata.constraints?.excludeCurrentClaimant) {
      const sourceId = task.metadata.origin?.sourceTaskId ?? task.metadata.parentTask;
      if (sourceId !== undefined && TASK_ID_RE.test(sourceId)) {
        const sourceClaim = await this.deps.claimStore.get(sourceId);
        if (sourceClaim !== null) sourceClaimantInstanceIds.push(sourceClaim.agent.instanceId);
      }
    }
    return resolveTaskCandidates(task, topology, {
      nowIso: this.now(),
      claimExists,
      sourceClaimantInstanceIds,
      statusIndex,
      fallbackEnabled: this.deps.config?.scheduling.fallbackEnabled,
    });
  }

  /**
   * blocked -> in_progress (claim retained) or -> open (claim lost) for every
   * parent whose blockedOn obligations are now all done. Persist-first; the
   * caller emits task.unblocked afterwards (fix §13.4 ordering).
   */
  private async resumeUnblockedParents(
    completedTaskId: string,
  ): Promise<{ taskId: string; status: TaskStatus; claimantRole: string | null }[]> {
    const tasks = await this.deps.taskStore.list();
    const statusIndex = new Map(tasks.map((t) => [t.metadata.id, t.metadata.status] as const));
    const resumed: { taskId: string; status: TaskStatus; claimantRole: string | null }[] = [];
    for (const candidate of tasks) {
      const meta = candidate.metadata;
      if (meta.status !== "blocked" || !meta.blockedOn.includes(completedTaskId)) continue;
      const allDone = meta.blockedOn.every((id) => statusIndex.get(id) === "done");
      if (!allDone) continue;
      const claim = await this.deps.claimStore.get(meta.id);
      const target: TaskStatus = claim !== null ? "in_progress" : "open";
      const updated: TaskDocument = {
        ...candidate,
        metadata: { ...meta, status: target, updatedAt: this.now() },
      };
      await this.deps.taskStore.save(updated);
      resumed.push({
        taskId: meta.id,
        status: target,
        claimantRole: claim !== null ? claim.agent.role : null,
      });
    }
    return resumed;
  }

  private async loadTask(
    taskId: string,
  ): Promise<{ ok: true; value: TaskDocument } | { ok: false; code: "not_found"; message: string }> {
    if (!TASK_ID_RE.test(taskId)) {
      return { ok: false, code: "not_found", message: `invalid task id: ${taskId}` };
    }
    const task = await this.deps.taskStore.get(taskId);
    if (task === null) {
      return { ok: false, code: "not_found", message: `task ${taskId} does not exist` };
    }
    return { ok: true, value: task };
  }

  /**
   * Shared lifecycle precondition: task exists, caller owns the current
   * claim (claimId + instanceId), and the state machine allows the move.
   * Ownership is verified BEFORE the transition check (architecture §9.6).
   */
  private async loadOwned(
    taskId: string,
    claimId: string,
    by: AgentIdentity,
    target: TaskStatus,
  ): Promise<
    | { ok: true; task: TaskDocument }
    | { ok: false; code: "not_found" | "not_claim_owner" | "invalid_transition"; message: string }
  > {
    const task = await this.loadTask(taskId);
    if (!task.ok) return task;
    const claim = await this.deps.claimStore.get(taskId);
    if (
      claim === null ||
      claim.claimId !== claimId ||
      claim.agent.instanceId !== by.instanceId
    ) {
      return {
        ok: false,
        code: "not_claim_owner",
        message: `claim ${claimId} does not currently own task ${taskId}`,
      };
    }
    if (!TASK_TRANSITIONS[task.value.metadata.status].includes(target)) {
      return {
        ok: false,
        code: "invalid_transition",
        message: `task ${taskId} cannot move from ${task.value.metadata.status} to ${target}`,
      };
    }
    return { ok: true, task: task.value };
  }

  private async setStatus(task: TaskDocument, status: TaskStatus): Promise<TaskDocument> {
    const updated: TaskDocument = {
      ...task,
      metadata: { ...task.metadata, status, updatedAt: this.now() },
    };
    await this.deps.taskStore.save(updated);
    return updated;
  }

  private async emitTaskEvent(
    type: string,
    task: TaskDocument,
    by: AgentIdentity,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.eventService.emit(
      {
        type,
        route: { mode: "broadcast", topic: "tasks" },
        context: { taskId: task.metadata.id },
        data,
      },
      by,
    );
  }
}

/** Map a resolution onto the list()/claim() eligibility shape. */
function resolutionDecision(
  resolution: CandidateResolution,
  instanceId: string,
): { eligible: boolean; reason?: IneligibleReason; detail?: string; tier?: CandidateTier } {
  switch (resolution.state) {
    case "primary":
    case "secondary":
    case "fallback":
      if (isEligibleCandidate(resolution, instanceId)) {
        return { eligible: true, tier: resolution.state };
      }
      return {
        eligible: false,
        reason: "role",
        detail: `another tier is active: ${resolution.state} specialists own this work`,
      };
    case "unserviceable":
      return { eligible: false, reason: "unserviceable", detail: resolution.reason };
    case "not_actionable":
      return { eligible: false, reason: mapNotActionable(resolution.reason), detail: resolution.reason };
    case "legacy":
      return { eligible: false, reason: "unserviceable", detail: resolution.reason };
  }
}

function mapNotActionable(reason: string): IneligibleReason {
  if (reason.includes("not due")) return "not_due";
  if (reason.includes("blocked on")) return "blocked_on";
  if (reason.includes("depends on")) return "dependencies";
  if (reason.includes("already has an owner")) return "claimed";
  return "status";
}

function describeResolution(
  taskId: string,
  resolution: CandidateResolution,
  role: string,
): string {
  switch (resolution.state) {
    case "primary":
    case "secondary":
      return `task ${taskId} is reserved for active ${resolution.state} specialists; ${role} is outside the boundary`;
    case "fallback":
      return `task ${taskId} fallback pool does not include ${role} (fallback disabled or hard constraints unmet)`;
    case "unserviceable":
      return `task ${taskId} is unserviceable: ${resolution.reason}`;
    default:
      return `task ${taskId} is not actionable: ${resolution.reason}`;
  }
}

function validateCreate(input: CreateTaskInput): Validated<ValidatedCreate> {
  if (typeof input?.title !== "string" || input.title.trim().length === 0) {
    return { ok: false, message: "title must be a non-empty string" };
  }
  if (input.title.length > MAX_TITLE_CHARS) {
    return { ok: false, message: `title must be at most ${MAX_TITLE_CHARS} characters` };
  }
  if (typeof input.body !== "string" || input.body.trim().length === 0) {
    return { ok: false, message: "body must be a non-empty string" };
  }
  if (input.kind !== undefined && (typeof input.kind !== "string" || input.kind.length === 0)) {
    return { ok: false, message: "kind must be a non-empty string" };
  }
  let priority = 50;
  if (input.priority !== undefined) {
    if (typeof input.priority !== "number" || !Number.isInteger(input.priority)) {
      return { ok: false, message: "priority must be an integer" };
    }
    if (input.priority < 0 || input.priority > 100) {
      return { ok: false, message: "priority must be between 0 and 100" };
    }
    priority = input.priority;
  }
  if (input.eligibleRoles !== undefined) {
    if (!Array.isArray(input.eligibleRoles)) {
      return { ok: false, message: "eligibleRoles must be an array of role ids" };
    }
    for (const role of input.eligibleRoles) {
      if (typeof role !== "string" || !ROLE_ID_RE.test(role)) {
        return { ok: false, message: `eligibleRoles contains invalid role id: ${String(role)}` };
      }
    }
  }
  if (input.requiredCapabilities !== undefined) {
    const caps = validateRefList(input.requiredCapabilities, "requiredCapabilities");
    if (!caps.ok) return caps;
  }
  if (input.workDomain !== undefined && (typeof input.workDomain !== "string" || !DOMAIN_RE.test(input.workDomain))) {
    return { ok: false, message: `workDomain must be a kebab-case domain id: ${String(input.workDomain)}` };
  }
  if (input.preferredCapabilities !== undefined) {
    const caps = validateRefList(input.preferredCapabilities, "preferredCapabilities");
    if (!caps.ok) return caps;
  }
  if (input.hardRequirements !== undefined) {
    if (
      typeof input.hardRequirements !== "object" ||
      input.hardRequirements === null ||
      Array.isArray(input.hardRequirements)
    ) {
      return { ok: false, message: "hardRequirements must be an object" };
    }
    const caps = validateRefList(input.hardRequirements.capabilities, "hardRequirements.capabilities");
    if (!caps.ok) return caps;
  }
  if (input.constraints !== undefined) {
    const c = input.constraints;
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      return { ok: false, message: "constraints must be an object" };
    }
    if (
      c.excludeTaskAuthor !== undefined && typeof c.excludeTaskAuthor !== "boolean" ||
      c.excludeCurrentClaimant !== undefined && typeof c.excludeCurrentClaimant !== "boolean"
    ) {
      return { ok: false, message: "constraints fields must be booleans" };
    }
  }
  if (input.fallback !== undefined) {
    if (typeof input.fallback !== "object" || input.fallback === null || Array.isArray(input.fallback)) {
      return { ok: false, message: "fallback must be an object" };
    }
    if (input.fallback.allowed !== undefined && typeof input.fallback.allowed !== "boolean") {
      return { ok: false, message: "fallback.allowed must be a boolean" };
    }
  }
  if (input.availableAt !== undefined && (typeof input.availableAt !== "string" || !ISO_TIME_RE.test(input.availableAt))) {
    return { ok: false, message: `availableAt must be ISO-8601 UTC ending in Z: ${String(input.availableAt)}` };
  }
  const dependsOn = input.dependsOn ?? [];
  if (!Array.isArray(dependsOn)) {
    return { ok: false, message: "dependsOn must be an array of task ids" };
  }
  for (const dep of dependsOn) {
    if (typeof dep !== "string" || !TASK_ID_RE.test(dep)) {
      return { ok: false, message: `dependsOn contains invalid task id: ${String(dep)}` };
    }
  }
  if (input.parentTask !== undefined && !TASK_ID_RE.test(input.parentTask)) {
    return { ok: false, message: `parentTask is not a valid task id: ${String(input.parentTask)}` };
  }
  if (input.origin !== undefined) {
    const o = input.origin;
    if (typeof o !== "object" || o === null || Array.isArray(o) || typeof o.type !== "string" || o.type.length === 0) {
      return { ok: false, message: "origin must be an object with a non-empty type" };
    }
    if (o.sourceTaskId !== undefined && !TASK_ID_RE.test(o.sourceTaskId)) {
      return { ok: false, message: `origin.sourceTaskId is not a valid task id: ${String(o.sourceTaskId)}` };
    }
    if (o.requestKey !== undefined && (typeof o.requestKey !== "string" || o.requestKey.length === 0)) {
      return { ok: false, message: "origin.requestKey must be a non-empty string" };
    }
  }
  const inputs = input.inputs ?? [];
  const inputRefs = validateRefList(inputs, "inputs");
  if (!inputRefs.ok) return inputRefs;

  const eligibleRoles =
    input.eligibleRoles !== undefined ? [...new Set(input.eligibleRoles)] : undefined;
  const requiredCapabilities =
    input.requiredCapabilities !== undefined
      ? [...new Set(input.requiredCapabilities)]
      : undefined;
  const preferredCapabilities =
    input.preferredCapabilities !== undefined
      ? [...new Set(input.preferredCapabilities)]
      : undefined;
  const hardRequirements =
    input.hardRequirements !== undefined
      ? { capabilities: [...new Set(input.hardRequirements.capabilities ?? [])] }
      : undefined;
  return {
    ok: true,
    value: {
      title: input.title,
      body: input.body,
      kind: input.kind ?? "general",
      priority,
      ...(eligibleRoles !== undefined ? { eligibleRoles } : {}),
      ...(requiredCapabilities !== undefined ? { requiredCapabilities } : {}),
      ...(input.workDomain !== undefined ? { workDomain: input.workDomain } : {}),
      ...(preferredCapabilities !== undefined ? { preferredCapabilities } : {}),
      ...(hardRequirements !== undefined ? { hardRequirements } : {}),
      ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
      ...(input.fallback !== undefined
        ? { fallback: { allowed: input.fallback.allowed ?? true } }
        : {}),
      ...(input.availableAt !== undefined ? { availableAt: input.availableAt } : {}),
      dependsOn: [...new Set(dependsOn)],
      ...(input.parentTask !== undefined ? { parentTask: input.parentTask } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      inputs: inputRefs.value,
    },
  };
}

/** Optional list of non-empty string references (outputs/inputs/capabilities). */
function validateRefList(
  values: string[] | undefined,
  field: string,
): Validated<string[]> {
  if (values === undefined) return { ok: true, value: [] };
  if (!Array.isArray(values)) {
    return { ok: false, message: `${field} must be an array of strings` };
  }
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, message: `${field} contains an empty or non-string entry` };
    }
  }
  return { ok: true, value: [...new Set(values)] };
}

function appendSection(body: string, heading: string, text: string): string {
  const separator = body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${separator}## ${heading}\n\n${text}`;
}

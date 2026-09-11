/**
 * Task domain service (PRD Workstream B): creation, discovery, atomic claim,
 * and lifecycle transitions. All mutations are funneled through the stores;
 * events carry signals (references, not payloads). The claim record is the
 * canonical ownership truth — the Markdown status update after a successful
 * claim is best-effort and repaired by the reconciler (architecture §9.5).
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
import { TaskExistsError } from "../storage/types.js";
import type { ClaimStore, TaskStore } from "../storage/types.js";
import type {
  AgentIdentity,
  ClaimRecord,
  NormalizedAgentManifest,
  TaskDocument,
  TaskStatus,
} from "../protocol/schemas.js";
import { TASK_ID_RE, TASK_TRANSITIONS, ROLE_ID_RE } from "../protocol/schemas.js";
import { ulid } from "../util/ulid.js";
import { nowIso } from "../util/clock.js";

export interface TaskServiceDeps {
  taskStore: TaskStore;
  claimStore: ClaimStore;
  policy: PolicyService;
  eventService: EventService;
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
  dependsOn: string[];
  parentTask?: string;
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
          createdBy: { role: by.role, instanceId: by.instanceId },
          createdAt: ts,
          updatedAt: ts,
          ...(v.parentTask !== undefined ? { parentTask: v.parentTask } : {}),
          dependsOn: v.dependsOn,
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
    for (const task of [...tasks].sort((a, b) => a.metadata.id.localeCompare(b.metadata.id))) {
      if (!statuses.has(task.metadata.status)) continue;
      const claim = claims.get(task.metadata.id) ?? null;
      if (query.forAgent === undefined) {
        views.push({ metadata: task.metadata, claim, eligible: true });
        continue;
      }
      const decision = this.deps.policy.checkClaim(
        query.forAgent.manifest,
        task,
        claim !== null,
        statusIndex,
      );
      if (decision.eligible) {
        views.push({ metadata: task.metadata, claim, eligible: true });
        continue;
      }
      // Dependency-blocked tasks can be surfaced explicitly via
      // requireDependencies: false even when ineligible tasks are hidden.
      const dependencyOnly = decision.reason === "dependencies";
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
    const decision = this.deps.policy.checkClaim(by.manifest, task, existing !== null, statusIndex);
    if (!decision.eligible) {
      if (decision.reason === "status") {
        return { status: "not_open", message: decision.detail ?? `task ${taskId} is not open` };
      }
      return { status: "not_eligible", message: decision.detail ?? `not eligible for ${taskId}` };
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
    await this.emitTaskEvent("task.completed", task, by, { taskId: task.metadata.id });
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
  const inputs = input.inputs ?? [];
  const inputRefs = validateRefList(inputs, "inputs");
  if (!inputRefs.ok) return inputRefs;

  const eligibleRoles =
    input.eligibleRoles !== undefined ? [...new Set(input.eligibleRoles)] : undefined;
  const requiredCapabilities =
    input.requiredCapabilities !== undefined
      ? [...new Set(input.requiredCapabilities)]
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
      dependsOn: [...new Set(dependsOn)],
      ...(input.parentTask !== undefined ? { parentTask: input.parentTask } : {}),
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

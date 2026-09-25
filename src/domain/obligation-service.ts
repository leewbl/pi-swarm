/**
 * Durable obligation protocol (structural liveness fix §13).
 *
 * Any request that expects another agent's future action MUST become a task —
 * an event alone is never enough (Invariant A). A "request" here is an
 * ordinary durable task plus origin metadata plus an idempotent requestKey:
 * there is no second request store. Compound "block + request" operations
 * follow the crash-safe ordering — derive key, create the durable child
 * FIRST, then block the parent on it, events last — so a crash at any point
 * leaves the obligation durable and reconciliation can repair the link from
 * origin.sourceTaskId/requestKey.
 *
 * Rework (fix §15): verification contradictions create NEW rework work
 * (parentTask + origin.type=verification-contradiction) instead of mutating
 * `done` history (Invariant I). The original claimant is excluded by default
 * via constraints.excludeCurrentClaimant — done tasks keep their claim record
 * as history, so the exclusion resolves against it.
 */
import type { AgentIdentity, TaskDocument } from "../protocol/schemas.js";
import { TASK_ID_RE } from "../protocol/schemas.js";
import type { CreateTaskInput, CreateTaskResult, TaskService } from "./types.js";
import type { TaskStore } from "../storage/types.js";

export interface RequestObligationInput {
  /** Obligation kind: decision | review | verification | rework | approval | research | custom. */
  kind: string;
  /** Work domain the obligation belongs to (topology resolution). */
  workDomain: string;
  title: string;
  /** Why this obligation exists (body context). */
  reason?: string;
  /** Task whose blocker created this obligation (origin.sourceTaskId). */
  sourceTaskId?: string;
  /** Decision options rendered into the body. */
  options?: string[];
  /** Default true: may leave specialist boundaries when no specialist is active. */
  fallbackAllowed?: boolean;
  /** Default false: exclude the source task's current claimant (self-decision guard). */
  excludeSourceClaimant?: boolean;
  priority?: number;
  inputs?: string[];
  availableAt?: string;
}

export interface ReworkInput {
  /** The completed task whose completion assumption verification disproved. */
  originalTaskId: string;
  reason: string;
  /** Blackboard/artifact references backing the contradiction. */
  evidence?: string[];
  priority?: number;
}

export type ObligationResult =
  | { ok: true; task: TaskDocument; deduplicated: boolean }
  | { ok: false; code: "invalid_input" | "not_found"; message: string };

export interface ObligationServiceDeps {
  taskService: TaskService;
  taskStore: TaskStore;
}

/** Deterministic idempotency key: source:kind:title-slug (fix §6.2 origin.requestKey). */
export function deriveRequestKey(input: RequestObligationInput): string {
  const source = input.sourceTaskId !== undefined && TASK_ID_RE.test(input.sourceTaskId)
    ? input.sourceTaskId
    : "no-source";
  const slug = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${source}:${input.kind}:${slug || "untitled"}`;
}

export interface ObligationService {
  /**
   * Create (or deduplicate) a durable obligation task. Never a second
   * store: this is taskService.create + origin metadata.
   */
  createObligation(input: RequestObligationInput, by: AgentIdentity): Promise<ObligationResult>;
  /**
   * Verification contradiction -> NEW rework task (Invariant I: `done`
   * history is never silently rewritten). The original claimant is
   * excluded so the rework goes through fresh topology resolution.
   */
  createRework(input: ReworkInput, by: AgentIdentity): Promise<ObligationResult>;
}

function renderObligationBody(input: RequestObligationInput): string {
  const sections: string[] = [];
  if (input.reason !== undefined && input.reason.trim().length > 0) {
    sections.push(input.reason.trim());
  }
  if (input.options !== undefined && input.options.length > 0) {
    sections.push("## Options\n\n" + input.options.map((o, i) => `${i + 1}. ${o}`).join("\n"));
  }
  if (input.sourceTaskId !== undefined) {
    sections.push(
      `## Origin\n\nCreated as a durable obligation from ${input.sourceTaskId}. ` +
        "Respond by claiming this task; do not answer with events only.",
    );
  }
  if (sections.length === 0) sections.push("(no additional context)");
  return sections.join("\n\n");
}

export function createObligationService(deps: ObligationServiceDeps): ObligationService {
  const { taskService, taskStore } = deps;

  /** Find an existing obligation by idempotency key (crash/retry reconciliation). */
  async function findByRequestKey(requestKey: string): Promise<TaskDocument | null> {
    for (const task of await taskStore.list()) {
      if (task.metadata.origin?.requestKey === requestKey) return task;
    }
    return null;
  }

  return {
    /**
     * Create (or deduplicate) a durable obligation task. Never a second
     * store: this is taskService.create + origin metadata.
     */
    async createObligation(
      input: RequestObligationInput,
      by: AgentIdentity,
    ): Promise<ObligationResult> {
      if (typeof input.title !== "string" || input.title.trim().length === 0) {
        return { ok: false, code: "invalid_input", message: "title must be a non-empty string" };
      }
      if (typeof input.workDomain !== "string" || input.workDomain.length === 0) {
        return { ok: false, code: "invalid_input", message: "workDomain is required" };
      }
      if (
        input.sourceTaskId !== undefined &&
        (typeof input.sourceTaskId !== "string" || !TASK_ID_RE.test(input.sourceTaskId))
      ) {
        return { ok: false, code: "invalid_input", message: `sourceTaskId is invalid: ${String(input.sourceTaskId)}` };
      }
      const requestKey = deriveRequestKey(input);
      const existing = await findByRequestKey(requestKey);
      if (existing !== null) {
        return { ok: true, task: existing, deduplicated: true };
      }
      const create: CreateTaskInput = {
        title: input.title,
        body: renderObligationBody(input),
        kind: input.kind,
        priority: input.priority ?? 60,
        workDomain: input.workDomain,
        fallback: { allowed: input.fallbackAllowed ?? true },
        constraints: {
          excludeCurrentClaimant: input.excludeSourceClaimant ?? false,
        },
        ...(input.sourceTaskId !== undefined
          ? { origin: { type: `${input.kind}-request`, sourceTaskId: input.sourceTaskId, requestKey } }
          : { origin: { type: `${input.kind}-request`, requestKey } }),
        ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
        ...(input.availableAt !== undefined ? { availableAt: input.availableAt } : {}),
      };
      const result: CreateTaskResult = await taskService.create(create, by);
      if (!result.ok) return result;
      return { ok: true, task: result.task, deduplicated: false };
    },

    /**
     * Verification contradiction -> NEW rework task (Invariant I: `done`
     * history is never silently rewritten). The original claimant is
     * excluded so the rework goes through fresh topology resolution.
     */
    async createRework(input: ReworkInput, by: AgentIdentity): Promise<ObligationResult> {
      if (typeof input.originalTaskId !== "string" || !TASK_ID_RE.test(input.originalTaskId)) {
        return { ok: false, code: "invalid_input", message: "originalTaskId is invalid" };
      }
      if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
        return { ok: false, code: "invalid_input", message: "reason must be a non-empty string" };
      }
      const original = await taskStore.get(input.originalTaskId);
      if (original === null) {
        return { ok: false, code: "not_found", message: `task ${input.originalTaskId} does not exist` };
      }
      const requestKey = `${input.originalTaskId}:rework:${by.instanceId}`;
      const existing = await findByRequestKey(requestKey);
      if (existing !== null) {
        return { ok: true, task: existing, deduplicated: true };
      }
      const title = `Rework ${input.originalTaskId}: ${original.metadata.kind}`;
      const body = [
        input.reason.trim(),
        "## Evidence\n\n" +
          (input.evidence !== undefined && input.evidence.length > 0
            ? input.evidence.map((e) => `- ${e}`).join("\n")
            : "(see origin task outputs)"),
        `## Origin\n\nVerification contradicted the completion of ${input.originalTaskId}. The original claimant is excluded; the rework resolves through current topology.`,
      ].join("\n\n");
      const result = await taskService.create(
        {
          title,
          body,
          kind: "rework",
          priority: input.priority ?? 70,
          workDomain: original.metadata.workDomain ?? original.metadata.kind,
          fallback: { allowed: true },
          constraints: { excludeCurrentClaimant: true },
          parentTask: input.originalTaskId,
          origin: {
            type: "verification-contradiction",
            sourceTaskId: input.originalTaskId,
            requestKey,
          },
          inputs: original.metadata.outputs,
        },
        by,
      );
      if (!result.ok) return result;
      return { ok: true, task: result.task, deduplicated: false };
    },
  };
}


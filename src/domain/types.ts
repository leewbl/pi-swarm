/**
 * Domain service contracts (PRD Workstream B + event emission).
 *
 * Implementations: `src/domain/task-service.ts`, `policy-service.ts`,
 * `recovery-service.ts`, `event-service.ts`. The extension layer composes and
 * injects these; tests construct them directly over temp-dir stores.
 * Domain code must not import oh-my-pi APIs (Product Invariant 6).
 */
import type {
  AgentIdentity,
  ClaimRecord,
  NormalizedAgentManifest,
  PresenceRecord,
  Route,
  SwarmEvent,
  TaskDocument,
  TaskMetadata,
  TaskStatus,
} from "../protocol/schemas.js";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EmitEventInput {
  type: string;
  route: Route;
  context?: { taskId?: string; correlationId?: string; causationId?: string };
  /** Must stay small: references, not payloads. Size-capped at emit time. */
  data?: unknown;
}

export interface EventService {
  /** Build (id/time/from defaults), validate, and append to own stream. */
  emit(input: EmitEventInput, from: AgentIdentity): Promise<SwarmEvent>;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  /** First line / heading of the Markdown body. */
  title: string;
  /** Markdown body: goal, acceptance criteria, context. */
  body: string;
  kind?: string;
  priority?: number;
  eligibleRoles?: string[];
  requiredCapabilities?: string[];
  dependsOn?: string[];
  parentTask?: string;
  /** Blackboard/artifact references a claimant should read first. */
  inputs?: string[];
}

export type CreateTaskResult =
  | { ok: true; task: TaskDocument }
  | { ok: false; code: "invalid_input"; message: string };

export type ClaimOutcome =
  | { status: "claimed"; claim: ClaimRecord; task: TaskDocument }
  | {
      status: "already_claimed" | "not_eligible" | "not_open" | "invalid_task";
      message: string;
    };

export type LifecycleResult =
  | { ok: true; task: TaskDocument }
  | {
      ok: false;
      code: "not_found" | "invalid_transition" | "not_claim_owner" | "invalid_input";
      message: string;
    };

export type IneligibleReason = "status" | "claimed" | "role" | "capabilities" | "dependencies";

export interface TaskView {
  metadata: TaskMetadata;
  claim: ClaimRecord | null;
  /** Eligibility for `forAgent` when provided in the query. */
  eligible: boolean;
  ineligibleReason?: IneligibleReason;
}

export interface TaskListQuery {
  /** Resolve per-agent eligibility flags. */
  forAgent?: { identity: AgentIdentity; manifest: NormalizedAgentManifest };
  /** Filter by status; defaults to open + claimed + in_progress. */
  statuses?: TaskStatus[];
  /** Include tasks the agent may not claim (diagnostics). Default false. */
  includeIneligible?: boolean;
  /** Skip dependency-unsatisfied tasks. Default true for agent views. */
  requireDependencies?: boolean;
}

export interface TaskService {
  /** Validate, allocate id, persist `open` task, emit `task.opened`. */
  create(input: CreateTaskInput, by: AgentIdentity): Promise<CreateTaskResult>;
  /** Filtered/annotated task pool scan. Never throws on malformed files. */
  list(query: TaskListQuery): Promise<TaskView[]>;
  get(taskId: string): Promise<TaskView | null>;
  /**
   * Policy check -> atomic ClaimStore.tryClaim -> task Markdown update
   * (best-effort; reconciler covers a crash between the two) -> `task.claimed`.
   */
  claim(
    taskId: string,
    by: { identity: AgentIdentity; manifest: NormalizedAgentManifest },
  ): Promise<ClaimOutcome>;
  /** claimed -> in_progress. Requires owning claimId. */
  start(taskId: string, claimId: string, by: AgentIdentity): Promise<LifecycleResult>;
  /** in_progress -> done. Persists summary + output refs. */
  complete(
    taskId: string,
    claimId: string,
    by: AgentIdentity,
    result: { summary?: string; outputs?: string[] },
  ): Promise<LifecycleResult>;
  /** in_progress -> failed. Requires structured failure reason. */
  fail(
    taskId: string,
    claimId: string,
    by: AgentIdentity,
    result: { reason: string },
  ): Promise<LifecycleResult>;
  /** claimed/in_progress -> abandoned (claim retained until recovery reopens). */
  abandon(
    taskId: string,
    claimId: string,
    by: AgentIdentity,
    result?: { reason?: string },
  ): Promise<LifecycleResult>;
  /** abandoned -> open. Emits `task.reopened`. */
  reopen(taskId: string, by: AgentIdentity): Promise<LifecycleResult>;
}

// ---------------------------------------------------------------------------
// Eligibility policy (pure decision logic, PRD FR-5)
// ---------------------------------------------------------------------------

export interface EligibilityDecision {
  eligible: boolean;
  reason?: IneligibleReason;
  /** Human-readable explanation for tool results / status output. */
  detail?: string;
}

export interface PolicyService {
  /**
   * Pure eligibility check for one manifest against one task.
   * `statusIndex` maps taskId -> status for dependency resolution.
   */
  checkClaim(
    manifest: NormalizedAgentManifest,
    task: TaskDocument,
    hasClaim: boolean,
    statusIndex: ReadonlyMap<string, TaskStatus>,
  ): EligibilityDecision;
}

// ---------------------------------------------------------------------------
// Recovery (PRD FR-18, architecture §10)
// ---------------------------------------------------------------------------

export interface ClaimantState {
  taskId: string;
  claim: ClaimRecord;
  presence: PresenceRecord | null;
  presenceStale: boolean;
  /** process.kill(pid, 0) probe result on the local host. */
  claimantAlive: boolean;
}

export interface Inconsistency {
  taskId: string;
  kind: "claim_without_markdown_status" | "markdown_claimed_without_claim" | "task_file_missing";
  detail: string;
}

export interface RecoveryReport {
  /** Stale presence AND confirmed dead claimant — auto-recoverable. */
  orphans: ClaimantState[];
  /** Stale presence but live process — surfaced, never auto-recovered. */
  suspects: ClaimantState[];
  /** Claim/Markdown drift repairable by reconcile(). */
  inconsistencies: Inconsistency[];
  /** Presence records with stale heartbeats (instances, not claims). */
  staleInstances: PresenceRecord[];
}

export interface RecoveryAction {
  taskId: string;
  action: "abandoned_reopened" | "skipped_alive" | "skipped_not_orphan" | "reopened_only";
  detail: string;
}

export interface RecoveryService {
  scan(): Promise<RecoveryReport>;
  /**
   * Repair Markdown status from canonical claim records (both directions).
   * Never removes claims; never reopens tasks. Idempotent.
   */
  reconcile(): Promise<{ taskId: string; repaired: string }[]>;
  /**
   * Orphan recovery: dead claimant -> task.abandoned -> remove claim ->
   * task.open -> events. Only touches stale+dead claims (architecture §10).
   */
  recoverOrphans(by: AgentIdentity): Promise<RecoveryAction[]>;
  /** Manual single-task recovery for `/swarm recover`. */
  recoverTask(taskId: string, by: AgentIdentity): Promise<{ ok: boolean; message: string; action?: RecoveryAction }>;
}

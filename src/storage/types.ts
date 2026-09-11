/**
 * Storage layer contracts (PRD Workstream A).
 *
 * Implementations live in `src/storage/*.ts`; consumers (domain services,
 * runtime loops, extension glue) must depend on these interfaces only.
 * All implementations must:
 *   - route every path through `SwarmPaths` (traversal-safe);
 *   - validate payloads against protocol schemas before persistence;
 *   - write YAML via the `yaml` package and JSONL one compact line per event.
 */
import type {
  AgentManifest,
  ArtifactRef,
  ClaimRecord,
  CursorState,
  PresenceRecord,
  SwarmConfig,
  SwarmEvent,
  TaskDocument,
} from "../protocol/schemas.js";

// ---------------------------------------------------------------------------
// Config & manifests
// ---------------------------------------------------------------------------

export interface ConfigStore {
  /** Missing file resolves to DEFAULT_SWARM_CONFIG (never throws for absence). */
  load(): Promise<SwarmConfig>;
  save(config: SwarmConfig): Promise<void>;
  exists(): Promise<boolean>;
}

export interface ManifestIssue {
  file: string;
  error: string;
}

export interface ManifestStore {
  /** Valid manifests, sorted by role. Invalid files are skipped (see issues). */
  list(): Promise<AgentManifest[]>;
  get(role: string): Promise<AgentManifest | null>;
  /** Atomic write of agents/<role>.yaml. */
  save(manifest: AgentManifest): Promise<void>;
  /** Parse + schema + duplicate-role detection for doctor. */
  validate(): Promise<ManifestIssue[]>;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export class TaskExistsError extends Error {
  constructor(public taskId: string) {
    super(`task file already exists: ${taskId}`);
    this.name = "TaskExistsError";
  }
}

export interface TaskStore {
  /** All valid tasks; invalid files surfaced via `issues()`. */
  list(): Promise<TaskDocument[]>;
  get(taskId: string): Promise<TaskDocument | null>;
  /**
   * Validate + serialize + persist a task document.
   * `mode: "create"` uses an exclusive create and throws TaskExistsError on
   * collision (safe ID allocation across concurrent creators).
   */
  save(task: TaskDocument, mode?: { create?: boolean }): Promise<void>;
  /** Next free zero-padded id (max existing + 1). */
  nextTaskId(): Promise<string>;
  /** Malformed task files for doctor/status (never crashes the scan loop). */
  issues(): Promise<{ file: string; error: string }[]>;
}

// ---------------------------------------------------------------------------
// Claims — canonical task ownership (architecture §9)
// ---------------------------------------------------------------------------

export type TryClaimResult = { status: "claimed" } | { status: "already_claimed" };

export interface ClaimStore {
  /** Exclusive O_EXCL create of claims/<taskId>.yaml. EEXIST is normal flow. */
  tryClaim(claim: ClaimRecord): Promise<TryClaimResult>;
  get(taskId: string): Promise<ClaimRecord | null>;
  /** Remove only when claimId matches the stored claim (recovery path). */
  remove(taskId: string, claimId: string): Promise<boolean>;
  list(): Promise<ClaimRecord[]>;
}

// ---------------------------------------------------------------------------
// Event streams — one writer per stream (architecture §11.1)
// ---------------------------------------------------------------------------

export interface MalformedLine {
  line: number;
  error: string;
}

export interface EventReadResult {
  /** Validated events, in stream order. */
  events: SwarmEvent[];
  /** New safe byte offset (after the last complete line, valid or malformed). */
  offset: number;
  /** True when the final line lacks its newline — must be retried later. */
  trailingIncomplete: boolean;
  /** Complete-but-invalid lines; skipped (offset advances past them). */
  malformed: MalformedLine[];
}

export interface EventStore {
  /**
   * Append one validated, size-capped event line to THIS instance's stream.
   * `event.from.instanceId` must equal the store's owning instanceId.
   */
  append(event: SwarmEvent): Promise<void>;
  /** Read any producer's stream from a byte offset (complete lines only). */
  readFrom(producerInstanceId: string, offset: number): Promise<EventReadResult>;
  /** All producer instanceIds discovered in events/ (valid file names). */
  listStreams(): Promise<string[]>;
  /** Current byte size of a producer stream (cursor sanity checks). */
  streamSize(producerInstanceId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Cursors — consumer-owned replay state (architecture §12)
// ---------------------------------------------------------------------------

export interface CursorStore {
  /** Empty state ({ streams: {} }) when no cursor file exists. */
  load(consumerInstanceId: string): Promise<CursorState>;
  /** Atomic replace (write temp -> rename). Never mutate in place. */
  save(consumerInstanceId: string, state: CursorState): Promise<void>;
}

// ---------------------------------------------------------------------------
// Presence — advisory liveness (PRD FR-3)
// ---------------------------------------------------------------------------

export interface PresenceFileIssue {
  file: string;
  error: string;
}

export interface PresenceStore {
  upsert(record: PresenceRecord): Promise<void>;
  get(instanceId: string): Promise<PresenceRecord | null>;
  /** All valid presence records (any state). */
  list(): Promise<PresenceRecord[]>;
  /** Unparseable/invalid presence files for doctor. */
  issues(): Promise<PresenceFileIssue[]>;
  /** Mark stopped on clean shutdown; missing record is a no-op. */
  markStopped(instanceId: string, stoppedAt: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Blackboard — permission-enforced shared knowledge (PRD FR-16)
// ---------------------------------------------------------------------------

export class BlackboardDeniedError extends Error {
  constructor(
    public reason: "read" | "write" | "traversal",
    message: string,
  ) {
    super(message);
    this.name = "BlackboardDeniedError";
  }
}

export interface BlackboardStore {
  /**
   * Read a blackboard-relative path (e.g. `findings/oauth.md`).
   * Throws BlackboardDeniedError when the manifest read globs do not cover it.
   */
  read(relPath: string, viewerRole: string, readGlobs: readonly string[]): Promise<string>;
  /**
   * Write a blackboard-relative path.
   * Requires: manifest write globs cover the path AND, for configured hotspot
   * files (swarm.yaml `blackboard.hotspots`), viewerRole is an allowed writer.
   */
  write(
    relPath: string,
    content: string,
    viewerRole: string,
    writeGlobs: readonly string[],
    hotspots: Readonly<Record<string, readonly string[]>>,
  ): Promise<void>;
  /** Existing blackboard-relative paths under relDir ('' = whole board). */
  list(relDir?: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Artifacts — large outputs by reference (architecture §14)
// ---------------------------------------------------------------------------

export class ArtifactNameError extends Error {
  constructor(public fileName: string) {
    super(`unsafe artifact file name: ${fileName}`);
    this.name = "ArtifactNameError";
  }
}

export interface ArtifactStore {
  /**
   * Write `artifacts/<taskId>/<fileName>` and return a validated ArtifactRef
   * (path workspace-relative, sha256 digest, byte size).
   */
  publish(
    taskId: string,
    fileName: string,
    content: string | Uint8Array,
    mediaType?: string,
  ): Promise<ArtifactRef>;
  /** Absolute path for a ref, re-validated inside artifacts/ (traversal-safe). */
  resolvePath(ref: ArtifactRef): Promise<string>;
}

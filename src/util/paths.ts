/**
 * Workspace path resolution and traversal safety.
 *
 * Every swarm file lives under `<workspaceRoot>/.pi/swarm/`. Relative paths
 * coming from untrusted sources (events, task front matter, tool arguments)
 * must go through `resolveRelative` which rejects absolute paths and `..`
 * escapes before anything touches the filesystem.
 */
import path from "node:path";
import { promises as fsp } from "node:fs";

export class PathEscapeError extends Error {
  constructor(offending: string) {
    super(`path escapes .pi/swarm workspace: ${offending}`);
    this.name = "PathEscapeError";
  }
}

export class SwarmPaths {
  readonly workspaceRoot: string;
  readonly swarmRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.swarmRoot = path.join(this.workspaceRoot, ".pi", "swarm");
  }

  get agentsDir(): string {
    return path.join(this.swarmRoot, "agents");
  }
  get tasksDir(): string {
    return path.join(this.swarmRoot, "tasks");
  }
  get claimsDir(): string {
    return path.join(this.swarmRoot, "claims");
  }
  get eventsDir(): string {
    return path.join(this.swarmRoot, "events");
  }
  get blackboardDir(): string {
    return path.join(this.swarmRoot, "blackboard");
  }
  get artifactsDir(): string {
    return path.join(this.swarmRoot, "artifacts");
  }
  get runtimeDir(): string {
    return path.join(this.swarmRoot, "runtime");
  }
  get instancesDir(): string {
    return path.join(this.runtimeDir, "instances");
  }
  get cursorsDir(): string {
    return path.join(this.runtimeDir, "cursors");
  }

  swarmConfigFile(): string {
    return path.join(this.swarmRoot, "swarm.yaml");
  }
  agentManifestFile(role: string): string {
    return path.join(this.agentsDir, `${role}.yaml`);
  }
  taskFile(taskId: string): string {
    return path.join(this.tasksDir, `${taskId}.md`);
  }
  claimFile(taskId: string): string {
    return path.join(this.claimsDir, `${taskId}.yaml`);
  }
  eventStreamFile(instanceId: string): string {
    return path.join(this.eventsDir, `${instanceId}.jsonl`);
  }
  cursorFile(consumerInstanceId: string): string {
    return path.join(this.cursorsDir, `${consumerInstanceId}.json`);
  }
  presenceFile(instanceId: string): string {
    return path.join(this.instancesDir, `${instanceId}.yaml`);
  }
  artifactDir(taskId: string): string {
    return path.join(this.artifactsDir, taskId);
  }

  /** Idempotent workspace layout creation (`/swarm init` and tests). */
  async ensureLayout(): Promise<void> {
    const dirs = [
      this.agentsDir,
      this.tasksDir,
      this.claimsDir,
      this.eventsDir,
      this.blackboardDir,
      this.artifactsDir,
      this.instancesDir,
      this.cursorsDir,
    ];
    await Promise.all(dirs.map((dir) => fsp.mkdir(dir, { recursive: true })));
  }

  /**
   * Resolve a workspace-relative path inside `.pi/swarm/`, rejecting traversal.
   * Accepts both `blackboard/x.md` and `.pi/swarm/blackboard/x.md` prefixes.
   */
  resolveRelative(rel: string): string {
    if (typeof rel !== "string" || rel.length === 0) throw new PathEscapeError(rel);
    if (path.isAbsolute(rel)) throw new PathEscapeError(rel);

    const normalized = path.posix.normalize(rel.replace(/\\/g, "/"));
    if (normalized === ".." || normalized.startsWith("../")) throw new PathEscapeError(rel);

    const swarmPrefix = ".pi/swarm/";
    const stripped = normalized.startsWith(swarmPrefix)
      ? normalized.slice(swarmPrefix.length)
      : normalized;
    if (stripped.startsWith("..") || stripped.length === 0) throw new PathEscapeError(rel);

    return path.join(this.swarmRoot, stripped);
  }

  /** Path relative to swarmRoot, for persisting refs in events/front matter. */
  relativeToSwarmRoot(abs: string): string {
    return path.relative(this.swarmRoot, abs).split(path.sep).join("/");
  }
}

/**
 * Walk up from `start` looking for a directory containing `.pi/swarm`.
 * Returns null when the current directory is not inside a swarm workspace.
 */
export async function locateSwarmRoot(start: string): Promise<SwarmPaths | null> {
  let dir = path.resolve(start);
  for (;;) {
    if (
      await fsp
        .stat(path.join(dir, ".pi", "swarm"))
        .then((s) => s.isDirectory())
        .catch(() => false)
    ) {
      return new SwarmPaths(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

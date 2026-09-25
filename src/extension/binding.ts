/**
 * Session-local role binding (PRD FR-3): a durable marker appended to session
 * history (`custom` entry, customType `pi-swarm.binding.v1`) plus this
 * process's in-memory registry of the active binding (role -> stack+runtime).
 *
 * The binding marker is session-local extension state only; shared swarm
 * state always lives under `.pi/swarm/` (architecture §17).
 */
import type {
  AgentIdentity,
  ClaimRecord,
  NormalizedAgentManifest,
  SwarmConfig,
} from "../protocol/schemas.js";
import type {
  CursorStore,
  EventStore,
  ManifestStore,
  PresenceStore,
  TaskStore,
} from "../storage/types.js";
import type { EventService, TaskService } from "../domain/types.js";
import type { RuntimeStatus, TimerPort, WakePort } from "../runtime/ports.js";
import type { Logger } from "../util/logger.js";
import { ulid } from "../util/ulid.js";
import type { PiCtxLike, PiLike, SessionEntryLike } from "./pi-api.js";
import type { SwarmStack } from "./compose.js";

export const BINDING_CUSTOM_TYPE = "pi-swarm.binding.v1";

/** The subset of the real runtime surface the extension layer drives. */
export interface RuntimeHandle {
  start?(): unknown;
  stop(): unknown;
  markBusy?(): void;
  markIdle?(): void;
  status(): RuntimeStatus;
}

/** Mirrors the runtime's SwarmRuntimeDeps structurally (src/runtime/runtime.ts). */
export interface RuntimeInitArgs {
  identity: AgentIdentity;
  manifest: NormalizedAgentManifest;
  config: SwarmConfig;
  taskService: TaskService;
  /** Optional: lets the runtime render task titles in wake messages. */
  taskStore?: TaskStore;
  /** Optional: manifest source for the liveness watchdog topology. */
  manifestStore?: ManifestStore;
  /** Optional: claim source for the liveness watchdog. */
  claimList?: () => Promise<ClaimRecord[]>;
  eventStore: EventStore;
  cursorStore: CursorStore;
  presenceStore: PresenceStore;
  wake: WakePort;
  timers?: TimerPort;
  now?: () => string;
  logger?: Logger;
}

export interface ActiveBinding {
  role: string;
  identity: AgentIdentity;
  manifest: NormalizedAgentManifest;
  stack: SwarmStack;
  runtime: RuntimeHandle;
}

// One session binds at most one role (PRD FR-3); the registry is keyed by
// role so re-binding replaces cleanly.
const active = new Map<string, ActiveBinding>();

/**
 * Local identity fallback (exported DI seam); compose wires
 * src/runtime/identity.js `newIdentity` in production.
 */
export function newIdentityLocally(role: string, pid: number = process.pid): AgentIdentity {
  return { role, instanceId: `${role}-${ulid().toLowerCase()}`, pid };
}

/** Default local-host liveness probe (`kill -0`); EPERM means alive. */
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err !== null && typeof err === "object" && "code" in err && err.code === "EPERM";
  }
}

/**
 * Install `binding` as this session's active binding, stopping any previously
 * bound role's runtime first (one active role per session, PRD FR-3).
 */
export function setActiveBinding(binding: ActiveBinding): void {
  for (const [role, previous] of active) {
    if (role === binding.role) continue;
    active.delete(role);
    void Promise.resolve(previous.runtime.stop()).catch(() => undefined);
  }
  active.set(binding.role, binding);
}

/** Latest bound role for this session, or null when unbound. */
export function getActiveBinding(): ActiveBinding | null {
  let latest: ActiveBinding | null = null;
  for (const binding of active.values()) latest = binding;
  return latest;
}

export function clearActiveBindings(): void {
  active.clear();
}

/** Append the durable binding marker to session history. */
export function persistBinding(pi: PiLike, role: string): void {
  pi.appendEntry({ type: "custom", customType: BINDING_CUSTOM_TYPE, data: { role } });
}

function readRoleField(source: unknown): string | null {
  if (source === null || typeof source !== "object") return null;
  if ("role" in source && typeof source.role === "string" && source.role.length > 0) {
    return source.role;
  }
  return null;
}

/**
 * Latest bound role from session history (the session's `custom` entries with
 * customType `pi-swarm.binding.v1`). Also accepts `(type, data)` hosts that
 * store the marker in `type` — the marker write is ours either way.
 */
export function rebuildBindingFromSession(ctx: PiCtxLike): string | null {
  const branch = ctx.sessionManager?.getBranch?.();
  if (!branch) return null;
  let role: string | null = null;
  for (let i = 0; i < branch.length; i++) {
    const entry: SessionEntryLike | undefined = branch[i];
    if (!entry) continue;
    const isMarker =
      (typeof entry.customType === "string" && entry.customType === BINDING_CUSTOM_TYPE) ||
      (typeof entry.type === "string" && entry.type === BINDING_CUSTOM_TYPE);
    if (!isMarker) continue;
    // Canonical write: { type: "custom", customType, data: { role } }.
    const fromData = readRoleField(entry.data);
    if (fromData !== null) role = fromData;
    else {
      const fromEntry = readRoleField(entry);
      if (fromEntry !== null) role = fromEntry;
    }
  }
  return role;
}

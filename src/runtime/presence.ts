/**
 * Presence manager — advisory liveness for this runtime instance (PRD FR-3).
 *
 * Owns the single presence record for our instanceId: starts idle, heartbeats
 * on demand, flips between busy/idle as turns start and end, and marks the
 * record stopped on clean shutdown. All timestamps come from the injected
 * clock so tests stay deterministic.
 */
import type { AgentIdentity, PresenceRecord, PresenceState } from "../protocol/schemas.js";
import type { PresenceStore } from "../storage/types.js";
import { nowIso } from "../util/clock.js";
import { createLogger } from "../util/logger.js";
import type { Logger } from "../util/logger.js";

export interface PresenceManager {
  /** Upsert the initial idle record (startedAt = heartbeatAt = now). */
  start(): Promise<void>;
  /** Refresh heartbeatAt; optionally transition state (kept when omitted). */
  beat(state?: PresenceState): Promise<void>;
  setBusy(): Promise<void>;
  setIdle(): Promise<void>;
  /** Mark the persisted record stopped; further beats are ignored. */
  stop(at: string): Promise<void>;
}

export interface PresenceManagerDeps {
  identity: AgentIdentity;
  presenceStore: PresenceStore;
  now?: () => string;
  logger?: Logger;
}

export function createPresenceManager(deps: PresenceManagerDeps): PresenceManager {
  const now = deps.now ?? nowIso;
  const logger = deps.logger ?? createLogger("pi-swarm:presence");
  const { identity, presenceStore } = deps;

  let state: PresenceState = "idle";
  let startedAt: string | null = null;
  let stopped = false;

  const record = (heartbeatAt: string): PresenceRecord => ({
    version: 1,
    role: identity.role,
    instanceId: identity.instanceId,
    ...(identity.sessionId !== undefined ? { sessionId: identity.sessionId } : {}),
    pid: identity.pid,
    state,
    heartbeatAt,
    startedAt: startedAt ?? heartbeatAt,
  });

  const beat = async (next?: PresenceState): Promise<void> => {
    if (stopped) return;
    if (next !== undefined) state = next;
    const at = now();
    if (startedAt === null) startedAt = at;
    await presenceStore.upsert(record(at));
  };

  return {
    async start(): Promise<void> {
      stopped = false;
      state = "idle";
      startedAt = now();
      await presenceStore.upsert(record(startedAt));
      logger.debug("presence started", { instanceId: identity.instanceId, startedAt });
    },
    beat,
    async setBusy(): Promise<void> {
      await beat("busy");
    },
    async setIdle(): Promise<void> {
      await beat("idle");
    },
    async stop(at: string): Promise<void> {
      stopped = true;
      state = "stopped";
      await presenceStore.markStopped(identity.instanceId, at);
    },
  };
}

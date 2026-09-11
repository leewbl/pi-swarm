/**
 * Agent identity construction (architecture §3.7, PRD Workstream C).
 *
 * An instance id is `<role>-<lowercase ulid>`; the ULID suffix keeps ids
 * unique across restarts of the same role while remaining schema-valid
 * (INSTANCE_ID_RE). Identities are plain validated data — no host access.
 */
import { AgentIdentitySchema } from "../protocol/schemas.js";
import type { AgentIdentity } from "../protocol/schemas.js";
import { ulid } from "../util/ulid.js";

/** `${role}-${ulid().toLowerCase()}` — unique per runtime instance. */
export function newInstanceId(role: string): string {
  return `${role}-${ulid().toLowerCase()}`;
}

/** Build a schema-valid identity for a fresh runtime instance. */
export function newIdentity(role: string, pid: number, sessionId?: string): AgentIdentity {
  return AgentIdentitySchema.parse({
    role,
    instanceId: newInstanceId(role),
    pid,
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

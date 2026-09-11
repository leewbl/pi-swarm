/**
 * Canonical event vocabulary and pure event construction helpers.
 */
import type { Route, SwarmEvent } from "./schemas.js";
import { SwarmEventSchema, MAX_EVENT_BYTES, EventContextSchema } from "./schemas.js";
import { ulid } from "../util/ulid.js";
import { nowIso } from "../util/clock.js";

/** Canonical event types emitted by the runtime and domain tools. */
export const CANONICAL_EVENT_TYPES = [
  "task.opened",
  "task.claimed",
  "task.started",
  "task.completed",
  "task.failed",
  "task.abandoned",
  "task.reopened",
  "artifact.published",
  "blackboard.updated",
] as const;
export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

export function isCanonicalEventType(t: string): t is CanonicalEventType {
  return (CANONICAL_EVENT_TYPES as readonly string[]).includes(t);
}

export interface BuildEventInput {
  type: string;
  from: { role: string; instanceId: string };
  route: Route;
  context?: { taskId?: string; correlationId?: string; causationId?: string };
  data?: unknown;
  /** Override for deterministic tests. */
  id?: string;
  time?: string;
}

export interface BuildEventClock {
  now?: () => string;
  newId?: () => string;
}

/**
 * Construct a validated event. Throws on invalid input — callers must surface
 * the error to the tool call rather than appending malformed events.
 */
export function buildEvent(input: BuildEventInput, clock: BuildEventClock = {}): SwarmEvent {
  const event: SwarmEvent = SwarmEventSchema.parse({
    version: 1,
    id: input.id ?? clock.newId?.() ?? ulid(),
    time: input.time ?? clock.now?.() ?? nowIso(),
    type: input.type,
    from: input.from,
    route: input.route,
    ...(input.context !== undefined ? { context: EventContextSchema.parse(input.context) } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
  });
  return event;
}

/** Compact one-line JSON serialization with the payload size cap enforced. */
export function serializeEvent(event: SwarmEvent): string {
  const line = JSON.stringify(event);
  if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
    throw new Error(
      `event ${event.id} serialized size exceeds MAX_EVENT_BYTES=${MAX_EVENT_BYTES}; move large payloads to artifacts`,
    );
  }
  return line;
}

/**
 * EventService implementation (PRD FR-8): build a validated event, enforce the
 * serialized size cap, then append it to this instance's JSONL stream.
 *
 * Validation and size-cap failures are thrown as plain `Error`s with clear
 * messages so extension tools can surface them as `isError` results instead of
 * persisting malformed events.
 */
import { ZodError } from "zod";
import type { AgentIdentity, SwarmEvent } from "../protocol/schemas.js";
import { buildEvent, serializeEvent } from "../protocol/events.js";
import type { EventStore } from "../storage/types.js";
import type { EmitEventInput, EventService } from "./types.js";

export interface EventServiceDeps {
  eventStore: EventStore;
}

function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "event"}: ${issue.message}`)
      .join("; ");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function createEventService(deps: EventServiceDeps): EventService {
  const { eventStore } = deps;
  return {
    async emit(input: EmitEventInput, from: AgentIdentity): Promise<SwarmEvent> {
      let event: SwarmEvent;
      try {
        event = buildEvent({
          type: input.type,
          from: { role: from.role, instanceId: from.instanceId },
          route: input.route,
          ...(input.context !== undefined ? { context: input.context } : {}),
          ...(input.data !== undefined ? { data: input.data } : {}),
        });
      } catch (err) {
        throw new Error(`invalid event: ${describeError(err)}`);
      }
      // Enforce MAX_EVENT_BYTES before anything is persisted. serializeEvent
      // throws a clear error when the payload is too large.
      serializeEvent(event);
      await eventStore.append(event);
      return event;
    },
  };
}

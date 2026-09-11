/**
 * Event poller — the consumer half of the event loop (architecture §11–12,
 * PRD Workstream C).
 *
 * Every poll: list producer streams (minus our own — self events stay
 * observable only through audit tooling), resume each from our persisted
 * byte-offset cursor, apply the manifest routing filter (direct to our role,
 * broadcast on subscribed topics), dedupe by event id, and hand the matched
 * events to `onMatch`. Cursors advance only to the delivered/malformed
 * boundary — never past an incomplete trailing line — and only after
 * `onMatch` returns, giving at-least-once delivery with id-dedupe on top.
 */
import type { AgentIdentity, NormalizedAgentManifest, SwarmEvent } from "../protocol/schemas.js";
import type { CursorStore, EventStore } from "../storage/types.js";
import { nowIso } from "../util/clock.js";
import { createLogger } from "../util/logger.js";
import type { Logger } from "../util/logger.js";
import type { MatchedEvent } from "./ports.js";

/** Bounded FIFO-evicting dedupe window for already-delivered event ids. */
const DEDUPE_CAP = 5000;

export interface EventPoller {
  /** One polling cycle; resolves to the matched events delivered to onMatch. */
  poll(): Promise<MatchedEvent[]>;
  /** Total matched events delivered since construction. */
  readonly consumedCount: number;
  /** ISO time of the most recent poll start, or null before the first. */
  readonly lastPollAt: string | null;
}

export interface EventPollerDeps {
  identity: AgentIdentity;
  manifest: NormalizedAgentManifest;
  eventStore: EventStore;
  cursorStore: CursorStore;
  /** Receives matched events; a throw suppresses the cursor persist. */
  onMatch: (events: MatchedEvent[]) => void | Promise<void>;
  now?: () => string;
  logger?: Logger;
}

export function createEventPoller(deps: EventPollerDeps): EventPoller {
  const { identity, manifest, eventStore, cursorStore, onMatch } = deps;
  const now = deps.now ?? nowIso;
  const logger = deps.logger ?? createLogger("pi-swarm:event-poller");
  let consumedCount = 0;
  let lastPollAt: string | null = null;

  const seen = new Set<string>();
  const markSeen = (id: string): boolean => {
    if (seen.has(id)) return false;
    if (seen.size >= DEDUPE_CAP) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    seen.add(id);
    return true;
  };

  /** Routing filter per architecture §11.3–11.4: direct by role, broadcast by topic. */
  const matchRoute = (event: SwarmEvent): "direct" | "broadcast" | null => {
    if (event.route.mode === "direct") {
      return manifest.subscriptions.direct && event.route.role === identity.role
        ? "direct"
        : null;
    }
    return manifest.subscriptions.topics.includes(event.route.topic) ? "broadcast" : null;
  };

  return {
    async poll(): Promise<MatchedEvent[]> {
      lastPollAt = now();
      const streams = (await eventStore.listStreams()).filter(
        (stream) => stream !== identity.instanceId,
      );
      if (streams.length === 0) return [];

      const loaded = await cursorStore.load(identity.instanceId);
      const cursors = { ...loaded.streams };
      const matched: MatchedEvent[] = [];
      let dirty = false;

      for (const stream of streams) {
        const previous = cursors[stream];
        let offset = previous?.offset ?? 0;
        const size = await eventStore.streamSize(stream);
        if (offset > size) {
          // Truncated/replaced producer stream: replay it rather than stall.
          logger.warn("cursor offset beyond stream size; replaying stream", {
            stream,
            offset,
            size,
          });
          offset = 0;
        }

        const result = await eventStore.readFrom(stream, offset);
        let lastEventId = previous?.lastEventId ?? null;
        for (const event of result.events) {
          if (event.from.instanceId === identity.instanceId) continue;
          const channel = matchRoute(event);
          if (channel === null) continue;
          if (!markSeen(event.id)) continue;
          matched.push({
            event,
            channel,
            actionable: manifest.wakeup.events.includes(event.type),
          });
        }
        if (result.events.length > 0) {
          lastEventId = result.events[result.events.length - 1].id;
        }
        // `result.offset` is already the safe boundary: it stops after the
        // last complete line, so an incomplete trailing line is retried later.
        const next = { offset: result.offset, lastEventId };
        if (previous === undefined || previous.offset !== next.offset || previous.lastEventId !== next.lastEventId) {
          dirty = true;
        }
        cursors[stream] = next;
      }

      if (matched.length > 0) {
        await onMatch(matched);
        consumedCount += matched.length;
        logger.debug("events matched", { count: matched.length });
      }
      if (dirty) {
        await cursorStore.save(identity.instanceId, { streams: cursors });
      }
      return matched;
    },

    get consumedCount(): number {
      return consumedCount;
    },
    get lastPollAt(): string | null {
      return lastPollAt;
    },
  };
}

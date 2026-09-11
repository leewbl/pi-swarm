/**
 * File-backed EventStore — one JSONL stream per producer instance
 * (architecture §11).
 *
 * Appends are restricted to the owning instanceId bound at creation (single
 * writer per stream). Reads are byte-offset based: only complete `\n`-
 * terminated lines are consumed, so a torn write (crash mid-append) leaves
 * `trailingIncomplete` and its bytes are retried later. Complete-but-invalid
 * lines advance the offset (cursors never wedge) and are reported as
 * `malformed`.
 */
import { promises as fsp } from "node:fs";
import { ZodError } from "zod";
import { SwarmPaths } from "../util/paths.js";
import { INSTANCE_ID_RE, SwarmEventSchema } from "../protocol/schemas.js";
import type { SwarmEvent } from "../protocol/schemas.js";
import { serializeEvent } from "../protocol/events.js";
import type { EventReadResult, EventStore, MalformedLine } from "./types.js";

/** Stream file names are `<instanceId>.jsonl`; INSTANCE_ID_RE carries its own anchors. */
const STREAM_SUFFIX = ".jsonl";

export interface EventStoreOptions {
  /** The instance whose stream this store appends to (single-writer binding). */
  instanceId: string;
}

export function createEventStore(paths: SwarmPaths, options: EventStoreOptions): EventStore {
  const { instanceId } = options;
  if (!INSTANCE_ID_RE.test(instanceId)) {
    throw new Error(`invalid owning instanceId for event store: ${instanceId}`);
  }

  return {
    async append(event: SwarmEvent): Promise<void> {
      SwarmEventSchema.parse(event);
      if (event.from.instanceId !== instanceId) {
        throw new Error(
          `event ${event.id} is not owned by this stream: from.instanceId=${event.from.instanceId}, store instanceId=${instanceId}`,
        );
      }
      const line = serializeEvent(event);
      await fsp.mkdir(paths.eventsDir, { recursive: true });
      await fsp.appendFile(paths.eventStreamFile(instanceId), `${line}\n`, "utf8");
    },

    async readFrom(producerInstanceId: string, offset: number): Promise<EventReadResult> {
      if (!INSTANCE_ID_RE.test(producerInstanceId)) {
        return { events: [], offset, trailingIncomplete: false, malformed: [] };
      }
      const file = paths.eventStreamFile(producerInstanceId);
      let size: number;
      try {
        size = (await fsp.stat(file)).size;
      } catch {
        return { events: [], offset, trailingIncomplete: false, malformed: [] };
      }
      if (offset >= size) {
        return { events: [], offset, trailingIncomplete: false, malformed: [] };
      }

      const fh = await fsp.open(file, "r");
      try {
        const length = size - offset;
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, offset);

        const events: SwarmEvent[] = [];
        const malformed: MalformedLine[] = [];
        let lineStart = 0;
        let lineNo = 0;
        for (;;) {
          const newline = buf.indexOf(0x0a, lineStart);
          if (newline === -1) break;
          lineNo += 1;
          const text = buf.subarray(lineStart, newline).toString("utf8");
          try {
            events.push(SwarmEventSchema.parse(JSON.parse(text)));
          } catch (err) {
            const message =
              err instanceof ZodError
                ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
                : (err as Error).message;
            malformed.push({ line: lineNo, error: message });
          }
          lineStart = newline + 1;
        }
        const trailingIncomplete = lineStart < buf.length;
        return { events, offset: offset + lineStart, trailingIncomplete, malformed };
      } finally {
        await fh.close();
      }
    },

    async listStreams(): Promise<string[]> {
      let names: string[];
      try {
        names = await fsp.readdir(paths.eventsDir);
      } catch {
        return [];
      }
      return names
        .filter((name) => name.endsWith(STREAM_SUFFIX) && INSTANCE_ID_RE.test(name.slice(0, -STREAM_SUFFIX.length)))
        .map((name) => name.slice(0, -STREAM_SUFFIX.length))
        .sort();
    },

    async streamSize(producerInstanceId: string): Promise<number> {
      if (!INSTANCE_ID_RE.test(producerInstanceId)) return 0;
      try {
        return (await fsp.stat(paths.eventStreamFile(producerInstanceId))).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw err;
      }
    },
  };
}

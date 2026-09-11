/**
 * Integration fixtures: fs-backed EventStore/CursorStore over a real
 * SwarmPaths workspace, so byte-offset cursor discipline is exercised against
 * actual JSONL files. In-memory fakes (wake/timer/presence/task) come from
 * the shared unit-runtime fakes module.
 */
import { promises as fsp } from "node:fs";
import { SwarmPaths } from "../../../src/util/paths.js";
import { readFileIfExists, tmpWorkspaceDir, writeFileAtomic } from "../../../src/util/atomic-file.js";
import { CursorStateSchema, INSTANCE_ID_RE, SwarmEventSchema } from "../../../src/protocol/schemas.js";
import type { CursorState, SwarmEvent } from "../../../src/protocol/schemas.js";
import { serializeEvent } from "../../../src/protocol/events.js";
import type { CursorStore, EventReadResult, EventStore } from "../../../src/storage/types.js";
import { parseJsonlChunk } from "../../unit/runtime/fakes.js";

export interface Workspace {
  paths: SwarmPaths;
  cleanup: () => Promise<void>;
}

/** Fresh temp workspace with the full .pi/swarm layout created. */
export async function setupWorkspace(prefix = "pi-swarm-runtime"): Promise<Workspace> {
  const dir = await tmpWorkspaceDir(prefix);
  const paths = new SwarmPaths(dir);
  await paths.ensureLayout();
  return { paths, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

/** Thin fs JSONL event store: real append-only files, real byte offsets. */
export class FsEventStore implements EventStore {
  constructor(
    private readonly paths: SwarmPaths,
    private readonly ownInstanceId: string,
  ) {}

  async append(event: SwarmEvent): Promise<void> {
    if (event.from.instanceId !== this.ownInstanceId) {
      throw new Error(`append rejected: ${event.from.instanceId} is not the owning writer`);
    }
    const parsed = SwarmEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error(`append rejected: invalid event (${parsed.error.issues[0]?.message ?? "?"})`);
    }
    await fsp.mkdir(this.paths.eventsDir, { recursive: true });
    await fsp.appendFile(
      this.paths.eventStreamFile(this.ownInstanceId),
      `${serializeEvent(parsed.data)}\n`,
      "utf8",
    );
  }

  async readFrom(producerInstanceId: string, offset: number): Promise<EventReadResult> {
    let buf: Buffer;
    try {
      buf = await fsp.readFile(this.paths.eventStreamFile(producerInstanceId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { events: [], offset, trailingIncomplete: false, malformed: [] };
      }
      throw err;
    }
    return parseJsonlChunk(buf, offset);
  }

  async listStreams(): Promise<string[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.paths.eventsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((name) => name.endsWith(".jsonl") && INSTANCE_ID_RE.test(name.slice(0, -".jsonl".length)))
      .map((name) => name.slice(0, -".jsonl".length))
      .sort();
  }

  async streamSize(producerInstanceId: string): Promise<number> {
    try {
      return (await fsp.stat(this.paths.eventStreamFile(producerInstanceId))).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
  }
}

/** Cursor state as a real atomically-replaced JSON file per consumer. */
export class FsCursorStore implements CursorStore {
  constructor(private readonly paths: SwarmPaths) {}

  async load(consumerInstanceId: string): Promise<CursorState> {
    const text = await readFileIfExists(this.paths.cursorFile(consumerInstanceId));
    if (text === null) return { streams: {} };
    return CursorStateSchema.parse(JSON.parse(text));
  }

  async save(consumerInstanceId: string, state: CursorState): Promise<void> {
    await fsp.mkdir(this.paths.cursorsDir, { recursive: true });
    await writeFileAtomic(this.paths.cursorFile(consumerInstanceId), `${JSON.stringify(state, null, 2)}\n`);
  }
}

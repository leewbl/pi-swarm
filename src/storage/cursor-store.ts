/**
 * File-backed CursorStore — consumer-owned replay state (architecture §12).
 *
 * One JSON file per consumer at `runtime/cursors/<consumerInstanceId>.json`,
 * always replaced atomically (write temp -> rename). A missing file is an
 * empty state; a present-but-corrupt file throws with its path so the
 * runtime/doctor surfaces the damage instead of silently replaying.
 */
import { promises as fsp } from "node:fs";
import { readFileIfExists, writeFileAtomic } from "../util/atomic-file.js";
import { SwarmPaths } from "../util/paths.js";
import { CursorStateSchema, INSTANCE_ID_RE } from "../protocol/schemas.js";
import type { CursorState } from "../protocol/schemas.js";
import type { CursorStore } from "./types.js";

export function createCursorStore(paths: SwarmPaths): CursorStore {
  return {
    async load(consumerInstanceId: string): Promise<CursorState> {
      if (!INSTANCE_ID_RE.test(consumerInstanceId)) {
        throw new Error(`invalid consumer instanceId for cursor load: ${consumerInstanceId}`);
      }
      const file = paths.cursorFile(consumerInstanceId);
      const raw = await readFileIfExists(file);
      if (raw === null) return { streams: {} };

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(`corrupt cursor file ${file}: ${(err as Error).message}`);
      }
      const result = CursorStateSchema.safeParse(parsed);
      if (!result.success) {
        const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new Error(`invalid cursor state in ${file}: ${detail}`);
      }
      return result.data;
    },

    async save(consumerInstanceId: string, state: CursorState): Promise<void> {
      if (!INSTANCE_ID_RE.test(consumerInstanceId)) {
        throw new Error(`invalid consumer instanceId for cursor save: ${consumerInstanceId}`);
      }
      const valid = CursorStateSchema.parse(state);
      await fsp.mkdir(paths.cursorsDir, { recursive: true });
      await writeFileAtomic(paths.cursorFile(consumerInstanceId), `${JSON.stringify(valid, null, 2)}\n`);
    },
  };
}

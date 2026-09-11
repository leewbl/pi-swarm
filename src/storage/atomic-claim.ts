/**
 * File-backed ClaimStore — canonical task ownership (architecture §9).
 *
 * A claim is the single `claims/<taskId>.yaml` file: `tryClaim` is an O_EXCL
 * create, so exactly one contender wins across any number of processes.
 * EEXIST is a normal contention outcome, not an error.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readFileIfExists, tryCreateExclusive } from "../util/atomic-file.js";
import { SwarmPaths } from "../util/paths.js";
import { ClaimRecordSchema, TASK_ID_RE } from "../protocol/schemas.js";
import type { ClaimRecord } from "../protocol/schemas.js";
import type { ClaimStore, TryClaimResult } from "./types.js";

export function createClaimStore(paths: SwarmPaths): ClaimStore {
  return {
    async tryClaim(claim: ClaimRecord): Promise<TryClaimResult> {
      const valid = ClaimRecordSchema.parse(claim);
      await fsp.mkdir(paths.claimsDir, { recursive: true });
      const created = await tryCreateExclusive(paths.claimFile(valid.taskId), stringifyYaml(valid));
      return created ? { status: "claimed" } : { status: "already_claimed" };
    },

    async get(taskId: string): Promise<ClaimRecord | null> {
      if (!TASK_ID_RE.test(taskId)) return null;
      const raw = await readFileIfExists(paths.claimFile(taskId));
      if (raw === null) return null;
      try {
        const result = ClaimRecordSchema.safeParse(parseYaml(raw));
        return result.success ? result.data : null;
      } catch {
        return null;
      }
    },

    async list(): Promise<ClaimRecord[]> {
      let names: string[];
      try {
        names = (await fsp.readdir(paths.claimsDir)).sort();
      } catch {
        return [];
      }
      const records: ClaimRecord[] = [];
      for (const name of names) {
        if (!name.endsWith(".yaml")) continue;
        const raw = await readFileIfExists(path.join(paths.claimsDir, name));
        if (raw === null) continue;
        try {
          const result = ClaimRecordSchema.safeParse(parseYaml(raw));
          if (result.success) records.push(result.data);
        } catch {
          // Corrupt claim files are skipped; ownership is decided by file
          // existence, not parseability, so they still block re-claims.
        }
      }
      return records;
    },

    async remove(taskId: string, claimId: string): Promise<boolean> {
      if (!TASK_ID_RE.test(taskId)) return false;
      const file = paths.claimFile(taskId);
      const raw = await readFileIfExists(file);
      if (raw === null) return false;
      let stored: ClaimRecord;
      try {
        stored = ClaimRecordSchema.parse(parseYaml(raw));
      } catch {
        return false;
      }
      if (stored.claimId !== claimId) return false;
      try {
        await fsp.rm(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
      return true;
    },
  };
}

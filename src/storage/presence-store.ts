/**
 * File-backed PresenceStore — advisory liveness (PRD FR-3).
 *
 * One YAML record per live instance at `runtime/instances/<id>.yaml`,
 * replaced atomically on every heartbeat. Presence is advisory: unreadable
 * files are excluded from `list()` and reported via `issues()` instead of
 * crashing the liveness sweep. `markStopped` is the clean-shutdown path and
 * preserves every field except `state`/`heartbeatAt`.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readFileIfExists, writeFileAtomic } from "../util/atomic-file.js";
import { SwarmPaths } from "../util/paths.js";
import { INSTANCE_ID_RE, IsoTime, PresenceRecordSchema } from "../protocol/schemas.js";
import type { PresenceRecord } from "../protocol/schemas.js";
import type { PresenceFileIssue, PresenceStore } from "./types.js";

interface PresenceScan {
  valid: PresenceRecord[];
  issues: PresenceFileIssue[];
}

async function scanPresence(paths: SwarmPaths): Promise<PresenceScan> {
  const valid: PresenceRecord[] = [];
  const issues: PresenceFileIssue[] = [];

  let names: string[];
  try {
    names = (await fsp.readdir(paths.instancesDir)).sort();
  } catch {
    return { valid, issues };
  }

  for (const name of names) {
    if (!name.endsWith(".yaml")) continue;
    const raw = await readFileIfExists(path.join(paths.instancesDir, name));
    if (raw === null) continue;

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      issues.push({ file: name, error: `YAML parse error: ${(err as Error).message}` });
      continue;
    }
    const result = PresenceRecordSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      issues.push({ file: name, error: detail });
      continue;
    }
    valid.push(result.data);
  }
  return { valid, issues };
}

export function createPresenceStore(paths: SwarmPaths): PresenceStore {
  return {
    async upsert(record: PresenceRecord): Promise<void> {
      const valid = PresenceRecordSchema.parse(record);
      await fsp.mkdir(paths.instancesDir, { recursive: true });
      await writeFileAtomic(paths.presenceFile(valid.instanceId), stringifyYaml(valid));
    },

    async get(instanceId: string): Promise<PresenceRecord | null> {
      if (!INSTANCE_ID_RE.test(instanceId)) return null;
      const raw = await readFileIfExists(paths.presenceFile(instanceId));
      if (raw === null) return null;
      try {
        const result = PresenceRecordSchema.safeParse(parseYaml(raw));
        return result.success ? result.data : null;
      } catch {
        return null;
      }
    },

    async list(): Promise<PresenceRecord[]> {
      return (await scanPresence(paths)).valid;
    },

    async issues(): Promise<PresenceFileIssue[]> {
      return (await scanPresence(paths)).issues;
    },

    async markStopped(instanceId: string, stoppedAt: string): Promise<void> {
      if (!INSTANCE_ID_RE.test(instanceId)) return;
      IsoTime.parse(stoppedAt);
      const file = paths.presenceFile(instanceId);
      const raw = await readFileIfExists(file);
      if (raw === null) return;
      let stored: PresenceRecord;
      try {
        stored = PresenceRecordSchema.parse(parseYaml(raw));
      } catch {
        return; // Corrupt record: leave it for doctor; do not fabricate fields.
      }
      await writeFileAtomic(file, stringifyYaml({ ...stored, state: "stopped", heartbeatAt: stoppedAt }));
    },
  };
}

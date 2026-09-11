/**
 * File-backed ConfigStore and ManifestStore (PRD Workstream A).
 *
 * - `swarm.yaml` holds workspace configuration. Absence resolves to
 *   DEFAULT_SWARM_CONFIG; a present-but-invalid file throws with the file
 *   path in the message so `/swarm doctor` can point at the exact file.
 * - `agents/<role>.yaml` holds one manifest per role, written atomically.
 *   Duplicate declared roles across files are reported by `validate()`;
 *   the first declaration (sorted file order) wins for `list()`.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { fileExists, readFileIfExists, writeFileAtomic } from "../util/atomic-file.js";
import { SwarmPaths } from "../util/paths.js";
import { AgentManifestSchema, DEFAULT_SWARM_CONFIG, ROLE_ID_RE, SwarmConfigSchema } from "../protocol/schemas.js";
import type { AgentManifest, SwarmConfig } from "../protocol/schemas.js";
import type { ConfigStore, ManifestIssue, ManifestStore } from "./types.js";

export function createConfigStore(paths: SwarmPaths): ConfigStore {
  return {
    async load(): Promise<SwarmConfig> {
      const file = paths.swarmConfigFile();
      const raw = await readFileIfExists(file);
      if (raw === null) return DEFAULT_SWARM_CONFIG;

      let parsed: unknown;
      try {
        parsed = parseYaml(raw);
      } catch (err) {
        throw new Error(`invalid swarm config ${file}: ${(err as Error).message}`);
      }
      const result = SwarmConfigSchema.safeParse(parsed);
      if (!result.success) {
        const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new Error(`invalid swarm config ${file}: ${detail}`);
      }
      return result.data;
    },

    async save(config: SwarmConfig): Promise<void> {
      const valid = SwarmConfigSchema.parse(config);
      await fsp.mkdir(paths.swarmRoot, { recursive: true });
      await writeFileAtomic(paths.swarmConfigFile(), stringifyYaml(valid));
    },

    async exists(): Promise<boolean> {
      return fileExists(paths.swarmConfigFile());
    },
  };
}

interface ManifestScan {
  valid: AgentManifest[];
  issues: ManifestIssue[];
}

async function scanManifests(paths: SwarmPaths): Promise<ManifestScan> {
  const valid: AgentManifest[] = [];
  const issues: ManifestIssue[] = [];
  const ownerByRole = new Map<string, string>();

  let names: string[];
  try {
    names = (await fsp.readdir(paths.agentsDir)).sort();
  } catch {
    return { valid, issues };
  }

  for (const name of names) {
    if (!name.endsWith(".yaml")) continue;
    const raw = await readFileIfExists(path.join(paths.agentsDir, name));
    if (raw === null) continue;

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      issues.push({ file: name, error: `YAML parse error: ${(err as Error).message}` });
      continue;
    }

    const result = AgentManifestSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      issues.push({ file: name, error: detail });
      continue;
    }

    const role = result.data.agent.role;
    const owner = ownerByRole.get(role);
    if (owner !== undefined) {
      issues.push({ file: name, error: `duplicate agent role '${role}' (also declared in ${owner})` });
      continue;
    }
    ownerByRole.set(role, name);
    valid.push(result.data);
  }
  return { valid, issues };
}

export function createManifestStore(paths: SwarmPaths): ManifestStore {
  return {
    async list(): Promise<AgentManifest[]> {
      const { valid } = await scanManifests(paths);
      return valid.sort((a, b) => a.agent.role.localeCompare(b.agent.role));
    },

    async get(role: string): Promise<AgentManifest | null> {
      if (!ROLE_ID_RE.test(role)) return null;
      const raw = await readFileIfExists(paths.agentManifestFile(role));
      if (raw === null) return null;
      try {
        const result = AgentManifestSchema.safeParse(parseYaml(raw));
        return result.success ? result.data : null;
      } catch {
        return null;
      }
    },

    async save(manifest: AgentManifest): Promise<void> {
      const valid = AgentManifestSchema.parse(manifest);
      await fsp.mkdir(paths.agentsDir, { recursive: true });
      await writeFileAtomic(paths.agentManifestFile(valid.agent.role), stringifyYaml(valid));
    },

    async validate(): Promise<ManifestIssue[]> {
      return (await scanManifests(paths)).issues;
    },
  };
}

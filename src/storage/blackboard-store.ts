/**
 * File-backed BlackboardStore — permission-enforced shared knowledge
 * (PRD FR-16, architecture §13).
 *
 * Every access is confined to `.pi/swarm/blackboard/`: an escaping path is
 * rejected as `BlackboardDeniedError("traversal")` before any filesystem
 * call. Reads require one of the caller's manifest read globs to cover the
 * path; writes additionally pass the exact-key hotspot check from
 * `swarm.yaml` (`blackboard.hotspots[path] -> allowed roles`).
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { Dirent } from "node:fs";
import { readFileIfExists, writeFileAtomic } from "../util/atomic-file.js";
import { PathEscapeError, SwarmPaths } from "../util/paths.js";
import { matchAnyGlob } from "../util/glob.js";
import type { BlackboardStore } from "./types.js";
import { BlackboardDeniedError } from "./types.js";

/**
 * Resolve a blackboard-relative path ("findings/oauth.md") to an absolute
 * path inside the blackboard dir, translating any escape attempt into the
 * store's traversal denial.
 */
function resolveBlackboardPath(paths: SwarmPaths, rel: string): string {
  if (path.isAbsolute(rel)) {
    throw new BlackboardDeniedError("traversal", `absolute paths are not blackboard-relative: ${rel}`);
  }
  let abs: string;
  try {
    abs = paths.resolveRelative(`blackboard/${rel}`);
  } catch (err) {
    if (err instanceof PathEscapeError) {
      throw new BlackboardDeniedError("traversal", `blackboard path escapes the blackboard dir: ${rel}`);
    }
    throw err;
  }
  // resolveRelative confines to the swarm root; "blackboard/.." normalizes to
  // the swarm root itself, so re-confine to the blackboard dir explicitly.
  const confined = path.relative(paths.blackboardDir, abs);
  if (confined.length === 0 || confined.startsWith("..") || path.isAbsolute(confined)) {
    throw new BlackboardDeniedError("traversal", `blackboard path escapes the blackboard dir: ${rel}`);
  }
  return abs;
}

export function createBlackboardStore(paths: SwarmPaths): BlackboardStore {
  return {
    async read(relPath: string, viewerRole: string, readGlobs: readonly string[]): Promise<string> {
      const abs = resolveBlackboardPath(paths, relPath);
      if (!matchAnyGlob(readGlobs, relPath)) {
        throw new BlackboardDeniedError(
          "read",
          `role '${viewerRole}' has no blackboard read glob covering '${relPath}'`,
        );
      }
      const content = await readFileIfExists(abs);
      if (content === null) {
        throw new Error(`blackboard path does not exist: ${relPath}`);
      }
      return content;
    },

    async write(
      relPath: string,
      content: string,
      viewerRole: string,
      writeGlobs: readonly string[],
      hotspots: Readonly<Record<string, readonly string[]>>,
    ): Promise<void> {
      const abs = resolveBlackboardPath(paths, relPath);
      if (!matchAnyGlob(writeGlobs, relPath)) {
        throw new BlackboardDeniedError(
          "write",
          `role '${viewerRole}' has no blackboard write glob covering '${relPath}'`,
        );
      }
      const allowedRoles = hotspots[relPath];
      if (allowedRoles !== undefined && !allowedRoles.includes(viewerRole)) {
        throw new BlackboardDeniedError(
          "write",
          `blackboard hotspot '${relPath}' only allows [${allowedRoles.join(", ")}] to write (role '${viewerRole}' denied)`,
        );
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await writeFileAtomic(abs, content);
    },

    async list(relDir = ""): Promise<string[]> {
      const base = relDir === "" ? paths.blackboardDir : resolveBlackboardPath(paths, relDir);
      const found: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries: Dirent[];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return; // Missing/removed dir: empty listing.
        }
        for (const entry of entries) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(abs);
          else if (entry.isFile()) found.push(paths.relativeToSwarmRoot(abs));
        }
      };
      await walk(base);
      return found.sort();
    },
  };
}

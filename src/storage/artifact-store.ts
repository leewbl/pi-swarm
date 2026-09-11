/**
 * File-backed ArtifactStore — large outputs by reference (architecture §14).
 *
 * Artifacts live at `artifacts/<taskId>/<fileName>`; events carry only the
 * returned {@link ArtifactRef} (path + size + sha256 digest), never the
 * bytes. File names are restricted to a safe basename charset, and
 * `resolvePath` re-confines refs to the artifacts dir before touching disk.
 */
import { promises as fsp } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { sha256Hex } from "../util/atomic-file.js";
import { PathEscapeError, SwarmPaths } from "../util/paths.js";
import { ArtifactRefSchema, TaskId } from "../protocol/schemas.js";
import type { ArtifactRef } from "../protocol/schemas.js";
import type { ArtifactStore } from "./types.js";
import { ArtifactNameError } from "./types.js";

const ARTIFACT_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Crash-safe binary write; the shared util helper is string-only. */
async function writeBytesAtomic(absPath: string, content: Buffer): Promise<void> {
  const tmp = `${absPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, absPath);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

export function createArtifactStore(paths: SwarmPaths): ArtifactStore {
  return {
    async publish(
      taskId: string,
      fileName: string,
      content: string | Uint8Array,
      mediaType?: string,
    ): Promise<ArtifactRef> {
      TaskId.parse(taskId);
      if (!ARTIFACT_FILE_NAME_RE.test(fileName)) throw new ArtifactNameError(fileName);

      const dir = paths.artifactDir(taskId);
      const target = path.join(dir, fileName);
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      await fsp.mkdir(dir, { recursive: true });
      await writeBytesAtomic(target, bytes);

      return {
        path: paths.relativeToSwarmRoot(target),
        size: bytes.byteLength,
        digest: `sha256:${await sha256Hex(bytes)}`,
        ...(mediaType !== undefined ? { mediaType } : {}),
      };
    },

    async resolvePath(ref: ArtifactRef): Promise<string> {
      const valid = ArtifactRefSchema.parse(ref);
      const abs = paths.resolveRelative(valid.path); // throws PathEscapeError on traversal
      const rel = path.relative(paths.artifactsDir, abs);
      if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new PathEscapeError(valid.path);
      }
      return abs;
    },
  };
}

/**
 * Crash-safe file primitives.
 *
 * - `writeFileAtomic`: write temp -> fsync -> rename. Readers never observe
 *   a half-written cursor/task/presence file.
 * - `tryCreateExclusive`: O_EXCL create. This is the single ownership
 *   primitive behind task claims (architecture §9.3): EEXIST is a normal
 *   contention outcome, not an error.
 */
import { promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

export async function writeFileAtomic(absPath: string, content: string): Promise<void> {
  const tmp = `${absPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fh: FileHandle = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(content, "utf8");
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

export async function readFileIfExists(absPath: string): Promise<string | null> {
  try {
    return await fsp.readFile(absPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

/** Returns false when the file already exists (EEXIST). */
export async function tryCreateExclusive(absPath: string, content: string): Promise<boolean> {
  let fh: FileHandle;
  try {
    fh = await fsp.open(absPath, "wx");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw err;
  }
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  return true;
}

export async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fsp.access(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function sha256Hex(content: string | Uint8Array): Promise<string> {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

/** Fresh temp directory for test workspaces (one per test, caller cleans up). */
export async function tmpWorkspaceDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(tmpdir(), `${prefix}-`));
}

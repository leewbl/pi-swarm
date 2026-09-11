/**
 * File-backed TaskStore (PRD Workstream A).
 *
 * Tasks are Markdown documents with YAML front matter at
 * `tasks/<TASK-NNNN>.md`. Malformed files never crash the scan loop: they are
 * excluded from `list()` and surfaced through `issues()` for `/swarm doctor`.
 * `save(..., {create: true})` uses an exclusive create so concurrent task
 * creators cannot clobber each other (architecture §9.3).
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { parseDocument, serializeDocument } from "../util/frontmatter.js";
import { readFileIfExists, tryCreateExclusive, writeFileAtomic } from "../util/atomic-file.js";
import { SwarmPaths } from "../util/paths.js";
import { TaskDocumentSchema, TASK_ID_RE } from "../protocol/schemas.js";
import type { TaskDocument } from "../protocol/schemas.js";
import { TaskExistsError } from "./types.js";
import type { TaskStore } from "./types.js";

interface TaskScan {
  valid: TaskDocument[];
  issues: { file: string; error: string }[];
}

async function scanTasks(paths: SwarmPaths): Promise<TaskScan> {
  const valid: TaskDocument[] = [];
  const issues: { file: string; error: string }[] = [];

  let names: string[];
  try {
    names = (await fsp.readdir(paths.tasksDir)).sort();
  } catch {
    return { valid, issues };
  }

  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const raw = await readFileIfExists(path.join(paths.tasksDir, name));
    if (raw === null) continue;

    const doc = parseDocument(raw);
    if (doc === null) {
      issues.push({ file: name, error: "no valid YAML front matter block" });
      continue;
    }
    // On-disk format: flat metadata front matter + Markdown body (§7.1).
    // serializeDocument separates body with a blank line; parseDocument keeps
    // one separator newline, which is stripped here so save→get is identity
    // for canonical bodies.
    const result = TaskDocumentSchema.safeParse({ metadata: doc.data, body: doc.body.replace(/^\n/, "") });
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      issues.push({ file: name, error: detail });
      continue;
    }
    valid.push(result.data);
  }
  return { valid, issues };
}

/** Extract the numeric suffix of `TASK-<n>.md` names; -1 for non-matching names. */
const TASK_FILE_RE = /^TASK-(\d+)\.md$/;

export function createTaskStore(paths: SwarmPaths): TaskStore {
  return {
    async list(): Promise<TaskDocument[]> {
      const { valid } = await scanTasks(paths);
      return valid.sort((a, b) => a.metadata.id.localeCompare(b.metadata.id));
    },

    async get(taskId: string): Promise<TaskDocument | null> {
      if (!TASK_ID_RE.test(taskId)) return null;
      const raw = await readFileIfExists(paths.taskFile(taskId));
      if (raw === null) return null;
      const doc = parseDocument(raw);
      if (doc === null) return null;
      const result = TaskDocumentSchema.safeParse({ metadata: doc.data, body: doc.body.replace(/^\n/, "") });
      return result.success ? result.data : null;
    },

    async save(task: TaskDocument, mode?: { create?: boolean }): Promise<void> {
      const valid = TaskDocumentSchema.parse(task);
      const file = paths.taskFile(valid.metadata.id);
      const content = serializeDocument(valid.metadata, valid.body);
      await fsp.mkdir(paths.tasksDir, { recursive: true });
      if (mode?.create) {
        const created = await tryCreateExclusive(file, content);
        if (!created) throw new TaskExistsError(valid.metadata.id);
        return;
      }
      await writeFileAtomic(file, content);
    },

    async nextTaskId(): Promise<string> {
      let max = 0;
      try {
        const names = await fsp.readdir(paths.tasksDir);
        for (const name of names) {
          const match = TASK_FILE_RE.exec(name);
          if (match) max = Math.max(max, Number(match[1]));
        }
      } catch {
        // No tasks dir yet: start at TASK-0001.
      }
      return `TASK-${String(max + 1).padStart(4, "0")}`;
    },

    async issues(): Promise<{ file: string; error: string }[]> {
      return (await scanTasks(paths)).issues;
    },
  };
}

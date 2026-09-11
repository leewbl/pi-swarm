/**
 * Multiprocess claim contention (acceptance #1): four real `tsx` child
 * processes race tryClaim on the SAME task id; exactly one wins the O_EXCL
 * create, the rest observe already_claimed.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createClaimStore } from "../../src/storage/atomic-claim.js";
import { SwarmPaths } from "../../src/util/paths.js";
import { tmpWorkspaceDir } from "../../src/util/atomic-file.js";
import { promises as fsp } from "node:fs";

const execFileAsync = promisify(execFile);

const CHILD = path.resolve("tests/multiprocess/claim-child.ts");
const CONTENDERS = 4;

interface ChildOutcome {
  uniq: string;
  status: string;
  code: number;
}

function tsxCommand(): { cmd: string; prefix: string[] } {
  const local = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  if (existsSync(local)) return { cmd: local, prefix: [] };
  return { cmd: process.execPath, prefix: ["--import", "tsx"] };
}

let workspaceRoot: string | null = null;

afterAll(async () => {
  if (workspaceRoot) await fsp.rm(workspaceRoot, { recursive: true, force: true });
});

describe("multiprocess claim contention", () => {
  it(`yields exactly one winner among ${CONTENDERS} racing processes`, async () => {
    workspaceRoot = await tmpWorkspaceDir("pi-swarm-storage-mp-");
    const paths = new SwarmPaths(workspaceRoot);
    await paths.ensureLayout();

    const { cmd, prefix } = tsxCommand();
    const runs = Array.from({ length: CONTENDERS }, (_, i) => {
      const uniq = String(i + 1); // distinct claimId/instanceId per child
      const child = execFileAsync(cmd, [...prefix, CHILD, paths.claimsDir, "TASK-0001", "worker", uniq], {
        cwd: process.cwd(),
        timeout: 15_000,
      });
      return child.then(
        ({ stdout }): ChildOutcome => ({ uniq, status: stdout.trim(), code: 0 }),
        (err: unknown) => {
          const e = err as { code?: number; stdout?: string; killed?: boolean };
          if (e.killed) throw err;
          return { uniq, status: (e.stdout ?? "").trim(), code: typeof e.code === "number" ? e.code : -1 };
        },
      );
    });

    const outcomes = await Promise.all(runs);

    const statuses = outcomes.map((o) => o.status).sort();
    expect(statuses).toEqual(["already_claimed", "already_claimed", "already_claimed", "claimed"]);

    // Exit codes follow the contract: 0 for the winner, 3 for losers.
    const winner = outcomes.find((o) => o.status === "claimed");
    const losers = outcomes.filter((o) => o.status === "already_claimed");
    expect(winner?.code).toBe(0);
    expect(losers.map((l) => l.code)).toEqual([3, 3, 3]);

    // The winner's claim is the single file on disk and parses back.
    const files = await fsp.readdir(paths.claimsDir);
    expect(files).toEqual(["TASK-0001.yaml"]);
    const stored = await createClaimStore(paths).get("TASK-0001");
    expect(stored).not.toBeNull();
    expect(stored?.agent.role).toBe("worker");
    expect(stored?.claimId).toBe(`CLM-${winner!.uniq.padStart(26, "0")}`);
  });
});

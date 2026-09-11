import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isProcessAlive } from "../../../src/domain/process-alive.js";

describe("isProcessAlive", () => {
  it("never treats pid 0, 1, negatives, or non-integers as claimants", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(1)).toBe(false);
    expect(isProcessAlive(-5)).toBe(false);
    expect(isProcessAlive(4242.5)).toBe(false);
  });

  it("detects the current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("detects an exited child process as dead (ESRCH)", async () => {
    // Real platform behavior under test: liveness via process.kill(pid, 0).
    // Node reaps the child (waitpid) before emitting "exit", so awaiting the
    // exit event is the deterministic completion signal. Executor-form
    // promise because the frozen ES2023 lib predates Promise.withResolvers.
    const child = spawn("sleep", ["0.05"]);
    const pid = child.pid;
    if (pid === undefined) throw new Error("no pid");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    expect(isProcessAlive(pid)).toBe(false);
  });
});

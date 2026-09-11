/**
 * /swarm doctor (FR-20): read-only checks over a real tmp workspace layout
 * with fake stores — clean workspace reports no errors; malformed JSONL,
 * invalid cursors, manifest issues, and duplicate active instances are
 * surfaced with remediation hints; the atomic-create probe leaves no files.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpWorkspaceDir } from "../../../src/util/atomic-file.js";
import { SwarmPaths } from "../../../src/util/paths.js";
import { clearActiveBindings } from "../../../src/extension/binding.js";
import { renderDoctorReport, runDoctor } from "../../../src/extension/doctor.js";
import type { SwarmStack } from "../../../src/extension/compose.js";
import { makeAgentManifestDoc, makeFakeStack, makePresence } from "./fakes.js";

const NOW = "2026-09-11T12:00:00Z";
let ws: string;
let paths: SwarmPaths;

beforeEach(async () => {
  clearActiveBindings();
  ws = await tmpWorkspaceDir("pi-swarm-doctor");
  paths = new SwarmPaths(ws);
  await paths.ensureLayout();
  await fsp.writeFile(paths.swarmConfigFile(), "version: 1\n", "utf8");
});

afterEach(async () => {
  await fsp.rm(ws, { recursive: true, force: true });
});

function doctorStack(overrides: Partial<SwarmStack["stores"]> = {}): SwarmStack {
  const stack = makeFakeStack({
    paths,
    manifests: [
      makeAgentManifestDoc("backend"),
      makeAgentManifestDoc("tester"),
    ],
  });
  Object.assign(stack.stores, overrides);
  return stack;
}

describe("runDoctor", () => {
  it("reports a clean workspace with no errors and leaves no probe files", async () => {
    const report = await runDoctor(doctorStack(), { now: () => NOW, isProcessAlive: () => false });
    expect(report.errors).toBe(0);
    expect(report.findings.some((f) => f.level === "ok" && f.check === "atomic-create")).toBe(true);

    const claims = await fsp.readdir(paths.claimsDir);
    expect(claims.filter((f) => f.startsWith(".probe-"))).toEqual([]);

    // Running twice changes nothing (doctor never mutates).
    const again = await runDoctor(doctorStack(), { now: () => NOW, isProcessAlive: () => false });
    expect(again.errors).toBe(0);
    expect(again.findings.some((f) => f.level === "ok" && f.check === "atomic-create")).toBe(true);
    expect(await fsp.readdir(paths.claimsDir)).toEqual([]);
  });

  it("flags missing layout directories as errors with repair hints", async () => {
    await fsp.rm(paths.eventsDir, { recursive: true, force: true });
    await fsp.rm(path.join(paths.runtimeDir, "cursors"), { recursive: true, force: true });
    const report = await runDoctor(doctorStack(), { now: () => NOW });
    const layoutErrors = report.findings.filter((f) => f.check === "layout" && f.level === "error");
    expect(layoutErrors.map((f) => f.message)).toEqual(
      expect.arrayContaining(["missing directory events/", "missing directory runtime/cursors/"]),
    );
    expect(layoutErrors[0]?.hint).toContain("/swarm init");
  });

  it("surfaces manifest validation issues and duplicate active role instances", async () => {
    const stack = doctorStack({
      manifest: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        save: vi.fn(),
        validate: vi.fn(async () => [{ file: "agents/broken.yaml", error: "agent.role: required" }]),
      },
    });
    stack.stores.presence.list = vi.fn(async () => [
      makePresence({ pid: 11111, heartbeatAt: "2026-09-11T11:59:58Z" }),
      makePresence({ pid: 22222, instanceId: "backend-01ffffffffffffffffffffffff", heartbeatAt: "2026-09-11T11:59:59Z" }),
    ]);
    const report = await runDoctor(stack, { now: () => NOW, isProcessAlive: () => true });
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "error", check: "manifests", message: expect.stringContaining("broken.yaml") }),
        expect.objectContaining({
          level: "error",
          check: "presence",
          message: expect.stringContaining("2 active instances"),
        }),
      ]),
    );
    const rendered = renderDoctorReport(report);
    expect(rendered).toContain("[error] manifests: agents/broken.yaml");
    expect(rendered).toContain("[error] presence: role backend has 2 active instances");
    expect(rendered).toContain("hint:");
  });

  it("reports malformed JSONL lines and incomplete trailing lines", async () => {
    const stack = doctorStack();
    stack.stores.event.listStreams = vi.fn(async () => ["backend-01aaaaaaaaaaaaaaaaaaaaaaaa"]);
    stack.stores.event.readFrom = vi.fn(async () => ({
      events: [],
      offset: 100,
      trailingIncomplete: true,
      malformed: [{ line: 3, error: "Unexpected token } in JSON" }],
    }));
    const report = await runDoctor(stack, { now: () => NOW });
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          check: "events",
          message: expect.stringContaining("line 3"),
        }),
        expect.objectContaining({ level: "warning", check: "events", message: expect.stringContaining("incomplete trailing") }),
      ]),
    );
  });

  it("validates cursor files against the cursor schema and stream sizes", async () => {
    await fsp.writeFile(
      path.join(paths.cursorsDir, "tester-01aaaaaaaaaaaaaaaaaaaaaaaa.json"),
      "{ not json",
      "utf8",
    );
    await fsp.writeFile(
      path.join(paths.cursorsDir, "backend-01aaaaaaaaaaaaaaaaaaaaaaaa.json"),
      JSON.stringify({ streams: { "ghost-01bbbbbbbbbbbbbbbbbbbbbbbb.jsonl": { offset: 500, lastEventId: null } } }),
      "utf8",
    );
    const stack = doctorStack();
    stack.stores.event.streamSize = vi.fn(async () => 42);
    const report = await runDoctor(stack, { now: () => NOW });
    const cursorFindings = report.findings.filter((f) => f.check === "cursors");
    expect(cursorFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "error", message: expect.stringContaining("not valid JSON") }),
        expect.objectContaining({ level: "warning", message: expect.stringContaining("offset 500") }),
      ]),
    );
    expect(report.errors).toBeGreaterThanOrEqual(1);
  });

  it("notes roles with no blackboard write permissions as info", async () => {
    const readOnly = {
      ...makeAgentManifestDoc("observer"),
      blackboard: { read: ["project.md"], write: [] },
    };
    const stack = doctorStack();
    stack.stores.manifest.list = vi.fn(async () => [readOnly]);
    const report = await runDoctor(stack, { now: () => NOW });
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          check: "blackboard",
          message: expect.stringContaining("role observer has no blackboard write permissions"),
        }),
      ]),
    );
    expect(report.errors).toBe(0);
  });
});

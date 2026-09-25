import { describe, expect, it } from "vitest";
import { createPolicyService } from "../../../src/domain/policy-service.js";
import type { TaskDocument, TaskStatus } from "../../../src/protocol/schemas.js";
import { makeManifest } from "./fakes.js";

const policy = createPolicyService();

function task(opts: {
  id?: string;
  status?: TaskStatus;
  eligibleRoles?: string[];
  requiredCapabilities?: string[];
  dependsOn?: string[];
  blockedOn?: string[];
  availableAt?: string;
}): TaskDocument {
  return {
    metadata: {
      id: opts.id ?? "TASK-0001",
      status: opts.status ?? "open",
      kind: "general",
      priority: 50,
      ...(opts.eligibleRoles !== undefined ? { eligibleRoles: opts.eligibleRoles } : {}),
      ...(opts.requiredCapabilities !== undefined
        ? { requiredCapabilities: opts.requiredCapabilities }
        : {}),
      ...(opts.availableAt !== undefined ? { availableAt: opts.availableAt } : {}),
      createdBy: { role: "coordinator", instanceId: "coordinator-01abcdefghjkmnpqrstvwxyz01" },
      createdAt: "2026-09-11T10:00:00Z",
      updatedAt: "2026-09-11T10:00:00Z",
      dependsOn: opts.dependsOn ?? [],
      blockedOn: opts.blockedOn ?? [],
      inputs: [],
      outputs: [],
    },
    body: "# t\n\nbody",
  };
}

function statusIndex(entries: Record<string, TaskStatus>): Map<string, TaskStatus> {
  return new Map(Object.entries(entries));
}

describe("policy checkClaim eligibility matrix", () => {
  // -- role filter ----------------------------------------------------------

  it("allows any role when eligibleRoles is omitted", () => {
    const decision = policy.checkClaim(
      makeManifest({ role: "backend", claimRoles: ["backend"] }),
      task({}),
      false,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(decision).toEqual({ eligible: true });
  });

  it("allows any role when eligibleRoles is an empty list", () => {
    const decision = policy.checkClaim(
      makeManifest({ role: "backend" }),
      task({ eligibleRoles: [] }),
      false,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(decision).toEqual({ eligible: true });
  });

  it("allows when claimRoles intersect eligibleRoles", () => {
    const manifest = makeManifest({ role: "worker", claimRoles: ["backend", "tester"] });
    const decision = policy.checkClaim(
      manifest,
      task({ eligibleRoles: ["researcher", "backend"] }),
      false,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(decision).toEqual({ eligible: true });
  });

  it("denies with reason 'role' when there is no intersection", () => {
    const manifest = makeManifest({ role: "worker", claimRoles: ["backend"] });
    const decision = policy.checkClaim(
      manifest,
      task({ eligibleRoles: ["researcher", "tester"] }),
      false,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("role");
    expect(decision.detail).toContain("researcher");
  });

  // -- capabilities ---------------------------------------------------------

  it("passes capabilities when requiredCapabilities is omitted", () => {
    const decision = policy.checkClaim(
      makeManifest({ role: "backend", capabilities: [] }),
      task({}),
      false,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(decision).toEqual({ eligible: true });
  });

  it("mode 'all' requires every capability", () => {
    const manifest = makeManifest({
      role: "backend",
      capabilities: ["rust", "sql"],
      capabilityMode: "all",
    });
    const ok = policy.checkClaim(
      manifest,
      task({ requiredCapabilities: ["rust", "sql"] }),
      false,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(ok).toEqual({ eligible: true });

    const missing = policy.checkClaim(
      manifest,
      task({ requiredCapabilities: ["rust", "kubernetes"] }),
      false,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(missing.eligible).toBe(false);
    expect(missing.reason).toBe("capabilities");
    expect(missing.detail).toContain("all");
  });

  it("mode 'any' requires at least one capability", () => {
    const manifest = makeManifest({
      role: "backend",
      capabilities: ["sql"],
      capabilityMode: "any",
    });
    const ok = policy.checkClaim(
      manifest,
      task({ requiredCapabilities: ["rust", "sql"] }),
      false,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(ok).toEqual({ eligible: true });

    const missing = policy.checkClaim(
      manifest,
      task({ requiredCapabilities: ["rust", "kubernetes"] }),
      false,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(missing.eligible).toBe(false);
    expect(missing.reason).toBe("capabilities");
  });

  // -- dependencies ---------------------------------------------------------

  it("passes when every dependency is done", () => {
    const decision = policy.checkClaim(
      makeManifest({ role: "backend" }),
      task({ dependsOn: ["TASK-0001", "TASK-0002"] }),
      false,
      statusIndex({ "TASK-0001": "done", "TASK-0002": "done", "TASK-0003": "open" }),
    );
    expect(decision).toEqual({ eligible: true });
  });

  it("denies with reason 'dependencies' when a dependency is not done", () => {
    const decision = policy.checkClaim(
      makeManifest({ role: "backend" }),
      task({ dependsOn: ["TASK-0001"] }),
      false,
      statusIndex({ "TASK-0001": "in_progress" }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("dependencies");
    expect(decision.detail).toContain("in_progress");
  });

  it("denies with reason 'dependencies' when a dependency task is missing", () => {
    const decision = policy.checkClaim(
      makeManifest({ role: "backend" }),
      task({ dependsOn: ["TASK-9999"] }),
      false,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("dependencies");
    expect(decision.detail).toContain("does not exist");
  });

  // -- status & claim gates -------------------------------------------------

  it("denies with reason 'status' for any non-open task", () => {
    for (const status of ["claimed", "in_progress", "done", "failed", "abandoned"] as const) {
      const decision = policy.checkClaim(
        makeManifest({ role: "backend" }),
        task({ status }),
        false,
        statusIndex({ "TASK-0001": status }),
      );
      expect(decision.eligible).toBe(false);
      expect(decision.reason).toBe("status");
    }
  });

  it("denies with reason 'claimed' when a claim record exists", () => {
    const decision = policy.checkClaim(
      makeManifest({ role: "backend" }),
      task({}),
      true,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("claimed");
  });

  // -- precedence -----------------------------------------------------------

  it("checks status before claim existence", () => {
    // Task Markdown drifted to 'claimed' and a claim exists: status wins.
    const decision = policy.checkClaim(
      makeManifest({ role: "backend" }),
      task({ status: "claimed" }),
      true,
      statusIndex({ "TASK-0001": "claimed" }),
    );
    expect(decision.reason).toBe("status");
  });

  it("checks claim existence before role", () => {
    const decision = policy.checkClaim(
      makeManifest({ role: "backend", claimRoles: ["backend"] }),
      task({ eligibleRoles: ["researcher"] }),
      true,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(decision.reason).toBe("claimed");
  });

  it("checks role before capabilities", () => {
    const decision = policy.checkClaim(
      makeManifest({ role: "backend", capabilities: [] }),
      task({ eligibleRoles: ["researcher"], requiredCapabilities: ["magic"] }),
      false,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(decision.reason).toBe("role");
  });

  it("checks capabilities before dependencies", () => {
    const decision = policy.checkClaim(
      makeManifest({ role: "backend", capabilities: [] }),
      task({ requiredCapabilities: ["magic"], dependsOn: ["TASK-0009"] }),
      false,
      statusIndex({ "TASK-0001": "open" }),
    );
    expect(decision.reason).toBe("capabilities");
  });
});

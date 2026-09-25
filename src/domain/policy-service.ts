/**
 * Eligibility policy (PRD FR-5): pure decision logic deciding whether one
 * manifest may claim one task. No I/O — callers supply the task document, the
 * claim-existence flag, and a status index for dependency resolution.
 *
 * Structural liveness fix: this module now also gates `availableAt` (durable
 * scheduling) and `blockedOn` (durable obligations), shared by the legacy
 * path. Topology-aware resolution for tasks WITH a workDomain lives in
 * `candidate-resolver.ts`; the claim service consults both.
 */
import type { EligibilityDecision, IneligibleReason, PolicyService } from "./types.js";
import type { NormalizedAgentManifest, TaskDocument, TaskStatus } from "../protocol/schemas.js";

/**
 * Statuses an owned task may legitimately show while a claim record exists
 * (architecture §9.5 — the claim file is canonical ownership truth).
 */
export const CLAIM_CONSISTENT_STATUSES: Record<TaskStatus, boolean> = {
  open: false,
  claimed: true,
  in_progress: true,
  blocked: true,
  done: true,
  failed: true,
  abandoned: false,
};

export function createPolicyService(): PolicyService {
  return {
    checkClaim(
      manifest: NormalizedAgentManifest,
      task: TaskDocument,
      hasClaim: boolean,
      statusIndex: ReadonlyMap<string, TaskStatus>,
      opts?: { now?: string },
    ): EligibilityDecision {
      const meta = task.metadata;

      // 1. Pool gate: only open tasks are claimable, whatever else is true.
      if (meta.status !== "open") {
        return deny("status", `task ${meta.id} is ${meta.status}, not open`);
      }

      // 2. Ownership gate: a canonical claim record wins over anything else.
      if (hasClaim) {
        return deny("claimed", `task ${meta.id} already has an owner`);
      }

      // 3. Scheduling gate: availableAt is a durable one-shot due time.
      const now = opts?.now;
      if (
        meta.availableAt !== undefined &&
        now !== undefined &&
        Date.parse(now) < Date.parse(meta.availableAt)
      ) {
        return deny("not_due", `task ${meta.id} is not due until ${meta.availableAt}`);
      }

      // 3b. Obligation gate: open tasks with unresolved blockedOn wait.
      for (const obligation of meta.blockedOn) {
        const status = statusIndex.get(obligation);
        if (status === undefined) {
          return deny("blocked_on", `task ${meta.id} is blocked on ${obligation}, which does not exist`);
        }
        if (status !== "done") {
          return deny("blocked_on", `task ${meta.id} is blocked on ${obligation} (${status})`);
        }
      }

      // 4. Role gate: an absent/empty eligibleRoles list means "any role".
      const roleGate = meta.eligibleRoles ?? [];
      if (roleGate.length > 0 && !roleGate.some((r) => manifest.claimRoles.includes(r))) {
        return deny(
          "role",
          `task ${meta.id} requires one of [${roleGate.join(", ")}]; ${manifest.role} offers [${manifest.claimRoles.join(", ")}]`,
        );
      }

      // 5. Capability gate: requiredCapabilities combined per manifest mode.
      const required = meta.requiredCapabilities;
      if (required && required.length > 0) {
        const have = new Set(manifest.capabilities);
        const satisfied =
          manifest.capabilityMode === "any"
            ? required.some((c) => have.has(c))
            : required.every((c) => have.has(c));
        if (!satisfied) {
          return deny(
            "capabilities",
            `task ${meta.id} requires (${manifest.capabilityMode}) [${required.join(", ")}]; ${manifest.role} has [${manifest.capabilities.join(", ")}]`,
          );
        }
      }

      // 6. Dependency gate: every dependency must exist and be done.
      for (const dep of meta.dependsOn) {
        const depStatus = statusIndex.get(dep);
        if (depStatus === undefined) {
          return deny("dependencies", `task ${meta.id} depends on ${dep}, which does not exist`);
        }
        if (depStatus !== "done") {
          return deny("dependencies", `task ${meta.id} depends on ${dep}, which is ${depStatus}`);
        }
      }

      return { eligible: true };
    },
  };
}

function deny(reason: IneligibleReason, detail: string): EligibilityDecision {
  return { eligible: false, reason, detail };
}

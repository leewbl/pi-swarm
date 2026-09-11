/**
 * Multiprocess claim-contention child (PRD Workstream A acceptance #1).
 *
 * argv: <claimsDir> <taskId> <role> <uniq>
 *
 * Derives the workspace root from the claims dir, constructs a valid
 * ClaimRecord through the REAL ClaimStore.tryClaim (O_EXCL), prints exactly
 * "claimed" (exit 0) or "already_claimed" (exit 3).
 */
import path from "node:path";
import { SwarmPaths } from "../../src/util/paths.js";
import { createClaimStore } from "../../src/storage/atomic-claim.js";

async function main(): Promise<number> {
  const [claimsDir, taskIdArg, role, uniq] = process.argv.slice(2);
  if (!claimsDir || !taskIdArg || !role || !uniq) {
    console.error("usage: claim-child.ts <claimsDir> <taskId> <role> <uniq>");
    return 2;
  }

  // claimsDir = <workspaceRoot>/.pi/swarm/claims (three levels below the root)
  const root = path.resolve(claimsDir, "..", "..", "..");
  const store = createClaimStore(new SwarmPaths(root));

  const padded = uniq.slice(0, 26).padStart(26, "0");
  const result = await store.tryClaim({
    version: 1,
    taskId: taskIdArg,
    claimId: `CLM-${padded.toUpperCase()}`,
    agent: { role, instanceId: `${role}-${padded}` },
    pid: process.pid,
    claimedAt: new Date().toISOString(),
  });

  console.log(result.status);
  return result.status === "claimed" ? 0 : 3;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });

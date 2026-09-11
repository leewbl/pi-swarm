/**
 * Headless multi-instance smoke test — proves the full coordination loop
 * WITHOUT oh-my-pi: workspace init -> task creation -> pull discovery ->
 * atomic claim -> lifecycle -> event fan-out -> cursor replay -> contention.
 *
 * Run after merge: `npx tsx scripts/smoke-headless.ts`
 * Exit code 0 = all scenarios passed.
 */
import { promises as fsp } from "node:fs";
import { SwarmPaths } from "../src/util/paths.js";
import { tmpWorkspaceDir } from "../src/util/atomic-file.js";
import { createLogger } from "../src/util/logger.js";
import { nowIso } from "../src/util/clock.js";
import {
  AgentManifestSchema,
  normalizeAgentManifest,
  type SwarmInboxMessage,
} from "../src/protocol/schemas.js";
import { createConfigStore, createManifestStore } from "../src/storage/filesystem.js";
import { createTaskStore } from "../src/storage/task-store.js";
import { createClaimStore } from "../src/storage/atomic-claim.js";
import { createEventStore } from "../src/storage/event-store.js";
import { createCursorStore } from "../src/storage/cursor-store.js";
import { createPresenceStore } from "../src/storage/presence-store.js";
import { createTaskService } from "../src/domain/task-service.js";
import { createPolicyService } from "../src/domain/policy-service.js";
import { createRecoveryService } from "../src/domain/recovery-service.js";
import { createEventService } from "../src/domain/event-service.js";
import { newIdentity } from "../src/runtime/identity.js";
import { createEventPoller } from "../src/runtime/event-poller.js";
import { createInbox } from "../src/runtime/inbox.js";
import type { WakePort } from "../src/runtime/ports.js";

const log = createLogger("smoke", { debug: true, sink: (l) => console.log(l) });
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    log.info(`PASS ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    log.error(`FAIL ${name} ${detail}`);
  }
}

function manifestYaml(role: string, caps: string[], topics: string[], claimRoles: string[]): object {
  return AgentManifestSchema.parse({
    version: 1,
    agent: { role, name: role },
    capabilities: caps,
    taskPolicy: { claim: { roles: claimRoles, capabilities: { mode: "all" } } },
    subscriptions: { direct: true, broadcast: { topics } },
    wakeup: { taskAvailable: true, events: ["task.opened", "task.completed"] },
  });
}

async function main(): Promise<void> {
  const root = await tmpWorkspaceDir("pi-swarm-smoke");
  const paths = new SwarmPaths(root);
  await paths.ensureLayout();
  log.info("workspace", { root: paths.swarmRoot });

  // --- stores ------------------------------------------------------------
  const configStore = createConfigStore(paths);
  const config = await configStore.load();
  const manifestStore = createManifestStore(paths);
  await manifestStore.save(AgentManifestSchema.parse(manifestYaml("coordinator", ["planning"], ["tasks", "decisions"], [])));
  await manifestStore.save(AgentManifestSchema.parse(manifestYaml("backend", ["api", "typescript"], ["tasks", "architecture"], ["backend"])));
  await manifestStore.save(AgentManifestSchema.parse(manifestYaml("tester", ["verification"], ["tasks"], ["tester"])));
  check("manifests validate", (await manifestStore.validate()).length === 0);

  const taskStore = createTaskStore(paths);
  const claimStore = createClaimStore(paths);
  const cursorStore = createCursorStore(paths);
  const presenceStore = createPresenceStore(paths);

  // --- instance A: coordinator creates work -------------------------------
  const coordinator = newIdentity("coordinator", process.pid);
  const eventStoreA = createEventStore(paths, { instanceId: coordinator.instanceId });
  const eventsA = createEventService({ eventStore: eventStoreA });
  const taskServiceA = createTaskService({
    taskStore,
    claimStore,
    policy: createPolicyService(),
    eventService: eventsA,
  });

  const implTask = await taskServiceA.create(
    {
      title: "Implement status endpoint",
      body: "## Goal\n\nReturn task pool counts.\n\n## Acceptance Criteria\n\n- GET /status works",
      kind: "implementation",
      priority: 70,
      eligibleRoles: ["backend"],
      requiredCapabilities: ["api"],
    },
    coordinator,
  );
  check("task created open", implTask.ok && implTask.task.metadata.status === "open");
  const implId = implTask.ok ? implTask.task.metadata.id : "";

  const verifyTask = await taskServiceA.create(
    {
      title: "Verify status endpoint",
      body: "## Goal\n\nRegression-test the endpoint.",
      eligibleRoles: ["tester"],
      dependsOn: [implId],
    },
    coordinator,
  );
  const verifyId = verifyTask.ok ? verifyTask.task.metadata.id : "";
  check("dependency task created", verifyTask.ok);

  // --- instance B: backend discovers via task scan + events ---------------
  const backend = newIdentity("backend", process.pid);
  const backendManifest = normalizeAgentManifest(await manifestStore.get("backend"));
  const eventStoreB = createEventStore(paths, { instanceId: backend.instanceId });
  const eventsB = createEventService({ eventStore: eventStoreB });
  const taskServiceB = createTaskService({
    taskStore,
    claimStore,
    policy: createPolicyService(),
    eventService: eventsB,
  });

  const inbox = createInbox();
  const delivered: SwarmInboxMessage[] = [];
  const wake: WakePort = {
    isIdle: () => true,
    deliver: (msg) => {
      delivered.push(msg);
    },
  };
  void wake;

  const pollerB = createEventPoller({
    identity: backend,
    manifest: backendManifest,
    eventStore: createEventStore(paths, { instanceId: backend.instanceId }),
    cursorStore,
    onMatch: (matched) => inbox.enqueueEvents(matched),
  });
  const consumed = await pollerB.poll();
  check("backend consumed task.opened broadcasts", consumed.length >= 2, `got ${consumed.length}`);

  const openForBackend = await taskServiceB.list({
    forAgent: { identity: backend, manifest: backendManifest },
    statuses: ["open"],
  });
  const implView = openForBackend.find((t) => t.metadata.id === implId);
  check("backend sees eligible impl task", implView !== undefined && implView.eligible);

  const testerManifest = normalizeAgentManifest(await manifestStore.get("tester"));
  const tester = newIdentity("tester", process.pid);
  const taskServiceT = createTaskService({
    taskStore,
    claimStore,
    policy: createPolicyService(),
    eventService: createEventService({
      eventStore: createEventStore(paths, { instanceId: tester.instanceId }),
    }),
  });
  const openForTester = await taskServiceT.list({
    forAgent: { identity: tester, manifest: testerManifest },
    statuses: ["open"],
  });
  const verifyView = openForTester.find((t) => t.metadata.id === verifyId);
  check("dependency-unsatisfied task hidden", verifyView === undefined || !verifyView.eligible);

  // --- atomic claim + contention ------------------------------------------
  const claimB = await taskServiceB.claim(implId, { identity: backend, manifest: backendManifest });
  check("backend claim ok", claimB.status === "claimed", JSON.stringify(claimB));

  const claimant = { identity: backend, manifest: backendManifest };
  void claimant;
  const secondBackend = newIdentity("backend", process.pid);
  const claimB2 = await taskServiceB.claim(implId, {
    identity: secondBackend,
    manifest: backendManifest,
  });
  check("second claimant loses", claimB2.status === "already_claimed", JSON.stringify(claimB2));

  const claimFileRaw = await fsp.readFile(paths.claimFile(implId), "utf8");
  check("claim file canonical exists", claimFileRaw.includes(implId));

  // --- lifecycle ------------------------------------------------------------
  const claimId = claimB.status === "claimed" ? claimB.claim.claimId : "";
  const started = await taskServiceB.start(implId, claimId, backend);
  check("start ok", started.ok);
  const wrongOwner = await taskServiceB.start(implId, claimId, secondBackend);
  check("wrong owner rejected", !wrongOwner.ok);
  const completed = await taskServiceB.complete(implId, claimId, backend, {
    summary: "endpoint implemented",
    outputs: ["artifacts/status.patch"],
  });
  check("complete ok", completed.ok && completed.task.metadata.status === "done");

  // dependency satisfied now -> tester eligible
  const openForTester2 = await taskServiceT.list({
    forAgent: { identity: tester, manifest: testerManifest },
    statuses: ["open"],
  });
  const verifyView2 = openForTester2.find((t) => t.metadata.id === verifyId);
  check("dependency-satisfied task visible", verifyView2 !== undefined && verifyView2.eligible);

  // --- event fan-out + cursor replay ---------------------------------------
  const testerPoller = createEventPoller({
    identity: tester,
    manifest: testerManifest,
    eventStore: createEventStore(paths, { instanceId: tester.instanceId }),
    cursorStore,
    onMatch: (matched) => inbox.enqueueEvents(matched),
  });
  await testerPoller.poll();
  const msg = inbox.drain();
  check(
    "inbox consolidated batch",
    msg !== null && (msg.body.includes("task.completed") || msg.body.includes("task.claimed")),
    msg?.body ?? "no message",
  );
  const again = await testerPoller.poll();
  check("re-poll delivers nothing new", again.length === 0, `got ${again.length}`);

  // --- interrupted claim reconciliation -------------------------------------
  const orphanTask = await taskServiceA.create(
    { title: "Orphaned work", body: "claim then die", eligibleRoles: ["backend"] },
    coordinator,
  );
  const orphanId = orphanTask.ok ? orphanTask.task.metadata.id : "";
  await claimStore.tryClaim({
    version: 1,
    taskId: orphanId,
    claimId: `CLM-${"0".repeat(26)}`,
    agent: { role: "backend", instanceId: backend.instanceId },
    pid: 999999999, // dead pid
    claimedAt: nowIso(),
  });
  // no markdown update -> drift
  const recovery = createRecoveryService({
    taskStore,
    claimStore,
    presenceStore,
    eventService: eventsA,
    config,
    now: nowIso,
  });
  const repaired = await recovery.reconcile();
  check("reconcile repairs claim/markdown drift", repaired.some((r) => r.taskId === orphanId));

  console.log("");
  console.log(failures.length === 0 ? "SMOKE OK" : `SMOKE FAILED: ${failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  await fsp.rm(root, { recursive: true, force: true });
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SMOKE CRASHED", err);
  process.exit(2);
});


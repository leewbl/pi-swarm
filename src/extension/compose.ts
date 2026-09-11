/**
 * Composition root (integration-only module; unit tests inject fakes instead
 * of importing this). Builds the full file-backed stack over a workspace —
 * stores from src/storage, services from src/domain — and re-exports the
 * runtime wiring so the rest of src/extension never imports src/runtime
 * directly.
 */
import { SwarmPaths } from "../util/paths.js";
import { nowIso } from "../util/clock.js";
import { ulid } from "../util/ulid.js";
import type { SwarmConfig } from "../protocol/schemas.js";
import { createConfigStore, createManifestStore } from "../storage/filesystem.js";
import { createTaskStore } from "../storage/task-store.js";
import { createClaimStore } from "../storage/atomic-claim.js";
import { createEventStore } from "../storage/event-store.js";
import { createCursorStore } from "../storage/cursor-store.js";
import { createPresenceStore } from "../storage/presence-store.js";
import { createBlackboardStore } from "../storage/blackboard-store.js";
import { createArtifactStore } from "../storage/artifact-store.js";
import { createPolicyService } from "../domain/policy-service.js";
import { createTaskService } from "../domain/task-service.js";
import { createRecoveryService } from "../domain/recovery-service.js";
import { createEventService } from "../domain/event-service.js";
import { createSwarmRuntime } from "../runtime/runtime.js";
import { newIdentity } from "../runtime/identity.js";
import type {
  ArtifactStore,
  BlackboardStore,
  ClaimStore,
  ConfigStore,
  CursorStore,
  EventStore,
  ManifestStore,
  PresenceStore,
  TaskStore,
} from "../storage/types.js";
import type { EventService, PolicyService, RecoveryService, TaskService } from "../domain/types.js";

export interface SwarmStackStores {
  config: ConfigStore;
  manifest: ManifestStore;
  task: TaskStore;
  claim: ClaimStore;
  event: EventStore;
  cursor: CursorStore;
  presence: PresenceStore;
  blackboard: BlackboardStore;
  artifact: ArtifactStore;
}

export interface SwarmStackServices {
  policy: PolicyService;
  events: EventService;
  task: TaskService;
  recovery: RecoveryService;
}

export interface SwarmStack {
  paths: SwarmPaths;
  config: SwarmConfig;
  stores: SwarmStackStores;
  services: SwarmStackServices;
}

export interface BuildStackOptions {
  /** Owning instance for the event stream this stack appends to. */
  instanceId?: string;
}

export async function buildSwarmStack(
  workspaceRoot: string,
  opts: BuildStackOptions = {},
): Promise<SwarmStack> {
  const paths = new SwarmPaths(workspaceRoot);
  const instanceId = opts.instanceId ?? `system-${ulid().toLowerCase()}`;
  const stores: SwarmStackStores = {
    config: createConfigStore(paths),
    manifest: createManifestStore(paths),
    task: createTaskStore(paths),
    claim: createClaimStore(paths),
    event: createEventStore(paths, { instanceId }),
    cursor: createCursorStore(paths),
    presence: createPresenceStore(paths),
    blackboard: createBlackboardStore(paths),
    artifact: createArtifactStore(paths),
  };
  const config = await stores.config.load();
  const policy = createPolicyService();
  const events = createEventService({ eventStore: stores.event });
  const services: SwarmStackServices = {
    policy,
    events,
    task: createTaskService({
      taskStore: stores.task,
      claimStore: stores.claim,
      policy,
      eventService: events,
      now: nowIso,
    }),
    recovery: createRecoveryService({
      taskStore: stores.task,
      claimStore: stores.claim,
      presenceStore: stores.presence,
      eventService: events,
      config,
      now: nowIso,
    }),
  };
  return { paths, config, stores, services };
}

export { createSwarmRuntime, newIdentity };

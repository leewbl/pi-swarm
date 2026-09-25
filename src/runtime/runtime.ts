/**
 * SwarmRuntime — composes the coordination loops (PRD Workstream C,
 * architecture §15 + structural liveness fix §21).
 *
 * Host-free: presence, event polling, task scanning, inbox consolidation,
 * wake scheduling, and the liveness watchdog are wired here against ports and
 * stores only. All timing goes through the injectable TimerPort so tests
 * drive loops with pollEventsOnce()/scanTasksOnce()/watchdogTick() instead
 * of real timers.
 */
import type {
  AgentIdentity,
  NormalizedAgentManifest,
  SwarmConfig,
} from "../protocol/schemas.js";
import type {
  ClaimRecord,
} from "../protocol/schemas.js";
import type {
  CursorStore,
  EventStore,
  ManifestStore,
  PresenceStore,
  TaskStore,
} from "../storage/types.js";
import type { TaskService } from "../domain/types.js";
import { buildActiveTopology } from "../domain/topology.js";
import { evaluateLiveness } from "../domain/liveness-service.js";
import { nowIso } from "../util/clock.js";
import type { Logger } from "../util/logger.js";
import { createLogger } from "../util/logger.js";
import { globalTimerPort } from "./ports.js";
import type { MatchedEvent, RuntimeStatus, TimerPort, WakePort } from "./ports.js";
import { createPresenceManager } from "./presence.js";
import type { PresenceManager } from "./presence.js";
import { createEventPoller } from "./event-poller.js";
import type { EventPoller } from "./event-poller.js";
import { createTaskPoller } from "./task-poller.js";
import type { TaskCandidate, TaskPoller } from "./task-poller.js";
import { createInbox } from "./inbox.js";
import type { Inbox } from "./inbox.js";
import { createWakeScheduler } from "./wake-scheduler.js";
import type { WakeScheduler } from "./wake-scheduler.js";

export interface SwarmRuntimeDeps {
  identity: AgentIdentity;
  manifest: NormalizedAgentManifest;
  config: SwarmConfig;
  taskService: TaskService;
  eventStore: EventStore;
  cursorStore: CursorStore;
  presenceStore: PresenceStore;
  wake: WakePort;
  /** Optional task document source for candidate titles in wake messages. */
  taskStore?: TaskStore;
  /** Optional manifest source for the liveness watchdog topology. */
  manifestStore?: ManifestStore;
  /** Optional claim source for the liveness watchdog (defaults: none). */
  claimList?: () => Promise<ClaimRecord[]>;
  /** Optional local-host PID probe for the watchdog topology. */
  isProcessAlive?: (pid: number) => boolean;
  timers?: TimerPort;
  now?: () => string;
  logger?: Logger;
}

export class SwarmRuntime {
  private readonly identity: AgentIdentity;
  private readonly manifest: NormalizedAgentManifest;
  private readonly config: SwarmConfig;
  private readonly timers: TimerPort;
  private readonly now: () => string;
  private readonly logger: Logger;
  private readonly presence: PresenceManager;
  private readonly eventPoller: EventPoller;
  private readonly taskPoller: TaskPoller;
  private readonly inbox: Inbox;
  private readonly scheduler: WakeScheduler;
  private readonly wake: WakePort;
  private readonly deps: SwarmRuntimeDeps;
  private running = false;
  private lastWakeAtMs = 0;
  private handles: { event: unknown; task: unknown; heartbeat: unknown } = {
    event: null,
    task: null,
    heartbeat: null,
  };

  constructor(deps: SwarmRuntimeDeps) {
    this.deps = deps;
    this.identity = deps.identity;
    this.manifest = deps.manifest;
    this.config = deps.config;
    this.timers = deps.timers ?? globalTimerPort;
    this.now = deps.now ?? nowIso;
    this.logger = deps.logger ?? createLogger("pi-swarm:runtime");

    this.inbox = createInbox();
    this.presence = createPresenceManager({
      identity: deps.identity,
      presenceStore: deps.presenceStore,
      now: this.now,
      logger: this.logger,
    });
    this.eventPoller = createEventPoller({
      identity: deps.identity,
      manifest: deps.manifest,
      eventStore: deps.eventStore,
      cursorStore: deps.cursorStore,
      onMatch: (events) => this.inbox.enqueueEvents(events),
      now: this.now,
      logger: this.logger,
    });
    this.taskPoller = createTaskPoller({
      identity: deps.identity,
      manifest: deps.manifest,
      taskService: deps.taskService,
      ...(deps.taskStore ? { taskStore: deps.taskStore } : {}),
      now: this.now,
      logger: this.logger,
    });
    this.scheduler = createWakeScheduler({ wake: deps.wake, logger: this.logger });
    this.wake = deps.wake;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.presence.start();
    this.running = true;
    this.handles.event = this.timers.setInterval(
      () => void this.guard("eventPoll", () => this.pollEventsOnce()),
      this.config.runtime.eventPollIntervalMs,
    );
    if (this.manifest.wakeup.taskAvailable) {
      this.handles.task = this.timers.setInterval(
        () => void this.guard("taskScan", () => this.scanTasksOnce()),
        this.config.runtime.taskScanIntervalMs,
      );
    }
    this.handles.heartbeat = this.timers.setInterval(
      () =>
        void this.guard("heartbeat", async () => {
          await this.syncPresence();
          await this.watchdogTick();
        }),
      this.config.runtime.heartbeatIntervalMs,
    );
  }

  async stop(): Promise<void> {
    for (const key of ["event", "task", "heartbeat"] as const) {
      if (this.handles[key] !== null) {
        this.timers.clearInterval(this.handles[key]);
      }
      this.handles[key] = null;
    }
    this.running = false;
    await this.presence.stop(this.now());
  }

  status(): RuntimeStatus {
    return {
      role: this.identity.role,
      instanceId: this.identity.instanceId,
      running: this.running,
      lastTaskScanAt: this.taskPoller.lastScanAt,
      lastEventPollAt: this.eventPoller.lastPollAt,
      pendingWake: this.inbox.pendingCount(),
      consumedEvents: this.eventPoller.consumedCount,
    };
  }

  /** One event-poll cycle (poll → inbox → wake flush), no timer needed. */
  async pollEventsOnce(): Promise<MatchedEvent[]> {
    const matched = await this.eventPoller.poll();
    await this.wakeFlush();
    return matched;
  }

  /** One task-scan cycle (poll → inbox → wake flush), no timer needed. */
  async scanTasksOnce(): Promise<TaskCandidate[]> {
    const candidates = await this.taskPoller.poll();
    this.inbox.enqueueTasks(candidates);
    await this.wakeFlush();
    return candidates;
  }

  /** Presence -> busy (call when the agent starts a turn). */
  async markBusy(): Promise<void> {
    await this.presence.setBusy();
  }

  /** Presence -> idle (call when the host settles, e.g. session_stop). */
  async markIdle(): Promise<void> {
    await this.presence.setIdle();
  }

  /**
   * Presence reconciliation (fix §20): heartbeats carry the HOST's idle
   * truth (ctx.isIdle()), never an agent_end guess. Stale presence plus a
   * live PID stays suspect — never silently overwritten from here.
   */
  async syncPresence(): Promise<void> {
    await this.presence.beat(this.wake.isIdle() ? "idle" : "busy");
  }

  /**
   * Host settle boundary (fix §20/§33): session_stop is an immediate
   * reconciliation point — sync presence truth, drain both polling loops,
   * and flush the inbox, instead of waiting for the next interval tick.
   */
  async settle(): Promise<void> {
    await this.syncPresence();
    await this.pollEventsOnce();
    await this.scanTasksOnce();
  }

  /**
   * Liveness watchdog (fix §21) — final safety net, never the scheduler.
   * While idle: due+serviceable work with no progress past the warning
   * threshold and no recent wake gets re-surfaced (rewake throttle) plus an
   * inbox warning. Requires task/manifest stores and a claim source;
   * silently skips otherwise (unit runtimes without them).
   */
  async watchdogTick(): Promise<void> {
    if (!this.wake.isIdle()) return;
    const taskStore = this.deps.taskStore;
    const manifestStore = this.deps.manifestStore;
    const claimList = this.deps.claimList;
    if (!taskStore || !manifestStore || !claimList) return;
    const now = this.now();
    const nowMs = Date.parse(now);
    if (this.lastWakeAtMs !== 0 && nowMs - this.lastWakeAtMs < this.config.liveness.rewakeAfterMs) {
      return;
    }
    const [tasks, presence, manifests, claims] = await Promise.all([
      taskStore.list(),
      this.deps.presenceStore.list(),
      manifestStore.list(),
      claimList(),
    ]);
    const topology = buildActiveTopology(presence, manifests, {
      nowIso: now,
      presenceStaleMs: this.config.runtime.presenceStaleMs,
      ...(this.deps.isProcessAlive !== undefined
        ? { isProcessAlive: this.deps.isProcessAlive }
        : {}),
    });
    const statusIndex = new Map(tasks.map((t) => [t.metadata.id, t.metadata.status] as const));
    const report = evaluateLiveness({
      nowIso: now,
      warningAfterMs: this.config.liveness.warningAfterMs,
      fallbackEnabled: this.config.scheduling.fallbackEnabled,
      tasks,
      claims,
      topology,
      statusIndex,
      forInstanceIds: [this.identity.instanceId],
    });
    if (report.stalled.length > 0) {
      this.taskPoller.resurface(report.stalled.map((f) => f.taskId));
      this.inbox.enqueueWarning(
        `LIVENESS WARNING: ${report.stalled.length} serviceable task(s) stalled without progress: ` +
          report.stalled.map((f) => `${f.taskId} (${f.state})`).join(", "),
      );
      await this.wakeFlush();
    }
  }

  /** Peek → deliver → ack/nack; a failed delivery keeps the batch queued. */
  private async wakeFlush(): Promise<void> {
    const message = this.inbox.peek();
    if (message === null) return;
    try {
      await this.scheduler.deliver(message, message.kind, message.kind === "actionable");
    } catch (err) {
      // Structural liveness fix §19: a failed wake must not lose the batch.
      this.inbox.nack();
      throw err;
    }
    this.lastWakeAtMs = Date.parse(this.now());
    this.inbox.ack();
    this.taskPoller.flushNotified();
  }

  /** Timer callbacks must never surface as unhandled rejections. */
  private async guard(label: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (err) {
      this.logger.error(`${label} loop failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Factory form used by the extension surface (composition reference). Kept as
 * a named constructor seam for dependency-injection call sites.
 */
export function createSwarmRuntime(deps: SwarmRuntimeDeps): SwarmRuntime {
  return new SwarmRuntime(deps);
}

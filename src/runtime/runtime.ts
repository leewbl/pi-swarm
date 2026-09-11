/**
 * SwarmRuntime — composes the coordination loops (PRD Workstream C,
 * architecture §15).
 *
 * Host-free: presence, event polling, task scanning, inbox consolidation and
 * wake scheduling are wired here against ports and stores only. All timing
 * goes through the injectable TimerPort so tests drive loops with
 * pollEventsOnce()/scanTasksOnce() instead of real timers.
 */
import type {
  AgentIdentity,
  NormalizedAgentManifest,
  SwarmConfig,
} from "../protocol/schemas.js";
import type { CursorStore, EventStore, PresenceStore, TaskStore } from "../storage/types.js";
import type { TaskService } from "../domain/types.js";
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
  private running = false;
  private handles: { event: unknown; task: unknown; heartbeat: unknown } = {
    event: null,
    task: null,
    heartbeat: null,
  };

  constructor(deps: SwarmRuntimeDeps) {
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
      () => void this.guard("heartbeat", () => this.presence.beat()),
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

  /** Presence -> idle (call when the agent's turn ends). */
  async markIdle(): Promise<void> {
    await this.presence.setIdle();
  }

  /** Drain the inbox and deliver it as one batch; re-arms task surfacing. */
  private async wakeFlush(): Promise<void> {
    const message = this.inbox.drain();
    if (message === null) return;
    await this.scheduler.deliver(message, message.kind, message.kind === "actionable");
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

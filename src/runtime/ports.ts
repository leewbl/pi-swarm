/**
 * Runtime port contracts (PRD Workstream C/D boundary).
 *
 * The coordination runtime (task pool loop, event loop, inbox, wake
 * scheduler) is host-free and testable: the oh-my-pi adapter in
 * `src/extension/` implements these ports with `ctx.isIdle()` /
 * `pi.sendMessage()` / `ctx.setInterval()`.
 */
import type { SwarmEvent } from "../protocol/schemas.js";

// ---------------------------------------------------------------------------
// Wake port — how the runtime notifies the Pi session
// ---------------------------------------------------------------------------

export type WakeKind = "actionable" | "informational" | "warning";

export interface SwarmInboxMessage {
  kind: WakeKind;
  /** Short header, e.g. `SWARM INBOX — 2 actionable tasks`. */
  title: string;
  /** Concise rendered body: counts, task ids/titles/paths, references. */
  body: string;
}

/**
 * Delivery policy mapping (fix review — actionable wake semantics):
 * - actionable (any idle state) -> { deliverAs: "followUp", triggerTurn: true }
 *   Actionable durable work requires the agent to complete a follow-up
 *   turn, not ride as an ambient aside.
 * - active + informational      -> { deliverAs: "aside" }  (step boundary)
 * - warnings / idle informational -> { deliverAs: "followUp" }
 * `steer` is never used by swarm coordination.
 */
export type WakeDelivery =
  | { deliverAs: "aside"; triggerTurn: true }
  | { deliverAs: "aside" }
  | { deliverAs: "followUp" }
  | { deliverAs: "followUp"; triggerTurn: true };

export interface WakePort {
  isIdle(): boolean;
  deliver(message: SwarmInboxMessage, delivery: WakeDelivery): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Timer port — managed intervals (ctx.setInterval on the host)
// ---------------------------------------------------------------------------

export interface TimerPort {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Production default: global timers (tests inject fakes). */
export const globalTimerPort: TimerPort = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

// ---------------------------------------------------------------------------
// Consumer-facing loop state (status rendering, tests)
// ---------------------------------------------------------------------------

export interface RuntimeStatus {
  role: string;
  instanceId: string;
  running: boolean;
  lastTaskScanAt: string | null;
  lastEventPollAt: string | null;
  pendingWake: number;
  consumedEvents: number;
}

export interface MatchedEvent {
  event: SwarmEvent;
  /** direct | broadcast routing channel that matched. */
  channel: "direct" | "broadcast";
  /** Whether the manifest wakeup policy marks it actionable. */
  actionable: boolean;
}

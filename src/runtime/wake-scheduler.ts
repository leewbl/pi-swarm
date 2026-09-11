/**
 * Wake scheduler — delivery policy for inbox batches (architecture §16).
 *
 * Pure mapping from (kind, actionable, idle) to a WakeDelivery; `steer` is
 * never produced — swarm coordination must not hijack a running turn. Idle +
 * actionable interrupts with a triggered turn; informational asides ride the
 * step boundary while active; everything else defers to a follow-up.
 */
import type { SwarmInboxMessage, WakeDelivery, WakeKind, WakePort } from "./ports.js";
import { createLogger } from "../util/logger.js";
import type { Logger } from "../util/logger.js";

export function decideDelivery(kind: WakeKind, actionable: boolean, isIdle: boolean): WakeDelivery {
  if ((actionable || kind === "actionable") && isIdle) {
    return { deliverAs: "aside", triggerTurn: true };
  }
  if (!isIdle && kind === "informational") {
    return { deliverAs: "aside" };
  }
  return { deliverAs: "followUp" };
}

export interface WakeScheduler {
  /** Apply the §16 mapping to the port's current idle state and deliver. */
  deliver(message: SwarmInboxMessage, kind: WakeKind, actionable: boolean): Promise<void>;
}

export interface WakeSchedulerDeps {
  wake: WakePort;
  logger?: Logger;
}

export function createWakeScheduler(deps: WakeSchedulerDeps): WakeScheduler {
  const logger = deps.logger ?? createLogger("pi-swarm:wake-scheduler");
  return {
    async deliver(message, kind, actionable): Promise<void> {
      const delivery = decideDelivery(kind, actionable, deps.wake.isIdle());
      logger.debug("wake delivery", { kind, deliverAs: delivery.deliverAs, title: message.title });
      await deps.wake.deliver(message, delivery);
    },
  };
}

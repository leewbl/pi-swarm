/**
 * oh-my-pi extension entrypoint (PRD Workstream D): registers the `/swarm`
 * command, the 13 domain tools, and the session hooks — role re-binding on
 * session start, contract injection before each agent run, busy/idle
 * tracking, context hygiene, and runtime shutdown. The real stack/runtime
 * wiring comes from compose.ts; everything here is host adaptation.
 */
import { createLogger } from "../util/logger.js";
import { locateSwarmRoot } from "../util/paths.js";
import { nowIso } from "../util/clock.js";
import { buildSwarmStack, createSwarmRuntime, newIdentity } from "./compose.js";
import { bindRole, registerSwarmCommands } from "./commands.js";
import type { SwarmCommandDeps } from "./commands.js";
import { registerSwarmTools } from "./tools.js";
import { renderRoleContract } from "./contract.js";
import { createCtxRef } from "./pi-api.js";
import type { ExtensionHook, PiCtxLike, PiLike, SessionMessage } from "./pi-api.js";
import { clearActiveBindings, getActiveBinding, rebuildBindingFromSession } from "./binding.js";

export const INBOX_CUSTOM_TYPE = "pi-swarm.inbox";
export const CONTRACT_CUSTOM_TYPE = "pi-swarm.contract";

function isSwarmMessage(message: SessionMessage, customType: string): boolean {
  return message.customType === customType;
}

/**
 * Context hook body (PRD FR-15): keep only the newest swarm inbox message and
 * the newest role contract so repeated runtime notifications never grow the
 * model context unboundedly.
 */
export function filterSwarmMessages(messages: readonly SessionMessage[]): { messages: SessionMessage[] } {
  let lastInbox = -1;
  let lastContract = -1;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (isSwarmMessage(message, INBOX_CUSTOM_TYPE)) lastInbox = i;
    else if (isSwarmMessage(message, CONTRACT_CUSTOM_TYPE)) lastContract = i;
  }
  return {
    messages: messages.filter((message, i) => {
      if (isSwarmMessage(message, INBOX_CUSTOM_TYPE)) return i === lastInbox;
      if (isSwarmMessage(message, CONTRACT_CUSTOM_TYPE)) return i === lastContract;
      return true;
    }),
  };
}

function extractMessages(payload: unknown): readonly SessionMessage[] | null {
  if (payload !== null && typeof payload === "object" && "messages" in payload) {
    const { messages } = payload;
    if (Array.isArray(messages)) return messages;
  }
  return null;
}

/** Wrap a hook so a failure is logged and swallowed, never breaking the host. */
function safeHook(name: string, hook: ExtensionHook, onError: (msg: string, err: unknown) => void): ExtensionHook {
  return async (ctx, payload) => {
    try {
      return await hook(ctx, payload);
    } catch (err) {
      onError(`${name} hook failed`, err);
      return undefined;
    }
  };
}

export default function piSwarmExtension(pi: PiLike): void {
  pi.setLabel("Pi Swarm");
  const logger = createLogger("pi-swarm", { sink: (line) => pi.logger?.info?.(line) });
  // omp 18.1.10 exposes the workspace cwd on the load-time context; hook
  // contexts carry only {type}, so session_start falls back to this.
  const loadCwd = pi.cwd;
  const ctxRef = createCtxRef();
  const deps: SwarmCommandDeps = {
    buildStack: buildSwarmStack,
    createRuntime: createSwarmRuntime,
    newIdentity,
    now: nowIso,
    logger,
    ctxRef,
  };

  registerSwarmCommands(pi, deps);
  registerSwarmTools(pi, () => {
    const binding = getActiveBinding();
    return binding
      ? { identity: binding.identity, manifest: binding.manifest, stack: binding.stack }
      : null;
  });

  const onHookError = (msg: string, err: unknown) => {
    logger.error(msg, { error: err instanceof Error ? err.message : String(err) });
  };

  pi.on(
    "session_start",
    safeHook("session_start", async (ctx: PiCtxLike) => {
      ctxRef.set(ctx);
      const cwd = ctx.cwd ?? loadCwd;
      if (!cwd) {
        logger.debug("no cwd available on session_start; skipping swarm re-bind");
        return undefined;
      }
      const paths = await locateSwarmRoot(cwd);
      if (!paths) {
        logger.debug("no swarm workspace under cwd", { cwd });
        return undefined;
      }
      const role = rebuildBindingFromSession(ctx);
      if (!role || getActiveBinding()?.role === role) return undefined;
      const result = await bindRole(pi, ctx, role, deps);
      if (result.ok) {
        ctx.ui?.notify?.(`Pi Swarm: re-bound to role ${role} (${result.instanceId}).`, "info");
      } else {
        ctx.ui?.notify?.(`Pi Swarm: could not re-bind role ${role}: ${result.message}`, "warn");
      }
      return undefined;
    }, onHookError),
  );

  pi.on(
    "before_agent_start",
    safeHook("before_agent_start", async () => {
      const binding = getActiveBinding();
      if (!binding) return undefined;
      let claimedTask = null;
      const claims = await binding.stack.stores.claim.list();
      const mine = claims.find((c) => c.agent.instanceId === binding.identity.instanceId);
      if (mine) claimedTask = await binding.stack.services.task.get(mine.taskId);
      const status = binding.runtime.status();
      const inboxSummary =
        status.pendingWake > 0 ? `${status.pendingWake} pending wake item(s)` : null;
      const contract = renderRoleContract({
        manifest: binding.manifest,
        identity: binding.identity,
        claimedTask,
        inboxSummary,
      });
      return { message: { customType: CONTRACT_CUSTOM_TYPE, content: contract, display: "info" } };
    }, onHookError),
  );

  pi.on(
    "agent_start",
    safeHook("agent_start", () => {
      getActiveBinding()?.runtime.markBusy?.();
      return undefined;
    }, onHookError),
  );

  pi.on(
    "agent_end",
    safeHook("agent_end", () => {
      getActiveBinding()?.runtime.markIdle?.();
      return undefined;
    }, onHookError),
  );

  pi.on(
    "context",
    safeHook("context", (_ctx: PiCtxLike, payload?: unknown) => {
      const messages = extractMessages(payload);
      return messages === null ? undefined : filterSwarmMessages(messages);
    }, onHookError),
  );

  pi.on(
    "session_shutdown",
    safeHook("session_shutdown", () => {
      const binding = getActiveBinding();
      if (!binding) return undefined;
      clearActiveBindings();
      void Promise.resolve(binding.runtime.stop()).catch(() => undefined);
      return undefined;
    }, onHookError),
  );
}

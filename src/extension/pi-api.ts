/**
 * Minimal structural oh-my-pi host API, declared locally by the extension
 * layer (Product Invariant 6): nothing outside src/extension imports from the
 * host, and only this file describes the host surface. Every shape is kept
 * loose (`unknown`-friendly) so the real host objects are structurally
 * assignable without code changes here.
 */
import type { SwarmInboxMessage, TimerPort, WakeDelivery, WakePort } from "../runtime/ports.js";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolResultContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolResultContent[];
  details?: unknown;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  /** Parameter schema object (zod schema in this codebase). */
  parameters: unknown;
  execute: (
    id: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: PiCtxLike,
  ) => Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type CommandHandler = (args: string[], ctx: PiCtxLike) => void | Promise<void>;

export interface CommandDefinition {
  description: string;
  handler: CommandHandler;
}

// ---------------------------------------------------------------------------
// Messages and session entries
// ---------------------------------------------------------------------------

export interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface SessionMessage {
  role?: string;
  customType?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface SendMessagePayload {
  customType?: string;
  content?: unknown;
  display?: string;
  details?: unknown;
  [key: string]: unknown;
}

export interface SendMessageOptions {
  deliverAs?: string;
  triggerTurn?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Host context
// ---------------------------------------------------------------------------

export interface PiCtxLike {
  cwd: string;
  ui: { notify(msg: string, level?: string): unknown };
  isIdle?(): boolean;
  sessionManager?: { getBranch?(): ArrayLike<SessionEntryLike> };
  /** Managed interval; clear through clearTimeout/clearTimer. */
  setInterval?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  clearTimer?(handle: unknown): void;
}

export interface PiLoggerLike {
  info?(msg: string): void;
  error?(msg: string): void;
  debug?(msg: string): void;
}

export type HookResult = unknown;
export type ExtensionHook = (ctx: PiCtxLike, payload?: unknown) => HookResult | Promise<HookResult>;

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export interface PiLike {
  on(event: string, handler: ExtensionHook): unknown;
  registerTool(def: ToolDefinition): unknown;
  registerCommand(name: string, def: CommandDefinition): unknown;
  sendMessage(payload: SendMessagePayload, opts?: SendMessageOptions): unknown;
  /**
   * Session-local extension state. Accepts either a full entry object (used
   * for `custom` entries carrying a customType) or a (type, data) pair.
   */
  appendEntry(entryOrType: SessionEntryLike | string, data?: unknown): unknown;
  setLabel(label: string): unknown;
  logger?: PiLoggerLike;
}

// ---------------------------------------------------------------------------
// Adapters built on the host surface
// ---------------------------------------------------------------------------

/** Mutable holder for the current session context (hooks + commands set it). */
export interface CtxRef {
  get(): PiCtxLike | null;
  set(ctx: PiCtxLike | null): void;
}

export function createCtxRef(): CtxRef {
  let current: PiCtxLike | null = null;
  return {
    get: () => current,
    set: (ctx) => {
      current = ctx;
    },
  };
}

/** Managed timers via ctx.setInterval with a global fallback (FR-13). */
export function ctxTimerPort(ctx: PiCtxLike): TimerPort {
  return {
    setInterval: (fn, ms) => (ctx.setInterval ? ctx.setInterval(fn, ms) : setInterval(fn, ms)),
    clearInterval: (handle) => {
      if (ctx.clearTimeout) ctx.clearTimeout(handle);
      else if (ctx.clearTimer) ctx.clearTimer(handle);
      else clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
}

/**
 * OMP wake adapter: runtime inbox messages become `pi-swarm.inbox` host
 * messages with the delivery policy mapped from WakeDelivery (architecture
 * §16). `steer` is never used.
 */
export function createOmpWakePort(pi: PiLike, getCtx: () => PiCtxLike | null): WakePort {
  return {
    isIdle: () => getCtx()?.isIdle?.() ?? true,
    deliver: (message: SwarmInboxMessage, delivery: WakeDelivery) => {
      const opts: SendMessageOptions = {
        deliverAs: delivery.deliverAs,
        ...("triggerTurn" in delivery && delivery.triggerTurn ? { triggerTurn: true } : {}),
      };
      pi.sendMessage(
        {
          customType: "pi-swarm.inbox",
          content: message.body,
          display: "info",
          details: { kind: message.kind, title: message.title },
        },
        opts,
      );
    },
  };
}

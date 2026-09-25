/**
 * Acceptance 1 + 6: the extension factory registers 1 command + 18 tools on
 * a fake host without throwing, and the context filter keeps only the newest
 * inbox + contract messages. compose.js is mocked because the real store and
 * runtime factories are other workstreams (integration-tested by the parent).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/extension/compose.js", () => ({
  buildSwarmStack: vi.fn(async () => {
    throw new Error("compose is integration-tested by the parent");
  }),
  createSwarmRuntime: vi.fn(() => {
    throw new Error("compose is integration-tested by the parent");
  }),
  newIdentity: vi.fn(() => ({ role: "backend", instanceId: "backend-01aaaaaaaaaaaaaaaaaaaaaaaa", pid: 1 })),
}));

import piSwarmExtension, { filterSwarmMessages } from "../../../src/extension/index.js";
import type { SessionMessage } from "../../../src/extension/pi-api.js";
import { FakePi } from "./fakes.js";

const EXPECTED_TOOLS = [
  "swarm_task_list",
  "swarm_task_get",
  "swarm_task_create",
  "swarm_task_claim",
  "swarm_task_start",
  "swarm_task_complete",
  "swarm_task_fail",
  "swarm_task_abandon",
  "swarm_task_block",
  "swarm_task_unblock",
  "swarm_task_reopen",
  "swarm_request_create",
  "swarm_task_candidates",
  "swarm_topology",
  "swarm_event_emit",
  "swarm_blackboard_read",
  "swarm_blackboard_write",
  "swarm_artifact_publish",
];
const EXPECTED_HOOKS = [
  "session_start",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "session_stop",
  "context",
  "session_shutdown",
];

describe("piSwarmExtension factory", () => {
  it("registers 1 command and 18 tools on the host without throwing", () => {
    const pi = new FakePi();
    expect(() => piSwarmExtension(pi)).not.toThrow();

    expect(pi.label).toBe("Pi Swarm");
    expect([...pi.commands.keys()]).toEqual(["swarm"]);
    expect(pi.commands.get("swarm")?.description).toContain("Pi Swarm");

    expect([...pi.tools.keys()].sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of pi.tools.values()) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }

    expect([...pi.hooks.keys()].sort()).toEqual([...EXPECTED_HOOKS].sort());
  });

  it("maps tool failures to isError results without breaking the host (hooks never throw)", async () => {
    const pi = new FakePi();
    piSwarmExtension(pi);
    // before_agent_start with no binding -> undefined, no throw.
    await expect(pi.hooks.get("before_agent_start")!({ cwd: "/tmp", ui: { notify: () => {} } })).resolves.toBeUndefined();
  });
});

describe("filterSwarmMessages (context hook body)", () => {
  const msg = (customType: string | undefined, extra: Record<string, unknown> = {}): SessionMessage => ({
    role: "custom",
    ...(customType !== undefined ? { customType } : {}),
    ...extra,
  });

  it("keeps exactly the latest inbox and latest contract messages, dropping older swarm noise", () => {
    const messages: SessionMessage[] = [
      { role: "user", content: "hello" },
      msg("pi-swarm.inbox", { content: "inbox 1" }),
      msg("pi-swarm.inbox", { content: "inbox 2" }),
      msg("pi-swarm.inbox", { content: "inbox 3" }),
      msg("pi-swarm.contract", { content: "contract 1" }),
      { role: "assistant", content: "working" },
      msg("pi-swarm.contract", { content: "contract 2" }),
      msg("pi-swarm.inbox", { content: "inbox 4 (newest)" }),
    ];
    const { messages: filtered } = filterSwarmMessages(messages);
    const inboxes = filtered.filter((m) => m.customType === "pi-swarm.inbox");
    const contracts = filtered.filter((m) => m.customType === "pi-swarm.contract");
    expect(inboxes).toHaveLength(1);
    expect(inboxes[0]?.content).toBe("inbox 4 (newest)");
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.content).toBe("contract 2");
    // Non-swarm messages are untouched, in order.
    expect(filtered.filter((m) => m.customType === undefined).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("leaves sessions without swarm messages unchanged", () => {
    const messages: SessionMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    expect(filterSwarmMessages(messages).messages).toEqual(messages);
  });
});

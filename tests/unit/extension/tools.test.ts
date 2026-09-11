/**
 * Acceptance 5: tools return the unbound error without a session;
 * swarm_task_create runs the happy path against a fake task service and
 * returns the TASK- id plus tasks/ path; swarm_event_emit validates exactly
 * one of toRole/topic and rejects non-canonical types with a suggestion.
 */
import { describe, expect, it, vi } from "vitest";
import { registerSwarmTools } from "../../../src/extension/tools.js";
import type { ToolSession } from "../../../src/extension/tools.js";
import type {
  CreateTaskInput,
  CreateTaskResult,
  EmitEventInput,
  TaskListQuery,
  TaskView,
} from "../../../src/domain/types.js";
import type { AgentIdentity, TaskDocument } from "../../../src/protocol/schemas.js";
import { FakePi, makeFakeStack, makeIdentity, makeManifest } from "./fakes.js";

function sessionWith(stack = makeFakeStack()): ToolSession {
  return { identity: makeIdentity("backend"), manifest: makeManifest("backend"), stack };
}

function tool(pi: FakePi, name: string) {
  const def = pi.tools.get(name);
  if (!def) throw new Error(`tool ${name} not registered`);
  return def.execute.bind(def);
}

const createdTask: TaskDocument = {
  metadata: {
    id: "TASK-0007",
    status: "open",
    kind: "research",
    priority: 70,
    createdBy: { role: "backend", instanceId: "backend-01aaaaaaaaaaaaaaaaaaaaaaaa" },
    createdAt: "2026-09-11T15:00:00Z",
    updatedAt: "2026-09-11T15:00:00Z",
    dependsOn: [],
    inputs: [],
    outputs: [],
  },
  body: "# Research auth options\n\ndescription\n",
};

describe("registerSwarmTools guard", () => {
  it("returns the unbound error for every tool when no role is bound", async () => {
    const pi = new FakePi();
    registerSwarmTools(pi, () => null);
    for (const name of pi.tools.keys()) {
      const result = await tool(pi, name)("call-1", {}, undefined, undefined, undefined as never);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe("No swarm role bound. Run /swarm role <role> first.");
    }
  });
});

describe("swarm_task_create", () => {
  it("creates a task with body + acceptance criteria and reports id and path", async () => {
    const stack = makeFakeStack();
    const create = vi.fn(
      async (_input: CreateTaskInput, _by: AgentIdentity): Promise<CreateTaskResult> => ({
        ok: true,
        task: createdTask,
      }),
    );
    stack.services.task.create = create;
    const pi = new FakePi();
    registerSwarmTools(pi, () => sessionWith(stack));

    const result = await tool(pi, "swarm_task_create")(
      "call-1",
      {
        title: "Research auth options",
        description: "Compare OAuth providers for the API.",
        targetKind: "research",
        priority: 70,
        eligibleRoles: ["backend"],
        acceptanceCriteria: ["provider compared", "recommendation written"],
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Created TASK-0007");
    expect(result.content[0]?.text).toContain("tasks/TASK-0007.md");
    expect(result.details).toMatchObject({ taskId: "TASK-0007", path: "tasks/TASK-0007.md" });

    expect(create).toHaveBeenCalledTimes(1);
    const [input, by] = create.mock.calls[0]!;
    expect(input.title).toBe("Research auth options");
    expect(input.kind).toBe("research");
    expect(input.priority).toBe(70);
    expect(input.eligibleRoles).toEqual(["backend"]);
    expect(input.body).toContain("# Research auth options");
    expect(input.body).toContain("## Acceptance Criteria");
    expect(input.body).toContain("- provider compared");
    expect(by).toEqual(makeIdentity("backend"));
  });

  it("maps invalid_input service results to isError", async () => {
    const stack = makeFakeStack();
    stack.services.task.create = vi.fn(
      async (): Promise<CreateTaskResult> => ({
        ok: false,
        code: "invalid_input",
        message: "title is required",
      }),
    );
    const pi = new FakePi();
    registerSwarmTools(pi, () => sessionWith(stack));
    const result = await tool(pi, "swarm_task_create")(
      "call-1",
      { title: "", description: "x" },
      undefined,
      undefined,
      undefined as never,
    );
    // Either zod validation or the service message surfaces — both are isError.
    expect(result.isError).toBe(true);
    expect((result.content[0]?.text ?? "").length).toBeGreaterThan(0);
  });
});

describe("swarm_event_emit", () => {
  it("rejects both toRole and topic", async () => {
    const pi = new FakePi();
    registerSwarmTools(pi, () => sessionWith());
    const result = await tool(pi, "swarm_event_emit")(
      "c",
      { type: "task.claimed", toRole: "tester", topic: "tasks" },
      undefined,
      undefined,
      undefined as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("exactly one");
  });

  it("rejects neither toRole nor topic", async () => {
    const pi = new FakePi();
    registerSwarmTools(pi, () => sessionWith());
    const result = await tool(pi, "swarm_event_emit")(
      "c",
      { type: "task.claimed" },
      undefined,
      undefined,
      undefined as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("exactly one");
  });

  it("rejects a non-canonical type and suggests canonical types", async () => {
    const pi = new FakePi();
    registerSwarmTools(pi, () => sessionWith());
    const result = await tool(pi, "swarm_event_emit")(
      "c",
      { type: "taskclaimed", toRole: "tester" },
      undefined,
      undefined,
      undefined as never,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("task.opened");
    expect(result.content[0]?.text).toContain("task.claimed");
  });

  it("emits a direct event and reports the event id", async () => {
    const stack = makeFakeStack();
    const emit = vi.fn(stack.services.events.emit);
    stack.services.events.emit = emit;
    const pi = new FakePi();
    registerSwarmTools(pi, () => sessionWith(stack));
    const result = await tool(pi, "swarm_event_emit")(
      "c",
      { type: "review.requested", toRole: "tester", taskId: "TASK-0001" },
      undefined,
      undefined,
      undefined as never,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Emitted review.requested -> tester");
    expect(emit).toHaveBeenCalledTimes(1);
    const [input, from]: [EmitEventInput, AgentIdentity] = emit.mock.calls[0]!;
    expect(input.route).toEqual({ mode: "direct", role: "tester" });
    expect(input.context).toEqual({ taskId: "TASK-0001" });
    expect(from.role).toBe("backend");
  });
});

describe("swarm_task_list", () => {
  it("defaults to the agent view and honors {all:true} and status filters", async () => {
    const stack = makeFakeStack();
    const list = vi.fn(async (_query: TaskListQuery): Promise<TaskView[]> => []);
    stack.services.task.list = list;
    const pi = new FakePi();
    registerSwarmTools(pi, () => sessionWith(stack));

    await tool(pi, "swarm_task_list")("c", {}, undefined, undefined, undefined as never);
    expect(list.mock.calls[0]![0]).toHaveProperty("forAgent");

    await tool(pi, "swarm_task_list")("c", { all: true }, undefined, undefined, undefined as never);
    expect(list.mock.calls[1]![0]).toHaveProperty("statuses");
    expect(list.mock.calls[1]![0]).not.toHaveProperty("forAgent");

    await tool(pi, "swarm_task_list")(
      "c",
      { status: ["open", "done"] },
      undefined,
      undefined,
      undefined as never,
    );
    expect(list.mock.calls[2]![0].statuses).toEqual(["open", "done"]);
  });
});

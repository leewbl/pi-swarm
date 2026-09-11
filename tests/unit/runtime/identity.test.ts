import { describe, expect, it } from "vitest";
import { newIdentity, newInstanceId } from "../../../src/runtime/identity.js";
import { INSTANCE_ID_RE } from "../../../src/protocol/schemas.js";

describe("newInstanceId", () => {
  it("produces <role>-<lowercase ulid> matching the schema pattern", () => {
    const id = newInstanceId("backend");
    expect(id).toMatch(INSTANCE_ID_RE);
    expect(id.startsWith("backend-")).toBe(true);
    expect(id.slice("backend-".length)).toBe(id.slice("backend-".length).toLowerCase());
  });

  it("is unique across calls", () => {
    expect(newInstanceId("tester")).not.toBe(newInstanceId("tester"));
  });
});

describe("newIdentity", () => {
  it("builds a schema-valid identity with instanceId derived from the role", () => {
    const identity = newIdentity("researcher", 4212);
    expect(identity.role).toBe("researcher");
    expect(identity.pid).toBe(4212);
    expect(identity.instanceId).toMatch(new RegExp(`^researcher-[0-9a-z]{26}$`));
    expect(identity.sessionId).toBeUndefined();
  });

  it("keeps an explicit sessionId", () => {
    const identity = newIdentity("backend", 99, "omp-session-7");
    expect(identity.sessionId).toBe("omp-session-7");
  });

  it("rejects invalid input (non-positive pid)", () => {
    expect(() => newIdentity("backend", 0)).toThrow();
  });
});

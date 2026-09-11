/**
 * ClaimStore unit tests (single process; cross-process contention is covered
 * by tests/multiprocess/concurrent-claim.test.ts).
 */
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { createClaimStore } from "../../../src/storage/atomic-claim.js";
import { makeClaim, newWorkspace, taskId } from "./fixtures.js";

describe("ClaimStore", () => {
  it("claims exclusively: first wins, second is already_claimed, winner persists", async () => {
    const { paths } = await newWorkspace();
    const store = createClaimStore(paths);
    const first = makeClaim(1, taskId(1));
    const second = makeClaim(2, taskId(1));

    await expect(store.tryClaim(first)).resolves.toEqual({ status: "claimed" });
    await expect(store.tryClaim(second)).resolves.toEqual({ status: "already_claimed" });

    expect(await store.get(taskId(1))).toEqual(first);
  });

  it("lists claims across tasks", async () => {
    const { paths } = await newWorkspace();
    const store = createClaimStore(paths);
    const c1 = makeClaim(1, taskId(1), "backend");
    const c2 = makeClaim(2, taskId(2), "frontend");
    await store.tryClaim(c1);
    await store.tryClaim(c2);
    expect(await store.list()).toEqual([c1, c2]);
  });

  it("removes only when the claimId matches", async () => {
    const { paths } = await newWorkspace();
    const store = createClaimStore(paths);
    const claim = makeClaim(1, taskId(1));
    await store.tryClaim(claim);

    await expect(store.remove(taskId(1), "CLM-0000000000000000000000000Z")).resolves.toBe(false);
    expect(await store.get(taskId(1))).toEqual(claim);

    await expect(store.remove(taskId(1), claim.claimId)).resolves.toBe(true);
    expect(await store.get(taskId(1))).toBeNull();
    // Second remove of the now-missing claim reports false.
    await expect(store.remove(taskId(1), claim.claimId)).resolves.toBe(false);
  });

  it("returns null for missing or malformed ids on get", async () => {
    const { paths } = await newWorkspace();
    const store = createClaimStore(paths);
    expect(await store.get(taskId(404))).toBeNull();
    expect(await store.get("../escape")).toBeNull();
  });

  it("skips corrupt claim files in get/list and refuses to remove them", async () => {
    const { paths } = await newWorkspace();
    const store = createClaimStore(paths);
    await store.tryClaim(makeClaim(1, taskId(1)));
    await fsp.writeFile(paths.claimFile(taskId(1)), "version: 1\ntaskId: broken\n", "utf8");

    // Corrupt content still occupies the claim slot (file exists)…
    const challenger = makeClaim(2, taskId(1));
    await expect(store.tryClaim(challenger)).resolves.toEqual({ status: "already_claimed" });
    // …but is not surfaced as data.
    expect(await store.get(taskId(1))).toBeNull();
    expect(await store.list()).toEqual([]);
    await expect(store.remove(taskId(1), challenger.claimId)).resolves.toBe(false);
  });

  it("rejects schema-invalid claim records on tryClaim", async () => {
    const { paths } = await newWorkspace();
    const store = createClaimStore(paths);
    const bad = { ...makeClaim(1, taskId(1)), pid: -1 };
    await expect(store.tryClaim(bad)).rejects.toThrow(/pid/);
  });
});

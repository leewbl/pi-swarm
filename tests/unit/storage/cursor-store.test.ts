/**
 * CursorStore unit tests (acceptance #4).
 */
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCursorStore } from "../../../src/storage/cursor-store.js";
import { instanceId, newWorkspace } from "./fixtures.js";

const CONSUMER = instanceId("backend", "b");
const OTHER_CONSUMER = instanceId("frontend", "f");

describe("CursorStore", () => {
  it("loads an empty state when no cursor file exists", async () => {
    const { paths } = await newWorkspace();
    const store = createCursorStore(paths);
    expect(await store.load(CONSUMER)).toEqual({ streams: {} });
  });

  it("round-trips per-consumer replay state", async () => {
    const { paths } = await newWorkspace();
    const store = createCursorStore(paths);
    const state = {
      streams: {
        [instanceId("coordinator", "c")]: { offset: 1234, lastEventId: "0000000000000000000000000A" },
        [instanceId("architect", "a")]: { offset: 0, lastEventId: null },
      },
    };
    await store.save(CONSUMER, state);
    expect(await store.load(CONSUMER)).toEqual(state);

    // Separate consumers have separate files.
    await store.save(OTHER_CONSUMER, { streams: {} });
    expect(await store.load(OTHER_CONSUMER)).toEqual({ streams: {} });
    expect(await store.load(CONSUMER)).toEqual(state);
  });

  it("atomically replaces (never merges) previous state", async () => {
    const { paths } = await newWorkspace();
    const store = createCursorStore(paths);
    await store.save(CONSUMER, {
      streams: { old: { offset: 99, lastEventId: null } },
    });
    const fresh = { streams: { [instanceId("backend", "d")]: { offset: 7, lastEventId: null } } };
    await store.save(CONSUMER, fresh);
    expect(await store.load(CONSUMER)).toEqual(fresh);

    // Persisted file is plain JSON.
    const raw = await fsp.readFile(paths.cursorFile(CONSUMER), "utf8");
    expect(JSON.parse(raw)).toEqual(fresh);
  });

  it("throws on a corrupt cursor file instead of silently replaying", async () => {
    const { paths } = await newWorkspace();
    await fsp.writeFile(paths.cursorFile(CONSUMER), "{not json", "utf8");
    await expect(createCursorStore(paths).load(CONSUMER)).rejects.toThrow(/cursor/);

    await fsp.writeFile(paths.cursorFile(OTHER_CONSUMER), '{"streams": {"s": {"offset": -5, "lastEventId": null}}}', "utf8");
    await expect(createCursorStore(paths).load(OTHER_CONSUMER)).rejects.toThrow(/offset/);
  });
});

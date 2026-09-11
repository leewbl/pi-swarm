/**
 * BlackboardStore unit tests (acceptance #6): traversal confinement,
 * read/write glob enforcement, hotspot role enforcement, listing.
 */
import { describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import { createBlackboardStore } from "../../../src/storage/blackboard-store.js";
import { BlackboardDeniedError } from "../../../src/storage/types.js";
import { newWorkspace } from "./fixtures.js";

const ALL = ["**"];
const FINDINGS_READ = ["findings/**"];
const FINDINGS_WRITE = ["findings/backend/**"];

describe("BlackboardStore permissions", () => {
  it("reads and writes content within granted globs", async () => {
    const { paths } = await newWorkspace();
    const store = createBlackboardStore(paths);

    await store.write("findings/backend/oauth.md", "# oauth\n", "backend", FINDINGS_WRITE, {});
    await expect(store.read("findings/backend/oauth.md", "backend", FINDINGS_READ)).resolves.toBe("# oauth\n");
    expect(await fsp.readFile(`${paths.blackboardDir}/findings/backend/oauth.md`, "utf8")).toBe("# oauth\n");
  });

  it("denies reads outside the viewer's read globs", async () => {
    const { paths } = await newWorkspace();
    const store = createBlackboardStore(paths);
    await store.write("secrets/keys.md", "shh", "coordinator", ALL, {});

    const denial = store.read("secrets/keys.md", "backend", FINDINGS_READ);
    await expect(denial).rejects.toBeInstanceOf(BlackboardDeniedError);
    await expect(denial).rejects.toMatchObject({ reason: "read" });
  });

  it("denies writes outside the writer's write globs", async () => {
    const { paths } = await newWorkspace();
    const store = createBlackboardStore(paths);

    const denial = store.write("notes/shared.md", "x", "backend", FINDINGS_WRITE, {});
    await expect(denial).rejects.toBeInstanceOf(BlackboardDeniedError);
    await expect(denial).rejects.toMatchObject({ reason: "write" });
    // Nothing was created.
    expect(await store.list()).toEqual([]);
  });

  it("enforces hotspot writer roles on exact paths", async () => {
    const { paths } = await newWorkspace();
    const store = createBlackboardStore(paths);
    const hotspots = { "project.md": ["coordinator"] };

    // Allowed role passes glob + hotspot checks.
    await store.write("project.md", "v1", "coordinator", ALL, hotspots);
    await expect(store.read("project.md", "coordinator", ALL)).resolves.toBe("v1");

    // Other role has the glob but not the hotspot right.
    const denial = store.write("project.md", "v2", "backend", ALL, hotspots);
    await expect(denial).rejects.toBeInstanceOf(BlackboardDeniedError);
    await expect(denial).rejects.toMatchObject({ reason: "write" });
    await expect(denial).rejects.toThrow(/hotspot.*project\.md/);

    // Non-hotspot paths under the same globs stay open to the glob holder.
    await store.write("free/notes.md", "ok", "backend", ALL, hotspots);

    // Hotspot key must match the exact relative path — a nested path is not
    // the hotspot.
    await store.write("nested/project.md", "ok", "backend", ALL, hotspots);
    await expect(store.read("nested/project.md", "backend", ALL)).resolves.toBe("ok");
  });

  it("blocks traversal attempts before any filesystem access", async () => {
    const { paths } = await newWorkspace();
    const store = createBlackboardStore(paths);
    await store.write("board.md", "v", "backend", ALL, {});

    for (const escape of ["../tasks/TASK-0001.md", "a/../../swarm.yaml", "/etc/passwd", ".."]) {
      const readDenial = store.read(escape, "backend", ALL);
      await expect(readDenial).rejects.toBeInstanceOf(BlackboardDeniedError);
      await expect(readDenial).rejects.toMatchObject({ reason: "traversal" });

      const writeDenial = store.write(escape, "x", "backend", ALL, {});
      await expect(writeDenial).rejects.toMatchObject({ reason: "traversal" });
    }

    // Traversal denial fires even when globs do not cover the path.
    const deniedFirst = store.read("../swarm.yaml", "backend", []);
    await expect(deniedFirst).rejects.toMatchObject({ reason: "traversal" });

    // The workspace outside the blackboard dir is untouched.
    expect(await fsp.readdir(paths.tasksDir)).toEqual([]);
  });
});

describe("BlackboardStore listing", () => {
  it("walks the board and returns swarm-relative posix paths", async () => {
    const { paths } = await newWorkspace();
    const store = createBlackboardStore(paths);
    await store.write("b.md", "1", "backend", ALL, {});
    await store.write("findings/a.md", "2", "backend", ALL, {});
    await store.write("findings/deep/c.md", "3", "backend", ALL, {});

    expect(await store.list()).toEqual([
      "blackboard/b.md",
      "blackboard/findings/a.md",
      "blackboard/findings/deep/c.md",
    ]);
    expect(await store.list("findings")).toEqual(["blackboard/findings/a.md", "blackboard/findings/deep/c.md"]);
    expect(await store.list("findings/deep")).toEqual(["blackboard/findings/deep/c.md"]);
  });

  it("returns an empty listing for missing subtrees", async () => {
    const { paths } = await newWorkspace();
    const store = createBlackboardStore(paths);
    expect(await store.list()).toEqual([]);
    expect(await store.list("nowhere")).toEqual([]);
  });

  it("rejects traversal in list()", async () => {
    const { paths } = await newWorkspace();
    const store = createBlackboardStore(paths);
    await expect(store.list("..")).rejects.toMatchObject({ reason: "traversal" });
  });
});

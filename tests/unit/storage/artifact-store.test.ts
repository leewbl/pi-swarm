/**
 * ArtifactStore unit tests (acceptance #8): digest correctness, binary
 * safety, name validation, traversal-safe ref resolution.
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactStore } from "../../../src/storage/artifact-store.js";
import { ArtifactNameError } from "../../../src/storage/types.js";
import { PathEscapeError } from "../../../src/util/paths.js";
import { newWorkspace, taskId } from "./fixtures.js";

describe("ArtifactStore.publish", () => {
  it("writes the artifact and returns a verified digest ref", async () => {
    const { paths } = await newWorkspace();
    const store = createArtifactStore(paths);
    const content = "# report\nsingle æøå line\n"; // non-ASCII to prove byte sizing

    const ref = await store.publish(taskId(1), "report.md", content, "text/markdown");

    expect(ref).toEqual({
      path: `artifacts/${taskId(1)}/report.md`,
      size: Buffer.byteLength(content, "utf8"),
      digest: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
      mediaType: "text/markdown",
    });

    const onDisk = await fsp.readFile(path.join(paths.artifactsDir, taskId(1), "report.md"), "utf8");
    expect(onDisk).toBe(content);
  });

  it("omits mediaType when not supplied", async () => {
    const { paths } = await newWorkspace();
    const ref = await createArtifactStore(paths).publish(taskId(1), "data.json", "{}");
    expect(ref).not.toHaveProperty("mediaType");
    expect(ref).toHaveProperty("digest");
  });

  it("preserves binary payloads byte-for-byte", async () => {
    const { paths } = await newWorkspace();
    const store = createArtifactStore(paths);
    const bytes = Uint8Array.from(Array.from({ length: 256 }, (_, i) => i));

    const ref = await store.publish(taskId(2), "blob.bin", bytes);

    expect(ref.size).toBe(256);
    expect(ref.digest).toBe(`sha256:${createHash("sha256").update(Buffer.from(bytes)).digest("hex")}`);
    const onDisk = await fsp.readFile(path.join(paths.artifactsDir, taskId(2), "blob.bin"));
    expect(onDisk.equals(Buffer.from(bytes))).toBe(true);
  });

  it("republishing to the same name replaces atomically", async () => {
    const { paths } = await newWorkspace();
    const store = createArtifactStore(paths);
    await store.publish(taskId(1), "out.txt", "v1");
    const ref = await store.publish(taskId(1), "out.txt", "v2-longer");
    expect(ref.size).toBe(9);
    expect(await fsp.readFile(path.join(paths.artifactsDir, taskId(1), "out.txt"), "utf8")).toBe("v2-longer");
    // No temp leftovers.
    expect(await fsp.readdir(path.join(paths.artifactsDir, taskId(1)))).toEqual(["out.txt"]);
  });

  it("rejects unsafe file names without touching disk", async () => {
    const { paths } = await newWorkspace();
    const store = createArtifactStore(paths);
    for (const name of ["../evil.md", "/etc/passwd", ".hidden", "a/b.md", "a b.md", ""]) {
      const denial = store.publish(taskId(1), name, "x");
      await expect(denial).rejects.toBeInstanceOf(ArtifactNameError);
    }
    expect(await fsp.readdir(paths.artifactsDir)).toEqual([]);
  });

  it("rejects malformed task ids", async () => {
    const { paths } = await newWorkspace();
    const store = createArtifactStore(paths);
    await expect(store.publish("../evil", "x.md", "x")).rejects.toThrow();
    await expect(store.publish("TASK-1", "x.md", "x")).rejects.toThrow();
  });
});

describe("ArtifactStore.resolvePath", () => {
  it("resolves published refs to their absolute path", async () => {
    const { root, paths } = await newWorkspace();
    const store = createArtifactStore(paths);
    const ref = await store.publish(taskId(1), "report.md", "body");

    const abs = await store.resolvePath(ref);
    expect(abs).toBe(path.join(root, ".pi", "swarm", "artifacts", taskId(1), "report.md"));
    expect(await fsp.readFile(abs, "utf8")).toBe("body");
  });

  it("rejects refs that escape the artifacts dir", async () => {
    const { paths } = await newWorkspace();
    const store = createArtifactStore(paths);

    await expect(store.resolvePath({ path: `tasks/${taskId(1)}.md` })).rejects.toBeInstanceOf(PathEscapeError);
    await expect(store.resolvePath({ path: "../swarm.yaml" })).rejects.toBeInstanceOf(PathEscapeError);
    // Normalized traversal that lands outside artifacts/:
    await expect(store.resolvePath({ path: "artifacts/../../swarm.yaml" })).rejects.toBeInstanceOf(
      PathEscapeError,
    );
    // The artifacts dir itself is not a resolvable file:
    await expect(store.resolvePath({ path: "artifacts" })).rejects.toBeInstanceOf(PathEscapeError);
  });
});

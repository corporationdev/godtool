import { mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createExecutor } from "@executor/sdk/promise";

import {
  resolveWorkspaceFileRef,
  workspacePlugin,
  type WorkspacePluginConfig,
} from "./index";

const makeExecutor = async (config: WorkspacePluginConfig) =>
  createExecutor({ plugins: [workspacePlugin(config)] as const });

const makeWorkspace = () => mkdtemp(join(tmpdir(), "godtool-workspace-plugin-"));

describe("workspacePlugin", () => {
  it("exposes the built-in workspace source and tools", async () => {
    const root = await makeWorkspace();
    const executor = await makeExecutor({ root });

    const sources = await executor.sources.list();
    expect(sources.find((source) => source.id === "workspace")).toMatchObject({
      id: "workspace",
      kind: "workspace",
      name: "Workspace",
      runtime: true,
      canRemove: false,
    });

    const toolIds = (await executor.tools.list())
      .filter((tool) => tool.id.startsWith("workspace."))
      .map((tool) => tool.id)
      .sort();

    expect(toolIds).toEqual([
      "workspace.appendFile",
      "workspace.applyPatch",
      "workspace.copyFile",
      "workspace.exists",
      "workspace.getFileRef",
      "workspace.listTree",
      "workspace.mkdir",
      "workspace.readFile",
      "workspace.readMany",
      "workspace.readdir",
      "workspace.rename",
      "workspace.resolveFileRef",
      "workspace.rm",
      "workspace.search",
      "workspace.stat",
      "workspace.writeFile",
    ]);

    await executor.close();
  });

  it("reads and writes utf8 and base64 files", async () => {
    const root = await makeWorkspace();
    const executor = await makeExecutor({ root });

    await executor.tools.invoke("workspace.writeFile", {
      path: "notes/hello.txt",
      data: "hello",
    });
    const text = await executor.tools.invoke("workspace.readFile", {
      path: "notes/hello.txt",
    });
    expect(text).toMatchObject({
      path: "notes/hello.txt",
      filename: "hello.txt",
      mimeType: "text/plain",
      encoding: "utf8",
      data: "hello",
      size: 5,
    });

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await executor.tools.invoke("workspace.writeFile", {
      path: "images/tiny.png",
      encoding: "base64",
      data: pngBytes.toString("base64"),
    });
    const image = await executor.tools.invoke("workspace.readFile", {
      path: "images/tiny.png",
      encoding: "base64",
    });
    expect(image).toMatchObject({
      path: "images/tiny.png",
      filename: "tiny.png",
      mimeType: "image/png",
      encoding: "base64",
      data: pngBytes.toString("base64"),
      size: 4,
    });

    await executor.close();
  });

  it("reads many files in one call", async () => {
    const root = await makeWorkspace();
    const executor = await makeExecutor({ root });
    await writeFile(join(root, "one.txt"), "one", "utf8");
    await writeFile(join(root, "two.txt"), "two", "utf8");

    const files = await executor.tools.invoke("workspace.readMany", {
      paths: ["one.txt", "two.txt"],
    });

    expect(files).toMatchObject([
      { path: "one.txt", data: "one", encoding: "utf8" },
      { path: "two.txt", data: "two", encoding: "utf8" },
    ]);

    await executor.close();
  });

  it("lists a bounded recursive tree", async () => {
    const root = await makeWorkspace();
    const executor = await makeExecutor({ root });
    await executor.tools.invoke("workspace.writeFile", {
      path: "src/nested/hello.ts",
      data: "export const hello = 'world';\n",
    });

    const tree = await executor.tools.invoke("workspace.listTree", {
      path: "src",
      maxDepth: 2,
    });

    expect(tree).toMatchObject({
      root: "src",
      maxDepth: 2,
      entries: [
        { path: "src", type: "directory" },
        { path: "src/nested", type: "directory" },
        { path: "src/nested/hello.ts", type: "file" },
      ],
    });

    await executor.close();
  });

  it("searches workspace text files", async () => {
    const root = await makeWorkspace();
    const executor = await makeExecutor({ root });
    await executor.tools.invoke("workspace.writeFile", {
      path: "src/a.ts",
      data: "const target = 1;\n",
    });
    await executor.tools.invoke("workspace.writeFile", {
      path: "src/b.ts",
      data: "const other = 2;\n",
    });

    const result = await executor.tools.invoke("workspace.search", {
      query: "target",
      path: "src",
    });

    expect(result).toEqual({
      query: "target",
      matches: [{ path: "src/a.ts", line: 1, column: 7, text: "const target = 1;" }],
    });

    await executor.close();
  });

  it("applies add, update, delete, and move patch operations", async () => {
    const root = await makeWorkspace();
    const executor = await makeExecutor({ root });
    await writeFile(join(root, "keep.txt"), "hello\nold\nbye\n", "utf8");
    await writeFile(join(root, "remove.txt"), "delete me\n", "utf8");
    await writeFile(join(root, "move.txt"), "move me\n", "utf8");

    const summary = await executor.tools.invoke("workspace.applyPatch", {
      patch: [
        "*** Begin Patch",
        "*** Add File: added.txt",
        "+new file",
        "*** Update File: keep.txt",
        "@@",
        " hello",
        "-old",
        "+new",
        " bye",
        "*** Delete File: remove.txt",
        "*** Update File: move.txt",
        "*** Move to: moved.txt",
        "@@",
        "-move me",
        "+moved me",
        "*** End Patch",
      ].join("\n"),
    });

    expect(summary).toEqual({
      changedFiles: ["keep.txt", "moved.txt"],
      addedFiles: ["added.txt"],
      deletedFiles: ["remove.txt"],
      movedFiles: [{ from: "move.txt", to: "moved.txt" }],
      dryRun: false,
    });
    await expect(readFile(join(root, "added.txt"), "utf8")).resolves.toBe("new file\n");
    await expect(readFile(join(root, "keep.txt"), "utf8")).resolves.toBe("hello\nnew\nbye\n");
    await expect(readFile(join(root, "moved.txt"), "utf8")).resolves.toBe("moved me\n");
    await expect(readFile(join(root, "remove.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await executor.close();
  });

  it("does not partially apply patch operations when validation fails", async () => {
    const root = await makeWorkspace();
    const executor = await makeExecutor({ root });
    await writeFile(join(root, "keep.txt"), "hello\nold\nbye\n", "utf8");

    await expect(
      executor.tools.invoke("workspace.applyPatch", {
        patch: [
          "*** Begin Patch",
          "*** Add File: added.txt",
          "+new file",
          "*** Update File: keep.txt",
          "@@",
          "-missing line",
          "+new",
          "*** End Patch",
        ].join("\n"),
      }),
    ).rejects.toThrow("Patch hunk did not match file contents");

    await expect(readFile(join(root, "added.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(root, "keep.txt"), "utf8")).resolves.toBe("hello\nold\nbye\n");

    await executor.close();
  });

  it("rejects duplicate patch move targets before changing files", async () => {
    const root = await makeWorkspace();
    const executor = await makeExecutor({ root });
    await writeFile(join(root, "one.txt"), "one\n", "utf8");
    await writeFile(join(root, "two.txt"), "two\n", "utf8");

    await expect(
      executor.tools.invoke("workspace.applyPatch", {
        patch: [
          "*** Begin Patch",
          "*** Update File: one.txt",
          "*** Move to: moved.txt",
          "@@",
          "-one",
          "+moved one",
          "*** Update File: two.txt",
          "*** Move to: moved.txt",
          "@@",
          "-two",
          "+moved two",
          "*** End Patch",
        ].join("\n"),
      }),
    ).rejects.toThrow("Move target is used more than once");

    await expect(readFile(join(root, "one.txt"), "utf8")).resolves.toBe("one\n");
    await expect(readFile(join(root, "two.txt"), "utf8")).resolves.toBe("two\n");
    await expect(readFile(join(root, "moved.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await executor.close();
  });

  it("rejects absolute paths, parent escapes, NUL bytes, and symlink traversal", async () => {
    const root = await makeWorkspace();
    const outside = await makeWorkspace();
    await writeFile(join(outside, "secret.txt"), "nope", "utf8");
    await symlink(outside, join(root, "outside-link"));
    const executor = await makeExecutor({ root });

    await expect(
      executor.tools.invoke("workspace.readFile", { path: "/etc/passwd" }),
    ).rejects.toThrow("Workspace paths must be relative");
    await expect(
      executor.tools.invoke("workspace.readFile", { path: "../secret.txt" }),
    ).rejects.toThrow("Workspace path escapes the workspace root");
    await expect(
      executor.tools.invoke("workspace.readFile", { path: "bad\u0000path" }),
    ).rejects.toThrow("Invalid workspace path");
    await expect(
      executor.tools.invoke("workspace.readFile", { path: "outside-link/secret.txt" }),
    ).rejects.toThrow("Workspace paths cannot traverse symbolic links");
    await symlink(join(outside, "secret.txt"), join(root, "secret-link.txt"));
    await expect(
      executor.tools.invoke("workspace.writeFile", {
        path: "secret-link.txt",
        data: "still nope",
      }),
    ).rejects.toThrow("Workspace paths cannot traverse symbolic links");
    await expect(
      executor.tools.invoke("workspace.applyPatch", {
        patch: [
          "*** Begin Patch",
          "*** Add File: ../outside.txt",
          "+nope",
          "*** End Patch",
        ].join("\n"),
      }),
    ).rejects.toThrow("Workspace path escapes the workspace root");

    await executor.close();
  });

  it("returns and validates stable file refs without exposing absolute paths through tools", async () => {
    const root = await makeWorkspace();
    const executor = await makeExecutor({ root });
    await writeFile(join(root, "invoice.pdf"), "pdf", "utf8");

    const fileRef = await executor.tools.invoke("workspace.getFileRef", {
      path: "invoice.pdf",
    });
    expect(fileRef).toMatchObject({
      ref: "godtool-workspace://invoice.pdf",
      path: "invoice.pdf",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      size: 3,
    });
    expect(fileRef).not.toHaveProperty("absolutePath");

    const resolved = await executor.tools.invoke("workspace.resolveFileRef", {
      ref: "godtool-workspace://invoice.pdf",
    });
    expect(resolved).toMatchObject(fileRef as Record<string, unknown>);
    expect(resolved).not.toHaveProperty("absolutePath");

    const hostResolved = await resolveWorkspaceFileRef("godtool-workspace://invoice.pdf", {
      root,
    });
    expect(hostResolved.absolutePath).toBe(await realpath(join(root, "invoice.pdf")));

    await expect(
      resolveWorkspaceFileRef("godtool-workspace://..%2Foutside.txt", { root }),
    ).rejects.toThrow("Workspace path escapes the workspace root");

    await executor.close();
  });
});

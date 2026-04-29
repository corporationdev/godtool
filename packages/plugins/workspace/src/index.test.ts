import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
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
      "workspace.copyFile",
      "workspace.exists",
      "workspace.getFileRef",
      "workspace.mkdir",
      "workspace.readFile",
      "workspace.readdir",
      "workspace.rename",
      "workspace.resolveFileRef",
      "workspace.rm",
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

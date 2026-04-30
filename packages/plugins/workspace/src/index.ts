import { Effect, Schema } from "effect";
import { constants as fsConstants } from "node:fs";
import {
  access,
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { definePlugin, type StaticToolDecl } from "@executor/sdk";

const SOURCE_ID = "workspace";
const SOURCE_KIND = "workspace";
const FILE_REF_PREFIX = "godtool-workspace://";

export interface WorkspacePluginConfig {
  readonly root?: string;
}

export interface WorkspaceFileMetadata {
  readonly path: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}

export interface WorkspaceFileRef extends WorkspaceFileMetadata {
  readonly ref: string;
}

export interface ResolvedWorkspaceFileRef extends WorkspaceFileRef {
  readonly absolutePath: string;
}

const Encoding = Schema.optional(Schema.Literal("utf8", "base64"));

const PathArgs = Schema.Struct({
  path: Schema.String,
});

const ReadFileArgs = Schema.Struct({
  path: Schema.String,
  encoding: Encoding,
});

const WriteFileArgs = Schema.Struct({
  path: Schema.String,
  data: Schema.String,
  encoding: Encoding,
  flag: Schema.optional(Schema.Literal("w", "wx")),
});

const AppendFileArgs = Schema.Struct({
  path: Schema.String,
  data: Schema.String,
  encoding: Encoding,
});

const ReaddirArgs = Schema.Struct({
  path: Schema.optional(Schema.String),
  withFileTypes: Schema.optional(Schema.Boolean),
});

const MkdirArgs = Schema.Struct({
  path: Schema.String,
  recursive: Schema.optional(Schema.Boolean),
});

const RmArgs = Schema.Struct({
  path: Schema.String,
  recursive: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
});

const RenameArgs = Schema.Struct({
  oldPath: Schema.String,
  newPath: Schema.String,
});

const CopyFileArgs = Schema.Struct({
  src: Schema.String,
  dest: Schema.String,
});

const ResolveFileRefArgs = Schema.Struct({
  ref: Schema.String,
});

const decodePathArgs = Schema.decodeUnknownSync(PathArgs);
const decodeReadFileArgs = Schema.decodeUnknownSync(ReadFileArgs);
const decodeWriteFileArgs = Schema.decodeUnknownSync(WriteFileArgs);
const decodeAppendFileArgs = Schema.decodeUnknownSync(AppendFileArgs);
const decodeReaddirArgs = Schema.decodeUnknownSync(ReaddirArgs);
const decodeMkdirArgs = Schema.decodeUnknownSync(MkdirArgs);
const decodeRmArgs = Schema.decodeUnknownSync(RmArgs);
const decodeRenameArgs = Schema.decodeUnknownSync(RenameArgs);
const decodeCopyFileArgs = Schema.decodeUnknownSync(CopyFileArgs);
const decodeResolveFileRefArgs = Schema.decodeUnknownSync(ResolveFileRefArgs);

const pathSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string" },
  },
} as const;

const encodingProperty = {
  type: "string",
  enum: ["utf8", "base64"],
  description: "Text encoding for file contents. Defaults to utf8.",
} as const;

const readFileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string" },
    encoding: encodingProperty,
  },
} as const;

const writeFileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "data"],
  properties: {
    path: { type: "string" },
    data: { type: "string" },
    encoding: encodingProperty,
    flag: {
      type: "string",
      enum: ["w", "wx"],
      description: "Use wx to fail if the target already exists.",
    },
  },
} as const;

const appendFileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "data"],
  properties: {
    path: { type: "string" },
    data: { type: "string" },
    encoding: encodingProperty,
  },
} as const;

const readdirSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    withFileTypes: { type: "boolean" },
  },
} as const;

const mkdirSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string" },
    recursive: { type: "boolean" },
  },
} as const;

const rmSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string" },
    recursive: { type: "boolean" },
    force: { type: "boolean" },
  },
} as const;

const renameSchema = {
  type: "object",
  additionalProperties: false,
  required: ["oldPath", "newPath"],
  properties: {
    oldPath: { type: "string" },
    newPath: { type: "string" },
  },
} as const;

const copyFileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["src", "dest"],
  properties: {
    src: { type: "string" },
    dest: { type: "string" },
  },
} as const;

const resolveFileRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ref"],
  properties: {
    ref: { type: "string" },
  },
} as const;

const mimeByExtension: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".ts": "text/typescript",
  ".webp": "image/webp",
  ".xml": "application/xml",
};

const mimeTypeForPath = (path: string): string =>
  mimeByExtension[extname(path).toLowerCase()] ?? "application/octet-stream";

const defaultWorkspaceRoot = (): string => {
  const dataDir = process.env.GODTOOL_DATA_DIR?.trim() || join(homedir(), ".godtool");
  return join(dataDir, "workspace");
};

export const resolveWorkspaceRoot = (config?: WorkspacePluginConfig): string =>
  resolve(config?.root ?? process.env.GODTOOL_WORKSPACE_DIR ?? defaultWorkspaceRoot());

const assertInsideRoot = (root: string, candidate: string): void => {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Workspace path escapes the workspace root");
  }
};

const normalizeRelativePath = (input: string | undefined): string => {
  const raw = input ?? ".";
  if (raw.includes("\0")) throw new Error("Invalid workspace path");

  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || isAbsolute(normalized)) {
    throw new Error("Workspace paths must be relative");
  }

  const collapsed = relative(".", normalized).split(sep).join("/");
  return collapsed.length === 0 ? "." : collapsed;
};

const ensureWorkspaceRoot = async (config?: WorkspacePluginConfig): Promise<string> => {
  const root = resolveWorkspaceRoot(config);
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  assertInsideRoot(realRoot, realRoot);
  return realRoot;
};

const splitRelativePath = (path: string): readonly string[] =>
  path === "." ? [] : path.split("/").filter((part) => part.length > 0);

const validateExistingSegments = async (
  root: string,
  relativePath: string,
  includeTarget: boolean,
): Promise<void> => {
  const parts = splitRelativePath(relativePath);
  const limit = includeTarget ? parts.length : Math.max(0, parts.length - 1);
  let current = root;

  for (let index = 0; index < limit; index += 1) {
    const part = parts[index];
    if (!part) continue;
    current = join(current, part);
    let entry;
    try {
      entry = await lstat(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    if (entry.isSymbolicLink()) {
      throw new Error("Workspace paths cannot traverse symbolic links");
    }
  }
};

const resolveExistingPath = async (
  config: WorkspacePluginConfig | undefined,
  inputPath: string | undefined,
): Promise<{ readonly root: string; readonly path: string; readonly relativePath: string }> => {
  const root = await ensureWorkspaceRoot(config);
  const relativePath = normalizeRelativePath(inputPath);
  const target = resolve(root, relativePath);
  assertInsideRoot(root, target);
  await validateExistingSegments(root, relativePath, true);
  const realTarget = await realpath(target);
  assertInsideRoot(root, realTarget);
  return { root, path: target, relativePath: toWorkspaceRelativePath(root, target) };
};

const resolveWritablePath = async (
  config: WorkspacePluginConfig | undefined,
  inputPath: string,
): Promise<{ readonly root: string; readonly path: string; readonly relativePath: string }> => {
  const root = await ensureWorkspaceRoot(config);
  const relativePath = normalizeRelativePath(inputPath);
  const target = resolve(root, relativePath);
  assertInsideRoot(root, target);
  await validateExistingSegments(root, relativePath, false);
  await mkdir(dirname(target), { recursive: true });
  await validateExistingSegments(root, relative(root, dirname(target)).split(sep).join("/"), true);
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink()) {
      throw new Error("Workspace paths cannot traverse symbolic links");
    }
    const realTarget = await realpath(target);
    assertInsideRoot(root, realTarget);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  return { root, path: target, relativePath: toWorkspaceRelativePath(root, target) };
};

const toWorkspaceRelativePath = (root: string, absolutePath: string): string => {
  const rel = relative(root, absolutePath).split(sep).join("/");
  return rel.length === 0 ? "." : rel;
};

const metadataForPath = async (
  root: string,
  absolutePath: string,
): Promise<WorkspaceFileMetadata> => {
  const current = await stat(absolutePath);
  return {
    path: toWorkspaceRelativePath(root, absolutePath),
    filename: basename(absolutePath),
    mimeType: mimeTypeForPath(absolutePath),
    size: current.size,
  };
};

const makeFileRef = async (root: string, absolutePath: string): Promise<WorkspaceFileRef> => {
  const metadata = await metadataForPath(root, absolutePath);
  return {
    ...metadata,
    ref: `${FILE_REF_PREFIX}${encodeURIComponent(metadata.path)}`,
  };
};

const pathFromFileRef = (ref: string): string => {
  if (!ref.startsWith(FILE_REF_PREFIX)) {
    throw new Error("Invalid workspace fileRef");
  }
  const encoded = ref.slice(FILE_REF_PREFIX.length);
  if (encoded.length === 0) throw new Error("Invalid workspace fileRef");
  return decodeURIComponent(encoded);
};

export const resolveWorkspaceFileRef = async (
  ref: string,
  config?: WorkspacePluginConfig,
): Promise<ResolvedWorkspaceFileRef> => {
  const filePath = pathFromFileRef(ref);
  const resolved = await resolveExistingPath(config, filePath);
  const entry = await lstat(resolved.path);
  if (!entry.isFile()) throw new Error("Workspace fileRef does not point to a file");
  const metadata = await makeFileRef(resolved.root, resolved.path);
  return { ...metadata, absolutePath: resolved.path };
};

const dataToBuffer = (data: string, encoding: "utf8" | "base64"): Buffer =>
  Buffer.from(data, encoding === "base64" ? "base64" : "utf8");

const readFileTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodeReadFileArgs(args);
    const encoding = input.encoding ?? "utf8";
    const resolved = await resolveExistingPath(config, input.path);
    const entry = await lstat(resolved.path);
    if (!entry.isFile()) throw new Error("Workspace path is not a file");
    const bytes = await readFile(resolved.path);
    return {
      ...(await metadataForPath(resolved.root, resolved.path)),
      encoding,
      data: encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8"),
    };
  });

const writeFileTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodeWriteFileArgs(args);
    const encoding = input.encoding ?? "utf8";
    const resolved = await resolveWritablePath(config, input.path);
    const tempPath = `${resolved.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, dataToBuffer(input.data, encoding), { flag: "wx" });
    try {
      await writeFile(resolved.path, await readFile(tempPath), { flag: input.flag ?? "w" });
    } finally {
      await rm(tempPath, { force: true });
    }
    return metadataForPath(resolved.root, resolved.path);
  });

const appendFileTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodeAppendFileArgs(args);
    const encoding = input.encoding ?? "utf8";
    const resolved = await resolveWritablePath(config, input.path);
    await appendFile(resolved.path, dataToBuffer(input.data, encoding));
    return metadataForPath(resolved.root, resolved.path);
  });

const readdirTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodeReaddirArgs(args);
    const resolved = await resolveExistingPath(config, input.path);
    const entry = await lstat(resolved.path);
    if (!entry.isDirectory()) throw new Error("Workspace path is not a directory");
    if (!input.withFileTypes) {
      return await readdir(resolved.path);
    }
    const entries = await readdir(resolved.path, { withFileTypes: true });
    return entries.map((dirent) => ({
      name: dirent.name,
      type: dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : "other",
    }));
  });

const statTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodePathArgs(args);
    const resolved = await resolveExistingPath(config, input.path);
    const entry = await lstat(resolved.path);
    return {
      path: resolved.relativePath,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.ctimeMs,
      birthtimeMs: entry.birthtimeMs,
    };
  });

const mkdirTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodeMkdirArgs(args);
    const resolved = await resolveWritablePath(config, input.path);
    await mkdir(resolved.path, { recursive: Boolean(input.recursive) });
    return statTool(config, { path: resolved.relativePath }).pipe(Effect.runPromise);
  });

const rmTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodeRmArgs(args);
    const resolved = await resolveExistingPath(config, input.path);
    await rm(resolved.path, {
      recursive: Boolean(input.recursive),
      force: Boolean(input.force),
    });
    return { path: resolved.relativePath, removed: true };
  });

const renameTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodeRenameArgs(args);
    const source = await resolveExistingPath(config, input.oldPath);
    const sourceEntry = await lstat(source.path);
    if (sourceEntry.isDirectory()) throw new Error("rename only supports files");
    const destination = await resolveWritablePath(config, input.newPath);
    await rename(source.path, destination.path);
    return metadataForPath(destination.root, destination.path);
  });

const copyFileTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodeCopyFileArgs(args);
    const source = await resolveExistingPath(config, input.src);
    const sourceEntry = await lstat(source.path);
    if (!sourceEntry.isFile()) throw new Error("copyFile source is not a file");
    const destination = await resolveWritablePath(config, input.dest);
    await copyFile(source.path, destination.path);
    return metadataForPath(destination.root, destination.path);
  });

const existsTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodePathArgs(args);
    const root = await ensureWorkspaceRoot(config);
    const relativePath = normalizeRelativePath(input.path);
    const target = resolve(root, relativePath);
    assertInsideRoot(root, target);
    await validateExistingSegments(root, relativePath, true);
    try {
      await access(target, fsConstants.F_OK);
      return { path: toWorkspaceRelativePath(root, target), exists: true };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return { path: toWorkspaceRelativePath(root, target), exists: false };
      }
      throw cause;
    }
  });

const getFileRefTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodePathArgs(args);
    const resolved = await resolveExistingPath(config, input.path);
    const entry = await lstat(resolved.path);
    if (!entry.isFile()) throw new Error("Workspace path is not a file");
    return makeFileRef(resolved.root, resolved.path);
  });

const resolveFileRefTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodeResolveFileRefArgs(args);
    const resolved = await resolveWorkspaceFileRef(input.ref, config);
    const { absolutePath: _absolutePath, ...metadata } = resolved;
    return metadata;
  });

const toolDeclarations = (
  config: WorkspacePluginConfig | undefined,
): readonly StaticToolDecl[] => [
  {
    name: "readFile",
    description: "Read a file from the Godtool workspace as utf8 or base64.",
    inputSchema: readFileSchema,
    handler: ({ args }) => readFileTool(config, args),
  },
  {
    name: "writeFile",
    description: "Write utf8 or base64 data to a file in the Godtool workspace.",
    inputSchema: writeFileSchema,
    handler: ({ args }) => writeFileTool(config, args),
  },
  {
    name: "appendFile",
    description: "Append utf8 or base64 data to a file in the Godtool workspace.",
    inputSchema: appendFileSchema,
    handler: ({ args }) => appendFileTool(config, args),
  },
  {
    name: "readdir",
    description: "List files in a Godtool workspace directory.",
    inputSchema: readdirSchema,
    handler: ({ args }) => readdirTool(config, args),
  },
  {
    name: "stat",
    description: "Return metadata for a Godtool workspace path.",
    inputSchema: pathSchema,
    handler: ({ args }) => statTool(config, args),
  },
  {
    name: "mkdir",
    description: "Create a directory in the Godtool workspace.",
    inputSchema: mkdirSchema,
    handler: ({ args }) => mkdirTool(config, args),
  },
  {
    name: "rm",
    description: "Remove a file or directory from the Godtool workspace.",
    inputSchema: rmSchema,
    handler: ({ args }) => rmTool(config, args),
  },
  {
    name: "rename",
    description: "Rename or move a file within the Godtool workspace.",
    inputSchema: renameSchema,
    handler: ({ args }) => renameTool(config, args),
  },
  {
    name: "copyFile",
    description: "Copy a file within the Godtool workspace.",
    inputSchema: copyFileSchema,
    handler: ({ args }) => copyFileTool(config, args),
  },
  {
    name: "exists",
    description: "Check whether a path exists in the Godtool workspace.",
    inputSchema: pathSchema,
    handler: ({ args }) => existsTool(config, args),
  },
  {
    name: "getFileRef",
    description: "Return a stable Godtool workspace file reference for a file.",
    inputSchema: pathSchema,
    handler: ({ args }) => getFileRefTool(config, args),
  },
  {
    name: "resolveFileRef",
    description: "Validate a Godtool workspace file reference and return file metadata.",
    inputSchema: resolveFileRefSchema,
    handler: ({ args }) => resolveFileRefTool(config, args),
  },
];

export const workspacePlugin = definePlugin((config?: WorkspacePluginConfig) => ({
  id: SOURCE_ID,
  storage: () => ({}),
  staticSources: () => [
    {
      id: SOURCE_ID,
      kind: SOURCE_KIND,
      name: "Workspace",
      canRemove: false,
      tools: toolDeclarations(config),
    },
  ],
}));

export type WorkspacePlugin = ReturnType<typeof workspacePlugin>;

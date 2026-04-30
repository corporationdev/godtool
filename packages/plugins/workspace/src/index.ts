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

const ReadManyArgs = Schema.Struct({
  paths: Schema.Array(Schema.String),
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

const ListTreeArgs = Schema.Struct({
  path: Schema.optional(Schema.String),
  maxDepth: Schema.optional(Schema.Number),
  maxEntries: Schema.optional(Schema.Number),
});

const SearchArgs = Schema.Struct({
  query: Schema.String,
  path: Schema.optional(Schema.String),
  caseSensitive: Schema.optional(Schema.Boolean),
  maxResults: Schema.optional(Schema.Number),
});

const ApplyPatchArgs = Schema.Struct({
  patch: Schema.String,
  dryRun: Schema.optional(Schema.Boolean),
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
const decodeReadManyArgs = Schema.decodeUnknownSync(ReadManyArgs);
const decodeWriteFileArgs = Schema.decodeUnknownSync(WriteFileArgs);
const decodeAppendFileArgs = Schema.decodeUnknownSync(AppendFileArgs);
const decodeReaddirArgs = Schema.decodeUnknownSync(ReaddirArgs);
const decodeListTreeArgs = Schema.decodeUnknownSync(ListTreeArgs);
const decodeSearchArgs = Schema.decodeUnknownSync(SearchArgs);
const decodeApplyPatchArgs = Schema.decodeUnknownSync(ApplyPatchArgs);
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

const readManySchema = {
  type: "object",
  additionalProperties: false,
  required: ["paths"],
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      description: "Workspace-relative file paths to read.",
    },
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

const listTreeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    maxDepth: {
      type: "number",
      description: "Maximum recursive depth. Defaults to 4.",
    },
    maxEntries: {
      type: "number",
      description: "Maximum number of entries to return. Defaults to 200.",
    },
  },
} as const;

const searchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description: "Literal text to search for.",
    },
    path: { type: "string" },
    caseSensitive: { type: "boolean" },
    maxResults: {
      type: "number",
      description: "Maximum number of matches to return. Defaults to 100.",
    },
  },
} as const;

const applyPatchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["patch"],
  properties: {
    patch: {
      type: "string",
      description: "Patch text using Begin Patch / Add File / Update File / Delete File blocks.",
    },
    dryRun: {
      type: "boolean",
      description: "Validate and summarize the patch without writing files.",
    },
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
  options?: { readonly createParentDirectories?: boolean },
): Promise<{ readonly root: string; readonly path: string; readonly relativePath: string }> => {
  const root = await ensureWorkspaceRoot(config);
  const relativePath = normalizeRelativePath(inputPath);
  const target = resolve(root, relativePath);
  assertInsideRoot(root, target);
  await validateExistingSegments(root, relativePath, false);
  if (options?.createParentDirectories !== false) {
    await mkdir(dirname(target), { recursive: true });
  }
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

const clampLimit = (value: number | undefined, fallback: number, maximum: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(maximum, Math.floor(value)));
};

const isProbablyText = (bytes: Buffer): boolean => !bytes.includes(0);

interface TreeEntry {
  readonly path: string;
  readonly type: "directory" | "file" | "other";
  readonly size: number;
}

const listTreeEntries = async (
  root: string,
  startPath: string,
  maxDepth: number,
  maxEntries: number,
): Promise<readonly TreeEntry[]> => {
  const entries: TreeEntry[] = [];

  const visit = async (absolutePath: string, depth: number): Promise<void> => {
    if (entries.length >= maxEntries) return;
    const entry = await lstat(absolutePath);
    const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
    entries.push({
      path: toWorkspaceRelativePath(root, absolutePath),
      type,
      size: entry.size,
    });
    if (type !== "directory" || depth >= maxDepth || entries.length >= maxEntries) return;

    const names = (await readdir(absolutePath)).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      await visit(join(absolutePath, name), depth + 1);
      if (entries.length >= maxEntries) return;
    }
  };

  await visit(startPath, 0);
  return entries;
};

interface PatchFileOperation {
  readonly kind: "add" | "update" | "delete";
  readonly path: string;
  readonly moveTo?: string;
  readonly hunks: readonly (readonly string[])[];
}

const parsePatch = (patch: string): readonly PatchFileOperation[] => {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== "*** Begin Patch") throw new Error("Patch must start with *** Begin Patch");
  if (lines.at(-1) !== "*** End Patch") throw new Error("Patch must end with *** End Patch");

  const operations: PatchFileOperation[] = [];
  let index = 1;

  while (index < lines.length - 1) {
    const header = lines[index++];
    if (!header) continue;

    const addPath = header.startsWith("*** Add File: ") ? header.slice("*** Add File: ".length) : undefined;
    const updatePath = header.startsWith("*** Update File: ")
      ? header.slice("*** Update File: ".length)
      : undefined;
    const deletePath = header.startsWith("*** Delete File: ")
      ? header.slice("*** Delete File: ".length)
      : undefined;

    if (!addPath && !updatePath && !deletePath) {
      throw new Error(`Invalid patch operation header: ${header}`);
    }

    let moveTo: string | undefined;
    if (lines[index]?.startsWith("*** Move to: ")) {
      moveTo = lines[index].slice("*** Move to: ".length);
      index += 1;
    }

    const hunks: string[][] = [];
    if (deletePath) {
      operations.push({ kind: "delete", path: deletePath, hunks });
      continue;
    }

    if (addPath) {
      const hunk: string[] = [];
      while (index < lines.length - 1 && !lines[index].startsWith("*** ")) {
        const line = lines[index++];
        if (!line.startsWith("+")) throw new Error("Add File lines must start with +");
        hunk.push(line);
      }
      operations.push({ kind: "add", path: addPath, hunks: [hunk] });
      continue;
    }

    while (index < lines.length - 1 && !lines[index].startsWith("*** ")) {
      const marker = lines[index++];
      if (!marker.startsWith("@@")) throw new Error("Update File hunks must start with @@");
      const hunk: string[] = [];
      while (index < lines.length - 1 && !lines[index].startsWith("@@") && !lines[index].startsWith("*** ")) {
        const line = lines[index++];
        if (!line.startsWith(" ") && !line.startsWith("-") && !line.startsWith("+")) {
          throw new Error("Update File hunk lines must start with space, -, or +");
        }
        hunk.push(line);
      }
      hunks.push(hunk);
    }

    operations.push({ kind: "update", path: updatePath!, moveTo, hunks });
  }

  return operations;
};

const splitContentLines = (text: string): { readonly lines: readonly string[]; readonly trailingNewline: boolean } => {
  const trailingNewline = text.endsWith("\n");
  const lines = text.replace(/\n$/, "").split("\n");
  return { lines: text.length === 0 ? [] : lines, trailingNewline };
};

const joinContentLines = (lines: readonly string[], trailingNewline: boolean): string =>
  `${lines.join("\n")}${trailingNewline && lines.length > 0 ? "\n" : ""}`;

const findSubsequence = (
  haystack: readonly string[],
  needle: readonly string[],
  startIndex: number,
): number => {
  if (needle.length === 0) return startIndex;
  for (let index = startIndex; index <= haystack.length - needle.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
};

const applyPatchHunks = (text: string, hunks: readonly (readonly string[])[]): string => {
  const parsed = splitContentLines(text);
  let lines = [...parsed.lines];
  let cursor = 0;

  for (const hunk of hunks) {
    const before = hunk
      .filter((line) => line.startsWith(" ") || line.startsWith("-"))
      .map((line) => line.slice(1));
    const after = hunk
      .filter((line) => line.startsWith(" ") || line.startsWith("+"))
      .map((line) => line.slice(1));
    const matchIndex = findSubsequence(lines, before, cursor);
    if (matchIndex < 0) throw new Error("Patch hunk did not match file contents");
    lines = [...lines.slice(0, matchIndex), ...after, ...lines.slice(matchIndex + before.length)];
    cursor = matchIndex + after.length;
  }

  return joinContentLines(lines, parsed.trailingNewline);
};

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

const readManyTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodeReadManyArgs(args);
    const encoding = input.encoding ?? "utf8";
    return await Promise.all(
      input.paths.map(async (path) => {
        const resolved = await resolveExistingPath(config, path);
        const entry = await lstat(resolved.path);
        if (!entry.isFile()) throw new Error("Workspace path is not a file");
        const bytes = await readFile(resolved.path);
        return {
          ...(await metadataForPath(resolved.root, resolved.path)),
          encoding,
          data: encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8"),
        };
      }),
    );
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

const listTreeTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodeListTreeArgs(args);
    const maxDepth = clampLimit(input.maxDepth, 4, 25);
    const maxEntries = clampLimit(input.maxEntries, 200, 5000);
    const resolved = await resolveExistingPath(config, input.path);
    return {
      root: resolved.relativePath,
      maxDepth,
      maxEntries,
      entries: await listTreeEntries(resolved.root, resolved.path, maxDepth, maxEntries),
    };
  });

const searchTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodeSearchArgs(args);
    if (input.query.length === 0) throw new Error("Search query cannot be empty");
    const maxResults = clampLimit(input.maxResults, 100, 1000);
    const resolved = await resolveExistingPath(config, input.path);
    const tree = await listTreeEntries(resolved.root, resolved.path, 25, 10000);
    const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
    const matches: Array<{ path: string; line: number; column: number; text: string }> = [];

    for (const entry of tree) {
      if (matches.length >= maxResults || entry.type !== "file") continue;
      const file = await resolveExistingPath(config, entry.path);
      const bytes = await readFile(file.path);
      if (!isProbablyText(bytes)) continue;
      const text = bytes.toString("utf8");
      const lines = text.split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const haystack = input.caseSensitive ? lines[lineIndex] : lines[lineIndex].toLowerCase();
        const columnIndex = haystack.indexOf(needle);
        if (columnIndex < 0) continue;
        matches.push({
          path: entry.path,
          line: lineIndex + 1,
          column: columnIndex + 1,
          text: lines[lineIndex],
        });
        if (matches.length >= maxResults) break;
      }
    }

    return { query: input.query, matches };
  });

const applyPatchTool = (config: WorkspacePluginConfig | undefined, args: unknown) =>
  Effect.tryPromise(async () => {
    const input = decodeApplyPatchArgs(args);
    const operations = parsePatch(input.patch);
    type PatchAction =
      | {
          readonly kind: "write";
          readonly path: string;
          readonly relativePath: string;
          readonly content: string;
          readonly createOnly: boolean;
        }
      | {
          readonly kind: "delete";
          readonly path: string;
          readonly relativePath: string;
        }
      | {
          readonly kind: "move";
          readonly fromPath: string;
          readonly fromRelativePath: string;
          readonly toPath: string;
          readonly toRelativePath: string;
          readonly content: string;
        };
    const actions: PatchAction[] = [];
    const moveTargets = new Set<string>();
    const changedFiles: string[] = [];
    const addedFiles: string[] = [];
    const deletedFiles: string[] = [];
    const movedFiles: Array<{ from: string; to: string }> = [];

    for (const operation of operations) {
      if (operation.kind === "add") {
        const resolved = await resolveWritablePath(config, operation.path, {
          createParentDirectories: false,
        });
        const content = joinContentLines(
          operation.hunks[0]?.map((line) => line.slice(1)) ?? [],
          true,
        );
        try {
          await lstat(resolved.path);
          throw new Error(`Add File target already exists: ${resolved.relativePath}`);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
        actions.push({
          kind: "write",
          path: resolved.path,
          relativePath: resolved.relativePath,
          content,
          createOnly: true,
        });
        continue;
      }

      if (operation.kind === "delete") {
        const resolved = await resolveExistingPath(config, operation.path);
        const entry = await lstat(resolved.path);
        if (!entry.isFile()) throw new Error("Delete File only supports files");
        actions.push({ kind: "delete", path: resolved.path, relativePath: resolved.relativePath });
        continue;
      }

      const source = await resolveExistingPath(config, operation.path);
      const sourceEntry = await lstat(source.path);
      if (!sourceEntry.isFile()) throw new Error("Update File only supports files");
      const current = await readFile(source.path, "utf8");
      const next = applyPatchHunks(current, operation.hunks);

      if (operation.moveTo) {
        const destination = await resolveWritablePath(config, operation.moveTo, {
          createParentDirectories: false,
        });
        if (moveTargets.has(destination.path)) {
          throw new Error(`Move target is used more than once: ${destination.relativePath}`);
        }
        moveTargets.add(destination.path);
        try {
          await lstat(destination.path);
          throw new Error(`Move target already exists: ${destination.relativePath}`);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
        actions.push({
          kind: "move",
          fromPath: source.path,
          fromRelativePath: source.relativePath,
          toPath: destination.path,
          toRelativePath: destination.relativePath,
          content: next,
        });
      } else {
        actions.push({
          kind: "write",
          path: source.path,
          relativePath: source.relativePath,
          content: next,
          createOnly: false,
        });
      }
    }

    for (const action of actions) {
      if (action.kind === "write") {
        if (!input.dryRun) {
          await mkdir(dirname(action.path), { recursive: true });
          if (action.createOnly) {
            await writeFile(action.path, action.content, { flag: "wx" });
          } else {
            const tempPath = `${action.path}.godtool-${crypto.randomUUID()}.tmp`;
            try {
              await writeFile(tempPath, action.content, { flag: "wx" });
              await rename(tempPath, action.path);
            } finally {
              await rm(tempPath, { force: true });
            }
          }
        }
        if (action.createOnly) addedFiles.push(action.relativePath);
        else changedFiles.push(action.relativePath);
        continue;
      }

      if (action.kind === "delete") {
        if (!input.dryRun) {
          await rm(action.path);
        }
        deletedFiles.push(action.relativePath);
        continue;
      }

      if (!input.dryRun) {
        await mkdir(dirname(action.toPath), { recursive: true });
        await writeFile(action.toPath, action.content, { flag: "wx" });
        await rm(action.fromPath);
      }
      movedFiles.push({ from: action.fromRelativePath, to: action.toRelativePath });
      changedFiles.push(action.toRelativePath);
    }

    return { changedFiles, addedFiles, deletedFiles, movedFiles, dryRun: Boolean(input.dryRun) };
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
    name: "readMany",
    description: "Read multiple files from the Godtool workspace as utf8 or base64.",
    inputSchema: readManySchema,
    handler: ({ args }) => readManyTool(config, args),
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
    name: "listTree",
    description: "List a bounded recursive tree of files in the Godtool workspace.",
    inputSchema: listTreeSchema,
    handler: ({ args }) => listTreeTool(config, args),
  },
  {
    name: "search",
    description: "Search for literal text in workspace files.",
    inputSchema: searchSchema,
    handler: ({ args }) => searchTool(config, args),
  },
  {
    name: "applyPatch",
    description: "Apply a patch to add, update, delete, or move files in the Godtool workspace.",
    inputSchema: applyPatchSchema,
    handler: ({ args }) => applyPatchTool(config, args),
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

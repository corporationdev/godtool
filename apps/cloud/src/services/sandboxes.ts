import { createHash } from "node:crypto";

import { initialize, SandboxInstance } from "@blaxel/core";
import { resolveRuntimeContext } from "@executor/config/runtime";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { EXECUTE_RUNTIME_ASSETS } from "./execute-runtime.generated";
import { SANDBOX_SCAFFOLD_ROOT_DIRECTORY, sandboxScaffoldFiles } from "./sandbox-scaffold";
import { sandboxes } from "./schema";
import type { DrizzleDb } from "./db";

const DEFAULT_BLAXEL_MEMORY_MB = 4096;
const BLAXEL_OPERATION_TIMEOUT_MS = 45_000;
const BLAXEL_PROVIDER = "blaxel" as const;
const SANDBOX_WORKSPACE_DIRECTORY = SANDBOX_SCAFFOLD_ROOT_DIRECTORY;
const INTERNAL_RUNTIME_ROOT_DIRECTORY = "/root/.godtool";
const INTERNAL_RUNTIME_DIRECTORY = `${INTERNAL_RUNTIME_ROOT_DIRECTORY}/runtime`;
const EXECUTE_RUNTIME_DIRECTORY = `${INTERNAL_RUNTIME_DIRECTORY}/execute`;
const EXECUTE_RUNTIME_SERVER_PATH = `${EXECUTE_RUNTIME_DIRECTORY}/server.js`;
const EXECUTE_RUNTIME_VERSION_PATH = `${EXECUTE_RUNTIME_DIRECTORY}/version.txt`;
const EXECUTE_RUNTIME_PROCESS_NAME = "godtool-execute-runtime";
const EXECUTE_RUNTIME_START_POLL_MS = 250;
const EXECUTE_RUNTIME_START_TIMEOUT_MS = 10_000;
const CODE_SERVER_PORT = 8081;
const CODE_SERVER_PROCESS_NAME = "code-server";
const CODE_SERVER_PREVIEW_NAME = "code-server";
const CODE_SERVER_START_POLL_MS = 250;
const CODE_SERVER_START_TIMEOUT_MS = 15_000;
const CODE_SERVER_CONFIG_DIRECTORY = "/root/.config/code-server";
const CODE_SERVER_CONFIG_PATH = `${CODE_SERVER_CONFIG_DIRECTORY}/config.yaml`;
const CODE_SERVER_TOKEN_TTL_MS = 1000 * 60 * 30;
const DESKTOP_PORT = 6080;
const DESKTOP_RUNTIME_PROCESS_NAME = "godtool-desktop-runtime";
const DESKTOP_RUNTIME_COMMAND_PATH = "/usr/local/bin/godtool-desktop-runtime";
const DESKTOP_PREVIEW_NAME = "desktop-vnc-public";
const DESKTOP_START_POLL_MS = 500;
const DESKTOP_START_TIMEOUT_MS = 60_000;
const DESKTOP_HEALTH_FETCH_TIMEOUT_MS = 5_000;
const DESKTOP_TOKEN_TTL_MS = 1000 * 60 * 30;
const MAX_PROCESS_LOG_CHARS = 12_000;
const MAX_SANDBOX_NAME_LENGTH = 49;
const SANDBOX_NAME_HASH_LENGTH = 8;
const SANDBOX_NAME_PREFIX = "godtool-org";
const SANDBOX_NAME_RANDOM_SUFFIX_LENGTH = 8;
export const EXECUTE_RUNTIME_PORT = 4789;
export const EXECUTE_RUNTIME_PROCESS_NAME_FOR_TESTS = EXECUTE_RUNTIME_PROCESS_NAME;
export const EXECUTE_RUNTIME_SERVER_PATH_FOR_TESTS = EXECUTE_RUNTIME_SERVER_PATH;
export const EXECUTE_RUNTIME_VERSION_PATH_FOR_TESTS = EXECUTE_RUNTIME_VERSION_PATH;
export const CODE_SERVER_PROCESS_NAME_FOR_TESTS = CODE_SERVER_PROCESS_NAME;
export const CODE_SERVER_CONFIG_PATH_FOR_TESTS = CODE_SERVER_CONFIG_PATH;

export type SandboxStatus = "creating" | "ready" | "error";
export type SandboxRecord = typeof sandboxes.$inferSelect;

export interface EnsuredSandbox {
  readonly externalId: string;
  readonly record: SandboxRecord;
  readonly sandboxName: string;
  readonly status: "created" | "reused";
}

export interface ExecuteRuntimeInstallResult {
  readonly cacheHit: boolean;
  readonly runtimeVersion: string;
}

export interface EnsuredExecuteRuntime {
  readonly health: {
    readonly ok: true;
    readonly status: number;
  };
  readonly install: ExecuteRuntimeInstallResult;
  readonly runtime: {
    readonly status: "started" | "reused";
  };
  readonly sandbox: EnsuredSandbox;
}

export interface CodeServerSession {
  readonly expiresAt: string;
  readonly sandboxId: string;
  readonly sandboxStatus: "created" | "reused";
  readonly url: string;
}

export interface DesktopSession {
  readonly expiresAt: string;
  readonly sandboxId: string;
  readonly sandboxStatus: "created" | "reused";
  readonly url: string;
}

export interface SandboxProvider {
  readonly createOrGetSandbox: (args: { readonly organizationId: string }) => Promise<{
    readonly externalId: string;
    readonly sandboxName: string;
    readonly status: "created" | "reused";
  }>;
  readonly wakeSandbox: (args: {
    readonly externalId: string;
    readonly organizationId: string;
  }) => Promise<{
    readonly externalId: string;
    readonly sandboxName: string;
    readonly status: "reused";
  }>;
}

export interface SandboxProcessExecOptions {
  readonly command: string;
  readonly env?: Record<string, string>;
  readonly maxRestarts?: number;
  readonly name: string;
  readonly restartOnFailure?: boolean;
  readonly timeout?: number;
  readonly waitForCompletion?: boolean;
  readonly workingDir?: string;
}

export interface SandboxProcessResult {
  readonly command: string;
  readonly exitCode: number;
  readonly logs: string;
  readonly name: string;
  readonly pid: string;
  readonly status: string;
  readonly stderr: string;
  readonly stdout: string;
}

export interface SandboxResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text?: () => Promise<string>;
}

interface SandboxPreview {
  readonly spec: {
    readonly url?: string;
  };
  readonly tokens: {
    readonly create: (expiresAt: Date) => Promise<{
      readonly expiresAt: string | Date;
      readonly value: string;
    }>;
  };
}

export interface SandboxHandle {
  readonly fetch: (
    port: number,
    path: string,
    init?: {
      readonly body?: string;
      readonly headers?: Record<string, string>;
      readonly method?: string;
    },
  ) => Promise<SandboxResponse>;
  readonly previews: {
    readonly createIfNotExists: (args: {
      readonly metadata: {
        readonly name: string;
      };
      readonly spec: {
        readonly port: number;
        readonly public: boolean;
      };
    }) => Promise<{
      readonly spec: {
        readonly url?: string;
      };
      readonly tokens: {
        readonly create: (expiresAt: Date) => Promise<{
          readonly expiresAt: string | Date;
          readonly value: string;
        }>;
      };
    }>;
    readonly get: (name: string) => Promise<SandboxPreview>;
  };
  readonly fs: {
    readonly mkdir: (path: string) => Promise<unknown>;
    readonly read: (path: string) => Promise<string>;
    readonly write: (path: string, content: string) => Promise<unknown>;
  };
  readonly process: {
    readonly exec: (options: SandboxProcessExecOptions) => Promise<SandboxProcessResult>;
    readonly kill: (name: string) => Promise<unknown>;
    readonly logs: (name: string, scope: "all") => Promise<string>;
    readonly stop: (name: string) => Promise<unknown>;
  };
}

export interface SandboxHandleProvider {
  readonly getSandboxHandle: (externalId: string) => Promise<SandboxHandle>;
}

export interface SandboxesServiceOptions {
  readonly codeServerStartPollMs?: number;
  readonly codeServerStartTimeoutMs?: number;
  readonly desktopStartPollMs?: number;
  readonly desktopStartTimeoutMs?: number;
  readonly executeRuntimeStartPollMs?: number;
  readonly executeRuntimeStartTimeoutMs?: number;
}

const getRequiredRuntimeContext = () => {
  const stage = env.STAGE?.trim();

  if (!stage) {
    throw new Error("Missing STAGE");
  }

  return resolveRuntimeContext(stage);
};

const getRequiredBlaxelConfig = () => {
  const apiKey = env.BLAXEL_API_KEY?.trim();
  const runtime = getRequiredRuntimeContext();

  if (!apiKey) {
    throw new Error("Missing BLAXEL_API_KEY");
  }

  return {
    apiKey,
    memoryMb: DEFAULT_BLAXEL_MEMORY_MB,
    region: runtime.blaxelRegion,
    templateImage: runtime.blaxelTemplateImage,
    workspace: runtime.blaxelWorkspace,
  };
};

let initializedKey: string | null = null;

const configureBlaxel = () => {
  const config = getRequiredBlaxelConfig();
  const nextKey = `${config.workspace}:${config.region}:${config.templateImage}`;

  process.env.BL_WORKSPACE = config.workspace;
  process.env.BL_API_KEY = config.apiKey;
  process.env.BL_REGION = config.region;

  if (initializedKey !== nextKey) {
    console.info("[sandboxes] configuring Blaxel", {
      region: config.region,
      templateImage: config.templateImage,
      workspace: config.workspace,
    });
    initialize({
      apiKey: config.apiKey,
      workspace: config.workspace,
    });
    initializedKey = nextKey;
  }

  process.env.BL_REGION = config.region;
  return config;
};

const normalizeSandboxNameSegment = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "org";
};

export const getSandboxNameForOrganization = (organizationId: string) => {
  const hash = createHash("sha256")
    .update(organizationId)
    .digest("hex")
    .slice(0, SANDBOX_NAME_HASH_LENGTH);
  const maxSegmentLength =
    MAX_SANDBOX_NAME_LENGTH - SANDBOX_NAME_PREFIX.length - SANDBOX_NAME_HASH_LENGTH - 2;
  const baseSegment = normalizeSandboxNameSegment(organizationId)
    .slice(0, maxSegmentLength)
    .replace(/-+$/g, "");

  return `${SANDBOX_NAME_PREFIX}-${baseSegment || "org"}-${hash}`;
};

const getFreshSandboxNameForOrganization = (organizationId: string) => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, SANDBOX_NAME_RANDOM_SUFFIX_LENGTH);
  const deterministicPrefix = getSandboxNameForOrganization(organizationId);
  const maxPrefixLength =
    MAX_SANDBOX_NAME_LENGTH - SANDBOX_NAME_RANDOM_SUFFIX_LENGTH - 1;

  return `${deterministicPrefix.slice(0, maxPrefixLength).replace(/-+$/g, "")}-${suffix}`;
};

const resolveSandboxExternalId = async (
  sandbox: Awaited<ReturnType<typeof SandboxInstance.get>>,
) => {
  await withTimeout(sandbox.wait(), BLAXEL_OPERATION_TIMEOUT_MS, "Blaxel sandbox wait");
  const externalId = sandbox.metadata.name?.trim();

  if (!externalId) {
    throw new Error("Blaxel sandbox is missing a stable name.");
  }

  return externalId;
};

export const makeBlaxelSandboxProvider = (): SandboxProvider => ({
  createOrGetSandbox: async ({ organizationId }) => {
    const config = configureBlaxel();
    const sandboxName = getFreshSandboxNameForOrganization(organizationId);
    console.info("[sandboxes] creating fresh sandbox", {
      organizationId,
      region: config.region,
      sandboxName,
      workspace: config.workspace,
    });
    const sandbox = await withTimeout(
      SandboxInstance.createIfNotExists({
        image: config.templateImage,
        labels: {
          app: "godtool",
          organizationId,
        },
        memory: config.memoryMb,
        name: sandboxName,
        ports: [
          {
            protocol: "HTTP",
            target: EXECUTE_RUNTIME_PORT,
          },
          {
            protocol: "HTTP",
            target: CODE_SERVER_PORT,
          },
          {
            protocol: "HTTP",
            target: DESKTOP_PORT,
          },
        ],
        region: config.region,
      }),
      BLAXEL_OPERATION_TIMEOUT_MS,
      `Blaxel createIfNotExists(${sandboxName})`,
    );

    return {
      externalId: await resolveSandboxExternalId(sandbox),
      sandboxName,
      status: "created",
    };
  },

  wakeSandbox: async ({ externalId, organizationId }) => {
    const config = configureBlaxel();
    console.info("[sandboxes] waking sandbox", {
      externalId,
      organizationId,
      region: config.region,
      workspace: config.workspace,
    });
    const sandbox = await withTimeout(
      SandboxInstance.get(externalId),
      BLAXEL_OPERATION_TIMEOUT_MS,
      `Blaxel get(${externalId})`,
    );

    return {
      externalId: await resolveSandboxExternalId(sandbox),
      sandboxName: externalId,
      status: "reused",
    };
  },
});

export const makeBlaxelSandboxHandleProvider = (): SandboxHandleProvider => ({
  getSandboxHandle: async (externalId) => {
    const config = configureBlaxel();
    console.info("[sandboxes] attaching sandbox handle", {
      externalId,
      region: config.region,
      workspace: config.workspace,
    });
    const sandbox = await withTimeout(
      SandboxInstance.get(externalId),
      BLAXEL_OPERATION_TIMEOUT_MS,
      `Blaxel get(${externalId})`,
    );
    await withTimeout(sandbox.wait(), BLAXEL_OPERATION_TIMEOUT_MS, "Blaxel sandbox wait");
    return sandbox as unknown as SandboxHandle;
  },
});

const inferBrokenMessage = (organizationId: string, error: string | null | undefined) =>
  error?.trim().length ? error : `Sandbox for organization "${organizationId}" is marked broken.`;

const ensureRuntimeAssetsPresent = () => {
  if (
    typeof EXECUTE_RUNTIME_ASSETS.server !== "string" ||
    EXECUTE_RUNTIME_ASSETS.server.trim().length === 0
  ) {
    throw new Error(
      "Sandbox execute runtime assets are missing from the generated module. Run `bun run rebuild:execute-runtime` before using the sandbox runtime.",
    );
  }

  return EXECUTE_RUNTIME_ASSETS;
};

export const getExecuteRuntimeVersion = (): string =>
  createHash("sha256").update(ensureRuntimeAssetsPresent().server).digest("hex");

const sleep = (durationMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });

const truncateOutput = (output: string, maxChars: number): string => {
  if (output.length <= maxChars) {
    return output;
  }

  return `${output.slice(0, maxChars)}\n...[truncated ${output.length - maxChars} characters]`;
};

const renderUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const code = "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
    return `${error.message}${code}`;
  }

  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }

  return String(error);
};

const includesAlreadyRunningProcessMarker = (value: string, processName: string): boolean =>
  value.includes(`process with name '${processName}' already exists and is running`);

const isProcessAlreadyRunningError = (error: unknown, processName: string): boolean => {
  if (typeof error === "string") {
    return includesAlreadyRunningProcessMarker(error, processName);
  }

  if (error instanceof Error) {
    return (
      includesAlreadyRunningProcessMarker(error.message, processName) ||
      isProcessAlreadyRunningError(error.cause, processName)
    );
  }

  if (hasOwn(error, "message") && typeof error.message === "string") {
    return includesAlreadyRunningProcessMarker(error.message, processName);
  }

  if (hasOwn(error, "error")) {
    return isProcessAlreadyRunningError(error.error, processName);
  }

  if (hasOwn(error, "cause")) {
    return isProcessAlreadyRunningError(error.cause, processName);
  }

  return false;
};

const hasOwn = <K extends string>(value: unknown, key: K): value is Record<K, unknown> =>
  typeof value === "object" && value !== null && key in value;

const includesRetryableSandboxMarker = (value: string): boolean =>
  value.includes("IMAGE_NOT_FOUND") ||
  value.includes("WORKLOAD_UNAVAILABLE") ||
  value.includes("Timed out waiting for the desktop stream to become healthy") ||
  /Blaxel .* timed out after \d+ms/i.test(value) ||
  /Sandbox .* timed out after \d+ms/i.test(value) ||
  /retry with exponential backoff/i.test(value);

const isRetryableSandboxError = (error: unknown): boolean => {
  if (typeof error === "string") {
    return includesRetryableSandboxMarker(error);
  }

  if (error instanceof Error) {
    return includesRetryableSandboxMarker(error.message) || isRetryableSandboxError(error.cause);
  }

  if (hasOwn(error, "retryable") && error.retryable === true) {
    return true;
  }

  if (hasOwn(error, "code") && error.code === "WORKLOAD_UNAVAILABLE") {
    return true;
  }

  if (hasOwn(error, "message") && typeof error.message === "string") {
    return includesRetryableSandboxMarker(error.message);
  }

  if (hasOwn(error, "error")) {
    return isRetryableSandboxError(error.error);
  }

  if (hasOwn(error, "cause")) {
    return isRetryableSandboxError(error.cause);
  }

  return false;
};

const includesUnavailableSandboxMarker = (value: string): boolean =>
  /currently not available/i.test(value) || /verify it exists and is running/i.test(value);

const isSandboxNotFoundError = (error: unknown): boolean => {
  if (typeof error === "string") {
    return /"status"\s*:\s*404/.test(error) || /"statusText"\s*:\s*"Not Found"/.test(error);
  }

  if (error instanceof Error) {
    return isSandboxNotFoundError(error.message) || isSandboxNotFoundError(error.cause);
  }

  if (hasOwn(error, "status") && error.status === 404) {
    return true;
  }

  if (hasOwn(error, "statusText") && error.statusText === "Not Found") {
    return true;
  }

  if (hasOwn(error, "message") && typeof error.message === "string") {
    return isSandboxNotFoundError(error.message);
  }

  if (hasOwn(error, "error")) {
    return isSandboxNotFoundError(error.error);
  }

  if (hasOwn(error, "cause")) {
    return isSandboxNotFoundError(error.cause);
  }

  return false;
};

const isRetryableSandboxUnavailableError = (error: unknown): boolean => {
  if (isSandboxNotFoundError(error)) {
    return true;
  }

  if (!isRetryableSandboxError(error)) {
    return false;
  }

  if (typeof error === "string") {
    return includesUnavailableSandboxMarker(error);
  }

  if (error instanceof Error) {
    return (
      includesUnavailableSandboxMarker(error.message) ||
      isRetryableSandboxUnavailableError(error.cause)
    );
  }

  if (hasOwn(error, "status") && error.status === 404) {
    return true;
  }

  if (hasOwn(error, "message") && typeof error.message === "string") {
    return includesUnavailableSandboxMarker(error.message);
  }

  if (hasOwn(error, "error")) {
    return isRetryableSandboxUnavailableError(error.error);
  }

  if (hasOwn(error, "cause")) {
    return isRetryableSandboxUnavailableError(error.cause);
  }

  return false;
};

const includesResourceAlreadyExistsMarker = (value: string): boolean =>
  /Resource already exists/i.test(value) || /"code"\s*:\s*409/.test(value);

const isResourceAlreadyExistsError = (error: unknown): boolean => {
  if (typeof error === "string") {
    return includesResourceAlreadyExistsMarker(error);
  }

  if (error instanceof Error) {
    return includesResourceAlreadyExistsMarker(error.message) || isResourceAlreadyExistsError(error.cause);
  }

  if (hasOwn(error, "code") && error.code === 409) {
    return true;
  }

  if (hasOwn(error, "status") && error.status === 409) {
    return true;
  }

  if (hasOwn(error, "message") && typeof error.message === "string") {
    return includesResourceAlreadyExistsMarker(error.message);
  }

  if (hasOwn(error, "error")) {
    return isResourceAlreadyExistsError(error.error);
  }

  if (hasOwn(error, "cause")) {
    return isResourceAlreadyExistsError(error.cause);
  }

  return false;
};

const throwSandboxFailure = async (
  store: ReturnType<typeof makeSandboxStore>,
  organizationId: string,
  error: unknown,
): Promise<never> => {
  const rendered = renderUnknownError(error);

  if (
    isRetryableSandboxError(error) ||
    isRetryableSandboxError(rendered) ||
    isRetryableSandboxUnavailableError(error) ||
    isRetryableSandboxUnavailableError(rendered)
  ) {
    throw new Error(rendered);
  }

  const broken = await store.markError({
    error: rendered,
    organizationId,
  });
  throw new Error(inferBrokenMessage(organizationId, broken.error));
};

const ensureSandboxPreview = async (
  sandbox: SandboxHandle,
  args: Parameters<SandboxHandle["previews"]["createIfNotExists"]>[0],
  description: string,
): Promise<SandboxPreview> => {
  try {
    return await withTimeout(
      sandbox.previews.createIfNotExists(args),
      BLAXEL_OPERATION_TIMEOUT_MS,
      description,
    );
  } catch (error) {
    if (!isResourceAlreadyExistsError(error)) {
      throw error;
    }

    return await withTimeout(
      sandbox.previews.get(args.metadata.name),
      BLAXEL_OPERATION_TIMEOUT_MS,
      `${description} conflict get(${args.metadata.name})`,
    );
  }
};

const quoteShellArgument = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const readProcessResultString = (
  result: Partial<SandboxProcessResult>,
  key: "command" | "logs" | "name" | "pid" | "status" | "stderr" | "stdout",
): string => {
  const value = result[key];
  return typeof value === "string" ? value : "";
};

const normalizeProcessResult = (
  result: Partial<SandboxProcessResult>,
  fallbackName: string,
  fallbackCommand: string,
): SandboxProcessResult => ({
  command: readProcessResultString(result, "command") || fallbackCommand,
  exitCode:
    typeof result.exitCode === "number" && Number.isFinite(result.exitCode)
      ? result.exitCode
      : 0,
  logs: readProcessResultString(result, "logs"),
  name: readProcessResultString(result, "name") || fallbackName,
  pid: readProcessResultString(result, "pid"),
  status: readProcessResultString(result, "status"),
  stderr: readProcessResultString(result, "stderr"),
  stdout: readProcessResultString(result, "stdout"),
});

const buildDesktopCommandEnvironment = (): Record<string, string> => ({
  CHROME_DEBUGGING_PORT: "9222",
  DESKTOP_SESSION: "xfce",
  DISPLAY: ":0",
  HOME: "/home/desktop",
  ICEAUTHORITY: "/tmp/desktop.ICEauthority",
  XAUTHORITY: "/tmp/desktop.Xauthority",
  XDG_CONFIG_DIRS: "/etc/xdg:/etc",
  XDG_CURRENT_DESKTOP: "XFCE",
  XDG_DATA_DIRS: "/usr/local/share:/usr/share",
  XDG_RUNTIME_DIR: "/tmp/xdg-runtime-desktop",
  XDG_SESSION_TYPE: "x11",
});

const withTimeout = async <A>(
  promise: Promise<A>,
  timeoutMs: number,
  description: string,
): Promise<A> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${description} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const ensureDirectoryExists = async (sandbox: SandboxHandle, path: string) => {
  try {
    await withTimeout(
      sandbox.fs.mkdir(path),
      BLAXEL_OPERATION_TIMEOUT_MS,
      `Sandbox mkdir(${path})`,
    );
  } catch {
    // Directory already exists.
  }
};

const ensureDirectoryTreeExists = async (sandbox: SandboxHandle, path: string) => {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  let currentPath = "";

  for (const segment of segments) {
    currentPath = `${currentPath}/${segment}`;
    await ensureDirectoryExists(sandbox, currentPath);
  }
};

const ensureFileExists = async (
  sandbox: SandboxHandle,
  path: string,
  content: string,
): Promise<void> => {
  try {
    await sandbox.fs.read(path);
    return;
  } catch {
    await sandbox.fs.write(path, content);
  }
};

const ensureWorkspaceScaffold = async (sandbox: SandboxHandle): Promise<void> => {
  await ensureDirectoryTreeExists(sandbox, SANDBOX_WORKSPACE_DIRECTORY);

  for (const file of sandboxScaffoldFiles) {
    const targetPath = `${SANDBOX_WORKSPACE_DIRECTORY}/${file.path}`;
    const targetDirectory = targetPath.slice(0, Math.max(0, targetPath.lastIndexOf("/")));

    if (targetDirectory.length > 0) {
      await ensureDirectoryTreeExists(sandbox, targetDirectory);
    }

    await ensureFileExists(sandbox, targetPath, file.content);
  }
};

export const makeSandboxStore = (db: DrizzleDb) => {
  const getByOrganizationId = async (organizationId: string) => {
    const rows = await db
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.organizationId, organizationId));
    return rows[0] ?? null;
  };

  const createPending = async (organizationId: string) => {
    const [created] = await db
      .insert(sandboxes)
      .values({
        organizationId,
        provider: BLAXEL_PROVIDER,
        status: "creating",
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();

    return created ?? (await getByOrganizationId(organizationId));
  };

  const markReady = async (args: {
    readonly externalId: string;
    readonly organizationId: string;
  }) => {
    const [updated] = await db
      .update(sandboxes)
      .set({
        error: null,
        externalId: args.externalId,
        status: "ready",
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.organizationId, args.organizationId))
      .returning();

    if (!updated) {
      throw new Error(`Sandbox row for organization "${args.organizationId}" disappeared.`);
    }

    return updated;
  };

  const markError = async (args: { readonly error: string; readonly organizationId: string }) => {
    const [updated] = await db
      .update(sandboxes)
      .set({
        error: args.error,
        status: "error",
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.organizationId, args.organizationId))
      .returning();

    if (!updated) {
      throw new Error(`Sandbox row for organization "${args.organizationId}" disappeared.`);
    }

    return updated;
  };

  const resetForReprovision = async (organizationId: string) => {
    const [updated] = await db
      .update(sandboxes)
      .set({
        error: null,
        externalId: null,
        status: "creating",
        updatedAt: new Date(),
      })
      .where(eq(sandboxes.organizationId, organizationId))
      .returning();

    if (!updated) {
      throw new Error(`Sandbox row for organization "${organizationId}" disappeared.`);
    }

    return updated;
  };

  return {
    createPending,
    getByOrganizationId,
    markError,
    markReady,
    resetForReprovision,
  };
};

export const fetchExecuteRuntimeHealth = async (
  sandbox: SandboxHandle,
): Promise<{ readonly ok: boolean; readonly status: number }> => {
  try {
    const response = await sandbox.fetch(EXECUTE_RUNTIME_PORT, "/health");
    return {
      ok: response.ok,
      status: response.status,
    };
  } catch {
    return {
      ok: false,
      status: 0,
    };
  }
};

export const ensureExecuteRuntimeInstalled = async (
  sandbox: SandboxHandle,
): Promise<ExecuteRuntimeInstallResult> => {
  const assets = ensureRuntimeAssetsPresent();
  const runtimeVersion = getExecuteRuntimeVersion();

  try {
    const installedVersion = (await sandbox.fs.read(EXECUTE_RUNTIME_VERSION_PATH)).trim();
    if (installedVersion === runtimeVersion) {
      return {
        cacheHit: true,
        runtimeVersion,
      };
    }
  } catch {
    // Runtime not installed yet or marker missing.
  }

  await ensureDirectoryTreeExists(sandbox, INTERNAL_RUNTIME_ROOT_DIRECTORY);
  await ensureDirectoryTreeExists(sandbox, INTERNAL_RUNTIME_DIRECTORY);
  await ensureDirectoryTreeExists(sandbox, EXECUTE_RUNTIME_DIRECTORY);
  await sandbox.fs.write(EXECUTE_RUNTIME_SERVER_PATH, assets.server);
  await sandbox.fs.write(EXECUTE_RUNTIME_VERSION_PATH, runtimeVersion);

  return {
    cacheHit: false,
    runtimeVersion,
  };
};

const stopExecuteRuntimeProcess = async (sandbox: SandboxHandle): Promise<void> => {
  try {
    await sandbox.process.stop(EXECUTE_RUNTIME_PROCESS_NAME);
    return;
  } catch {
    // Process may not be running or may require a kill.
  }

  try {
    await sandbox.process.kill(EXECUTE_RUNTIME_PROCESS_NAME);
  } catch {
    // Process does not exist.
  }
};

const waitForExecuteRuntimeHealth = async (
  sandbox: SandboxHandle,
  options?: SandboxesServiceOptions,
) => {
  const timeoutMs = options?.executeRuntimeStartTimeoutMs ?? EXECUTE_RUNTIME_START_TIMEOUT_MS;
  const pollMs = options?.executeRuntimeStartPollMs ?? EXECUTE_RUNTIME_START_POLL_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const health = await fetchExecuteRuntimeHealth(sandbox);
    if (health.ok) {
      return {
        ok: true as const,
        status: health.status,
      };
    }

    await sleep(pollMs);
  }

  const processLogs = await sandbox.process
    .logs(EXECUTE_RUNTIME_PROCESS_NAME, "all")
    .catch(() => "");
  throw new Error(
    processLogs.trim().length > 0
      ? `Timed out waiting for execute runtime to become healthy.\n${truncateOutput(processLogs.trim(), MAX_PROCESS_LOG_CHARS)}`
      : "Timed out waiting for execute runtime to become healthy.",
  );
};

const fetchCodeServerHealth = async (
  sandbox: SandboxHandle,
): Promise<{ readonly ok: boolean; readonly status: number }> => {
  try {
    const response = await sandbox.fetch(CODE_SERVER_PORT, "/healthz");
    return {
      ok: response.ok,
      status: response.status,
    };
  } catch {
    return {
      ok: false,
      status: 0,
    };
  }
};

const stopCodeServerProcess = async (sandbox: SandboxHandle): Promise<void> => {
  try {
    await sandbox.process.stop(CODE_SERVER_PROCESS_NAME);
    return;
  } catch {
    // Process may not be running or may require a kill.
  }

  try {
    await sandbox.process.kill(CODE_SERVER_PROCESS_NAME);
  } catch {
    // Process does not exist.
  }
};

const ensureCodeServerConfig = async (sandbox: SandboxHandle): Promise<void> => {
  await ensureDirectoryExists(sandbox, "/root/.config");
  await ensureDirectoryExists(sandbox, CODE_SERVER_CONFIG_DIRECTORY);
  await sandbox.fs.write(
    CODE_SERVER_CONFIG_PATH,
    [
      `bind-addr: 0.0.0.0:${CODE_SERVER_PORT}`,
      "auth: none",
      "cert: false",
      "trusted-origins:",
      '  - "*"',
      "",
    ].join("\n"),
  );
};

const waitForCodeServerHealth = async (
  sandbox: SandboxHandle,
  options?: SandboxesServiceOptions,
): Promise<{ readonly ok: true; readonly status: number }> => {
  const timeoutMs = options?.codeServerStartTimeoutMs ?? CODE_SERVER_START_TIMEOUT_MS;
  const pollMs = options?.codeServerStartPollMs ?? CODE_SERVER_START_POLL_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const health = await fetchCodeServerHealth(sandbox);
    if (health.ok) {
      return {
        ok: true,
        status: health.status,
      };
    }

    await sleep(pollMs);
  }

  const processLogs = await sandbox.process.logs(CODE_SERVER_PROCESS_NAME, "all").catch(() => "");
  throw new Error(
    processLogs.trim().length > 0
      ? `Timed out waiting for code-server to become healthy.\n${truncateOutput(processLogs.trim(), MAX_PROCESS_LOG_CHARS)}`
      : "Timed out waiting for code-server to become healthy.",
  );
};

const ensureCodeServerRunning = async (
  sandbox: SandboxHandle,
  options?: SandboxesServiceOptions,
): Promise<void> => {
  await ensureCodeServerConfig(sandbox);

  const health = await fetchCodeServerHealth(sandbox);
  if (health.ok) {
    return;
  }

  await stopCodeServerProcess(sandbox);

  try {
    await sandbox.process.exec({
      command: [
        "code-server",
        "--disable-telemetry",
        "--config",
        quoteShellArgument(CODE_SERVER_CONFIG_PATH),
        quoteShellArgument(SANDBOX_WORKSPACE_DIRECTORY),
      ].join(" "),
      env: {
        PORT: String(CODE_SERVER_PORT),
      },
      maxRestarts: 5,
      name: CODE_SERVER_PROCESS_NAME,
      restartOnFailure: true,
      waitForCompletion: false,
      workingDir: SANDBOX_WORKSPACE_DIRECTORY,
    });
  } catch (error) {
    if (!isProcessAlreadyRunningError(error, CODE_SERVER_PROCESS_NAME)) {
      throw error;
    }
  }

  await waitForCodeServerHealth(sandbox, options);
};

const createCodeServerSession = async (
  sandbox: SandboxHandle,
  ensuredSandbox: EnsuredSandbox,
): Promise<CodeServerSession> => {
  const preview = await ensureSandboxPreview(
    sandbox,
    {
      metadata: {
        name: CODE_SERVER_PREVIEW_NAME,
      },
      spec: {
        port: CODE_SERVER_PORT,
        public: false,
      },
    },
    "Blaxel code-server preview createIfNotExists",
  );
  const previewUrl = preview.spec.url?.trim();

  if (!previewUrl) {
    throw new Error("Blaxel preview URL is missing for code-server.");
  }

  const expiresAt = new Date(Date.now() + CODE_SERVER_TOKEN_TTL_MS);
  const token = await withTimeout(
    preview.tokens.create(expiresAt),
    BLAXEL_OPERATION_TIMEOUT_MS,
    "Blaxel code-server preview token create",
  );
  const url = new URL(previewUrl);
  url.searchParams.set("bl_preview_token", token.value);

  return {
    expiresAt:
      typeof token.expiresAt === "string" ? token.expiresAt : token.expiresAt.toISOString(),
    sandboxId: ensuredSandbox.externalId,
    sandboxStatus: ensuredSandbox.status,
    url: url.toString(),
  };
};

const fetchDesktopHealth = async (
  sandbox: SandboxHandle,
): Promise<{ readonly ok: boolean; readonly status: number }> => {
  try {
    const response = await withTimeout(
      sandbox.fetch(DESKTOP_PORT, "/vnc.html"),
      DESKTOP_HEALTH_FETCH_TIMEOUT_MS,
      "Sandbox desktop health fetch",
    );
    return {
      ok: response.ok,
      status: response.status,
    };
  } catch {
    return {
      ok: false,
      status: 0,
    };
  }
};

const waitForDesktopHealth = async (
  sandbox: SandboxHandle,
  options?: SandboxesServiceOptions,
): Promise<{ readonly ok: true; readonly status: number }> => {
  const timeoutMs = options?.desktopStartTimeoutMs ?? DESKTOP_START_TIMEOUT_MS;
  const pollMs = options?.desktopStartPollMs ?? DESKTOP_START_POLL_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const health = await fetchDesktopHealth(sandbox);
    console.info("[sandboxes] desktop health probe", {
      ok: health.ok,
      status: health.status,
    });
    if (health.ok) {
      return {
        ok: true,
        status: health.status,
      };
    }

    await sleep(pollMs);
  }

  throw new Error("Timed out waiting for the desktop stream to become healthy.");
};

const stopDesktopRuntimeProcess = async (sandbox: SandboxHandle): Promise<void> => {
  try {
    await sandbox.process.stop(DESKTOP_RUNTIME_PROCESS_NAME);
    return;
  } catch {
    // Process may not be running or may require a kill.
  }

  try {
    await sandbox.process.kill(DESKTOP_RUNTIME_PROCESS_NAME);
  } catch {
    // Process does not exist.
  }
};

const ensureDesktopRunning = async (
  sandbox: SandboxHandle,
  options?: SandboxesServiceOptions,
): Promise<void> => {
  const health = await fetchDesktopHealth(sandbox);
  if (health.ok) {
    console.info("[sandboxes] desktop runtime already healthy", {
      status: health.status,
    });
    return;
  }

  console.info("[sandboxes] starting desktop runtime process", {
    status: health.status,
  });
  await stopDesktopRuntimeProcess(sandbox);

  try {
    await sandbox.process.exec({
      command: DESKTOP_RUNTIME_COMMAND_PATH,
      maxRestarts: 5,
      name: DESKTOP_RUNTIME_PROCESS_NAME,
      restartOnFailure: true,
      waitForCompletion: false,
      workingDir: SANDBOX_WORKSPACE_DIRECTORY,
    });
  } catch (error) {
    if (!isProcessAlreadyRunningError(error, DESKTOP_RUNTIME_PROCESS_NAME)) {
      throw error;
    }
  }

  console.info("[sandboxes] waiting for desktop health");
  await waitForDesktopHealth(sandbox, options);
  console.info("[sandboxes] desktop runtime healthy");
};

const runDesktopSandboxCommand = async (
  sandbox: SandboxHandle,
  command: string,
  options?: {
    readonly env?: Record<string, string>;
    readonly timeoutSeconds?: number;
  },
): Promise<SandboxProcessResult> => {
  const name = `godtool-computer-use-${crypto.randomUUID()}`;
  const result = await sandbox.process.exec({
    command,
    env: {
      ...buildDesktopCommandEnvironment(),
      ...(options?.env ?? {}),
    },
    name,
    restartOnFailure: false,
    timeout: Math.max(1, Math.floor(options?.timeoutSeconds ?? 30)),
    waitForCompletion: true,
    workingDir: SANDBOX_WORKSPACE_DIRECTORY,
  });
  return normalizeProcessResult(result, name, command);
};

const runSandboxCommand = async (
  sandbox: SandboxHandle,
  command: string,
  options?: {
    readonly env?: Record<string, string>;
    readonly timeoutSeconds?: number;
  },
): Promise<SandboxProcessResult> => {
  const name = `godtool-sandbox-command-${crypto.randomUUID()}`;
  const result = await sandbox.process.exec({
    command,
    env: options?.env,
    name,
    restartOnFailure: false,
    timeout: Math.max(1, Math.floor(options?.timeoutSeconds ?? 30)),
    waitForCompletion: true,
    workingDir: SANDBOX_WORKSPACE_DIRECTORY,
  });
  return normalizeProcessResult(result, name, command);
};

const createDesktopSession = async (
  sandbox: SandboxHandle,
  ensuredSandbox: EnsuredSandbox,
): Promise<DesktopSession> => {
  console.info("[sandboxes] creating desktop preview", {
    sandboxId: ensuredSandbox.externalId,
  });
  const preview = await ensureSandboxPreview(
    sandbox,
    {
      metadata: {
        name: DESKTOP_PREVIEW_NAME,
      },
      spec: {
        port: DESKTOP_PORT,
        public: true,
      },
    },
    "Blaxel desktop preview createIfNotExists",
  );
  const previewUrl = preview.spec.url?.trim();

  if (!previewUrl) {
    throw new Error("Blaxel preview URL is missing for desktop.");
  }

  const url = new URL("/vnc.html", previewUrl);
  url.searchParams.set("autoconnect", "1");
  url.searchParams.set("path", "websockify");
  url.searchParams.set("resize", "scale");
  url.searchParams.set("_t", Date.now().toString());

  const expiresAt = new Date(Date.now() + DESKTOP_TOKEN_TTL_MS);

  return {
    expiresAt: expiresAt.toISOString(),
    sandboxId: ensuredSandbox.externalId,
    sandboxStatus: ensuredSandbox.status,
    url: url.toString(),
  };
};

const ensureExecuteRuntimeStarted = async (
  sandbox: SandboxHandle,
  forceRestart: boolean,
  options?: SandboxesServiceOptions,
): Promise<{
  readonly healthStatus: number;
  readonly runtimeStatus: "started" | "reused";
}> => {
  const health = await fetchExecuteRuntimeHealth(sandbox);
  if (health.ok && !forceRestart) {
    return {
      healthStatus: health.status,
      runtimeStatus: "reused",
    };
  }

  await stopExecuteRuntimeProcess(sandbox);

  try {
    await sandbox.process.exec({
      command: [
        "bun",
        quoteShellArgument(EXECUTE_RUNTIME_SERVER_PATH),
        "--host",
        quoteShellArgument("0.0.0.0"),
        "--port",
        String(EXECUTE_RUNTIME_PORT),
      ].join(" "),
      maxRestarts: 5,
      name: EXECUTE_RUNTIME_PROCESS_NAME,
      restartOnFailure: true,
      waitForCompletion: false,
      workingDir: SANDBOX_WORKSPACE_DIRECTORY,
    });
  } catch (error) {
    if (!isProcessAlreadyRunningError(error, EXECUTE_RUNTIME_PROCESS_NAME)) {
      throw error;
    }
  }

  const ready = await waitForExecuteRuntimeHealth(sandbox, options);
  return {
    healthStatus: ready.status,
    runtimeStatus: "started",
  };
};

export const makeSandboxesService = (
  db: DrizzleDb,
  provider: SandboxProvider = makeBlaxelSandboxProvider(),
  sandboxHandleProvider: SandboxHandleProvider = makeBlaxelSandboxHandleProvider(),
  options?: SandboxesServiceOptions,
) => {
  const store = makeSandboxStore(db);
  const runtimeOptions: SandboxesServiceOptions = {
    codeServerStartPollMs: options?.codeServerStartPollMs ?? CODE_SERVER_START_POLL_MS,
    codeServerStartTimeoutMs: options?.codeServerStartTimeoutMs ?? CODE_SERVER_START_TIMEOUT_MS,
    desktopStartPollMs: options?.desktopStartPollMs ?? DESKTOP_START_POLL_MS,
    desktopStartTimeoutMs: options?.desktopStartTimeoutMs ?? DESKTOP_START_TIMEOUT_MS,
    executeRuntimeStartPollMs: options?.executeRuntimeStartPollMs ?? EXECUTE_RUNTIME_START_POLL_MS,
    executeRuntimeStartTimeoutMs:
      options?.executeRuntimeStartTimeoutMs ?? EXECUTE_RUNTIME_START_TIMEOUT_MS,
  };

  const ensureProvisioned = async (
    record: SandboxRecord,
    allowUnavailableRecovery = true,
  ): Promise<EnsuredSandbox> => {
    const allowRetryFromError =
      record.status === "error" &&
      (isRetryableSandboxError(record.error) ||
        isRetryableSandboxUnavailableError(record.error));

    if (record.status === "error" && !allowRetryFromError) {
      throw new Error(inferBrokenMessage(record.organizationId, record.error));
    }

    if (record.status === "ready") {
      if (!record.externalId) {
        const broken = await store.markError({
          error: `Sandbox row for organization "${record.organizationId}" is missing an external id.`,
          organizationId: record.organizationId,
        });
        throw new Error(inferBrokenMessage(record.organizationId, broken.error));
      }

      try {
        const awakened = await provider.wakeSandbox({
          externalId: record.externalId,
          organizationId: record.organizationId,
        });
        const ready = await store.markReady({
          externalId: awakened.externalId,
          organizationId: record.organizationId,
        });
        return {
          externalId: awakened.externalId,
          record: ready,
          sandboxName: awakened.sandboxName,
          status: awakened.status,
        };
      } catch (error) {
        if (allowUnavailableRecovery && isRetryableSandboxUnavailableError(error)) {
          const reset = await store.resetForReprovision(record.organizationId);
          return await ensureProvisioned(reset, false);
        }
        return await throwSandboxFailure(store, record.organizationId, error);
      }
    }

    try {
      const created = record.externalId
        ? await provider.wakeSandbox({
            externalId: record.externalId,
            organizationId: record.organizationId,
          })
        : await provider.createOrGetSandbox({
            organizationId: record.organizationId,
          });
      const ready = await store.markReady({
        externalId: created.externalId,
        organizationId: record.organizationId,
      });
      return {
        externalId: created.externalId,
        record: ready,
        sandboxName: created.sandboxName,
        status: created.status,
      };
    } catch (error) {
      if (
        allowUnavailableRecovery &&
        record.externalId &&
        isRetryableSandboxUnavailableError(error)
      ) {
        const reset = await store.resetForReprovision(record.organizationId);
        return await ensureProvisioned(reset, false);
      }
      return await throwSandboxFailure(store, record.organizationId, error);
    }
  };

  const recoverUnavailableSandbox = async (organizationId: string) => {
    const reset = await store.resetForReprovision(organizationId);
    return await ensureProvisioned(reset, false);
  };

  const withUnavailableSandboxRecovery = async <A>(
    organizationId: string,
    ensuredSandbox: EnsuredSandbox,
    operation: (sandbox: EnsuredSandbox) => Promise<A>,
  ): Promise<A> => {
    try {
      return await operation(ensuredSandbox);
    } catch (error) {
      if (!isRetryableSandboxUnavailableError(error)) {
        return await throwSandboxFailure(store, organizationId, error);
      }

      const reprovisionedSandbox = await recoverUnavailableSandbox(organizationId);

      try {
        return await operation(reprovisionedSandbox);
      } catch (recoveryError) {
        return await throwSandboxFailure(store, organizationId, recoveryError);
      }
    }
  };

  const ensureSandbox = async (organizationId: string) => {
    console.info("[sandboxes] ensuring sandbox", { organizationId });
    const row =
      (await store.getByOrganizationId(organizationId)) ??
      (await store.createPending(organizationId));

    if (!row) {
      throw new Error(`Failed to create sandbox row for organization "${organizationId}".`);
    }

    const ensuredSandbox = await ensureProvisioned(row);

    return await withUnavailableSandboxRecovery(
      organizationId,
      ensuredSandbox,
      async (sandboxRef) => {
        const sandbox = await sandboxHandleProvider.getSandboxHandle(sandboxRef.externalId);
        await ensureWorkspaceScaffold(sandbox);
        console.info("[sandboxes] workspace scaffold ready", {
          organizationId,
          sandboxId: sandboxRef.externalId,
        });
        return sandboxRef;
      },
    );
  };

  const ensureCodeServerSession = async (organizationId: string): Promise<CodeServerSession> => {
    const ensuredSandbox = await ensureSandbox(organizationId);

    return await withUnavailableSandboxRecovery(
      organizationId,
      ensuredSandbox,
      async (sandboxRef) => {
        const sandbox = await sandboxHandleProvider.getSandboxHandle(sandboxRef.externalId);
        await ensureCodeServerRunning(sandbox, runtimeOptions);
        return await createCodeServerSession(sandbox, sandboxRef);
      },
    );
  };

  const ensureDesktopSession = async (organizationId: string): Promise<DesktopSession> => {
    console.info("[sandboxes] ensuring desktop session", { organizationId });
    const ensuredSandbox = await ensureSandbox(organizationId);

    return await withUnavailableSandboxRecovery(
      organizationId,
      ensuredSandbox,
      async (sandboxRef) => {
        const sandbox = await sandboxHandleProvider.getSandboxHandle(sandboxRef.externalId);
        console.info("[sandboxes] ensuring desktop runtime", {
          organizationId,
          sandboxId: sandboxRef.externalId,
        });
        await ensureDesktopRunning(sandbox, runtimeOptions);
        return await createDesktopSession(sandbox, sandboxRef);
      },
    );
  };

  const runDesktopCommand = async (
    organizationId: string,
    input: {
      readonly command: string;
      readonly env?: Record<string, string>;
      readonly timeoutSeconds?: number;
    },
  ): Promise<SandboxProcessResult> => {
    const ensuredSandbox = await ensureSandbox(organizationId);

    return await withUnavailableSandboxRecovery(
      organizationId,
      ensuredSandbox,
      async (sandboxRef) => {
        const sandbox = await sandboxHandleProvider.getSandboxHandle(sandboxRef.externalId);
        await ensureDesktopRunning(sandbox, runtimeOptions);
        return await runDesktopSandboxCommand(sandbox, input.command, {
          env: input.env,
          timeoutSeconds: input.timeoutSeconds,
        });
      },
    );
  };

  const runCommand = async (
    organizationId: string,
    input: {
      readonly command: string;
      readonly env?: Record<string, string>;
      readonly timeoutSeconds?: number;
    },
  ): Promise<SandboxProcessResult> => {
    const ensuredSandbox = await ensureSandbox(organizationId);

    return await withUnavailableSandboxRecovery(
      organizationId,
      ensuredSandbox,
      async (sandboxRef) => {
        const sandbox = await sandboxHandleProvider.getSandboxHandle(sandboxRef.externalId);
        return await runSandboxCommand(sandbox, input.command, {
          env: input.env,
          timeoutSeconds: input.timeoutSeconds,
        });
      },
    );
  };

  const ensureExecuteRuntimeRunning = async (
    organizationId: string,
  ): Promise<EnsuredExecuteRuntime> => {
    const ensuredSandbox = await ensureSandbox(organizationId);

    return await withUnavailableSandboxRecovery(
      organizationId,
      ensuredSandbox,
      async (sandboxRef) => {
        const sandbox = await sandboxHandleProvider.getSandboxHandle(sandboxRef.externalId);
        const install = await ensureExecuteRuntimeInstalled(sandbox);
        const runtimeState = await ensureExecuteRuntimeStarted(
          sandbox,
          !install.cacheHit,
          runtimeOptions,
        );
        return {
          health: {
            ok: true,
            status: runtimeState.healthStatus,
          },
          install,
          runtime: {
            status: runtimeState.runtimeStatus,
          },
          sandbox: sandboxRef,
        };
      },
    );
  };

  return {
    ensureCodeServerSession,
    ensureDesktopSession,
    ensureExecuteRuntimeRunning,
    ensureSandbox,
    getSandbox: (organizationId: string) => store.getByOrganizationId(organizationId),
    runCommand,
    runDesktopCommand,
  };
};

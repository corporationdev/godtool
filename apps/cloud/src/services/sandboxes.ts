import { createHash } from "node:crypto";

import { initialize, SandboxInstance } from "@blaxel/core";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { EXECUTE_RUNTIME_ASSETS } from "./execute-runtime.generated";
import { sandboxes } from "./schema";
import type { DrizzleDb } from "./db";

const DEFAULT_BLAXEL_MEMORY_MB = 4096;
const DEFAULT_BLAXEL_REGION = "us-pdx-1";
const BLAXEL_PROVIDER = "blaxel" as const;
const EXECUTE_RUNTIME_DIRECTORY = "/workspace/runtime/execute";
const EXECUTE_RUNTIME_SERVER_PATH = `${EXECUTE_RUNTIME_DIRECTORY}/server.js`;
const EXECUTE_RUNTIME_VERSION_PATH = `${EXECUTE_RUNTIME_DIRECTORY}/version.txt`;
const EXECUTE_RUNTIME_PROCESS_NAME = "godtool-execute-runtime";
const EXECUTE_RUNTIME_START_POLL_MS = 250;
const EXECUTE_RUNTIME_START_TIMEOUT_MS = 10_000;
const MAX_PROCESS_LOG_CHARS = 12_000;
const MAX_SANDBOX_NAME_LENGTH = 49;
const SANDBOX_NAME_HASH_LENGTH = 8;
const SANDBOX_NAME_PREFIX = "godtool-org";
const WORKSPACE_RUNTIME_DIRECTORY = "/workspace/runtime";

export const EXECUTE_RUNTIME_PORT = 4789;
export const EXECUTE_RUNTIME_PROCESS_NAME_FOR_TESTS = EXECUTE_RUNTIME_PROCESS_NAME;
export const EXECUTE_RUNTIME_SERVER_PATH_FOR_TESTS = EXECUTE_RUNTIME_SERVER_PATH;
export const EXECUTE_RUNTIME_VERSION_PATH_FOR_TESTS = EXECUTE_RUNTIME_VERSION_PATH;

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

export interface SandboxProvider {
  readonly createOrGetSandbox: (args: {
    readonly organizationId: string;
  }) => Promise<{
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
  readonly maxRestarts?: number;
  readonly name: string;
  readonly restartOnFailure?: boolean;
  readonly waitForCompletion?: boolean;
  readonly workingDir?: string;
}

export interface SandboxResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text?: () => Promise<string>;
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
  readonly fs: {
    readonly mkdir: (path: string) => Promise<unknown>;
    readonly read: (path: string) => Promise<string>;
    readonly write: (path: string, content: string) => Promise<unknown>;
  };
  readonly process: {
    readonly exec: (options: SandboxProcessExecOptions) => Promise<unknown>;
    readonly kill: (name: string) => Promise<unknown>;
    readonly logs: (name: string, scope: "all") => Promise<string>;
    readonly stop: (name: string) => Promise<unknown>;
  };
}

export interface SandboxHandleProvider {
  readonly getSandboxHandle: (externalId: string) => Promise<SandboxHandle>;
}

export interface SandboxesServiceOptions {
  readonly executeRuntimeStartPollMs?: number;
  readonly executeRuntimeStartTimeoutMs?: number;
}

const getRequiredBlaxelConfig = () => {
  const apiKey = env.BLAXEL_API_KEY?.trim();
  const workspace = env.BLAXEL_WORKSPACE?.trim();
  const templateImage = env.BLAXEL_TEMPLATE_IMAGE?.trim();

  if (!apiKey) {
    throw new Error("Missing BLAXEL_API_KEY");
  }

  if (!workspace) {
    throw new Error("Missing BLAXEL_WORKSPACE");
  }

  if (!templateImage) {
    throw new Error("Missing BLAXEL_TEMPLATE_IMAGE");
  }

  return {
    apiKey,
    memoryMb: DEFAULT_BLAXEL_MEMORY_MB,
    region: env.BLAXEL_REGION?.trim() || DEFAULT_BLAXEL_REGION,
    templateImage,
    workspace,
  };
};

let initializedKey: string | null = null;

const configureBlaxel = () => {
  const config = getRequiredBlaxelConfig();
  const nextKey = `${config.workspace}:${config.region}:${config.templateImage}`;

  if (initializedKey !== nextKey) {
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

const resolveSandboxExternalId = async (sandbox: Awaited<ReturnType<typeof SandboxInstance.get>>) => {
  await sandbox.wait();
  const externalId = sandbox.metadata.name?.trim();

  if (!externalId) {
    throw new Error("Blaxel sandbox is missing a stable name.");
  }

  return externalId;
};

export const makeBlaxelSandboxProvider = (): SandboxProvider => ({
  createOrGetSandbox: async ({ organizationId }) => {
    const config = configureBlaxel();
    const sandboxName = getSandboxNameForOrganization(organizationId);
    const sandbox = await SandboxInstance.createIfNotExists({
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
      ],
      region: config.region,
    });

    return {
      externalId: await resolveSandboxExternalId(sandbox),
      sandboxName,
      status: "created",
    };
  },

  wakeSandbox: async ({ externalId, organizationId }) => {
    configureBlaxel();
    const sandbox = await SandboxInstance.get(externalId);

    return {
      externalId: await resolveSandboxExternalId(sandbox),
      sandboxName: getSandboxNameForOrganization(organizationId),
      status: "reused",
    };
  },
});

export const makeBlaxelSandboxHandleProvider = (): SandboxHandleProvider => ({
  getSandboxHandle: async (externalId) => {
    configureBlaxel();
    const sandbox = await SandboxInstance.get(externalId);
    await sandbox.wait();
    return sandbox as unknown as SandboxHandle;
  },
});

const inferBrokenMessage = (organizationId: string, error: string | null | undefined) =>
  error?.trim().length
    ? error
    : `Sandbox for organization "${organizationId}" is marked broken.`;

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
    const code =
      "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
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

const quoteShellArgument = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const ensureDirectoryExists = async (sandbox: SandboxHandle, path: string) => {
  try {
    await sandbox.fs.mkdir(path);
  } catch {
    // Directory already exists.
  }
};

export const makeSandboxStore = (db: DrizzleDb) => {
  const getByOrganizationId = async (organizationId: string) => {
    const rows = await db.select().from(sandboxes).where(eq(sandboxes.organizationId, organizationId));
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

  const markError = async (args: {
    readonly error: string;
    readonly organizationId: string;
  }) => {
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

  return {
    createPending,
    getByOrganizationId,
    markError,
    markReady,
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

  await ensureDirectoryExists(sandbox, WORKSPACE_RUNTIME_DIRECTORY);
  await ensureDirectoryExists(sandbox, EXECUTE_RUNTIME_DIRECTORY);
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

  const processLogs = await sandbox.process.logs(EXECUTE_RUNTIME_PROCESS_NAME, "all").catch(() => "");
  throw new Error(
    processLogs.trim().length > 0
      ? `Timed out waiting for execute runtime to become healthy.\n${truncateOutput(processLogs.trim(), MAX_PROCESS_LOG_CHARS)}`
      : "Timed out waiting for execute runtime to become healthy.",
  );
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
    workingDir: "/workspace",
  });

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
    executeRuntimeStartPollMs:
      options?.executeRuntimeStartPollMs ?? EXECUTE_RUNTIME_START_POLL_MS,
    executeRuntimeStartTimeoutMs:
      options?.executeRuntimeStartTimeoutMs ?? EXECUTE_RUNTIME_START_TIMEOUT_MS,
  };

  const ensureProvisioned = async (
    record: SandboxRecord,
  ): Promise<EnsuredSandbox> => {
    if (record.status === "error") {
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
        const broken = await store.markError({
          error: renderUnknownError(error),
          organizationId: record.organizationId,
        });
        throw new Error(inferBrokenMessage(record.organizationId, broken.error));
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
      const broken = await store.markError({
        error: renderUnknownError(error),
        organizationId: record.organizationId,
      });
      throw new Error(inferBrokenMessage(record.organizationId, broken.error));
    }
  };

  const ensureSandbox = async (organizationId: string) => {
    const row =
      (await store.getByOrganizationId(organizationId)) ??
      (await store.createPending(organizationId));

    if (!row) {
      throw new Error(`Failed to create sandbox row for organization "${organizationId}".`);
    }

    return await ensureProvisioned(row);
  };

  const ensureExecuteRuntimeRunning = async (
    organizationId: string,
  ): Promise<EnsuredExecuteRuntime> => {
    const ensuredSandbox = await ensureSandbox(organizationId);

    try {
      const sandbox = await sandboxHandleProvider.getSandboxHandle(ensuredSandbox.externalId);
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
        sandbox: ensuredSandbox,
      };
    } catch (error) {
      const broken = await store.markError({
        error: renderUnknownError(error),
        organizationId,
      });
      throw new Error(inferBrokenMessage(organizationId, broken.error));
    }
  };

  return {
    ensureExecuteRuntimeRunning,
    ensureSandbox,
    getSandbox: (organizationId: string) => store.getByOrganizationId(organizationId),
  };
};

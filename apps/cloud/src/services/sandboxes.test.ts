import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { DbService } from "./db";
import {
  CODE_SERVER_CONFIG_PATH_FOR_TESTS,
  CODE_SERVER_PROCESS_NAME_FOR_TESTS,
  DESKTOP_RUNTIME_PROCESS_NAME_FOR_TESTS,
  DESKTOP_RUNTIME_SCRIPT_PATH_FOR_TESTS,
  DESKTOP_RUNTIME_VERSION_PATH_FOR_TESTS,
  EXECUTE_RUNTIME_PROCESS_NAME_FOR_TESTS,
  EXECUTE_RUNTIME_SERVER_PATH_FOR_TESTS,
  EXECUTE_RUNTIME_VERSION_PATH_FOR_TESTS,
  getExecuteRuntimeVersion,
  getSandboxNameForOrganization,
  makeSandboxesService,
  type SandboxHandle,
  type SandboxHandleProvider,
  type SandboxProvider,
} from "./sandboxes";
import { makeUserStore } from "./user-store";

const program = <A, E>(body: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(
    body.pipe(Effect.provide(DbService.Live), Effect.scoped) as Effect.Effect<A, E, never>,
  );

class FakeSandboxHandle implements SandboxHandle {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  lastCodeServerExecCommand: string | null = null;
  lastDesktopExecCommand: string | null = null;
  lastExecuteExecCommand: string | null = null;
  lastCodeServerWorkingDir: string | null = null;
  lastDesktopWorkingDir: string | null = null;
  lastExecuteWorkingDir: string | null = null;
  codeServerConfigWrites = 0;
  codeServerExecCalls = 0;
  codeServerHealthChecks = 0;
  codeServerKillCalls = 0;
  codeServerLogsText = "";
  codeServerStopCalls = 0;
  desktopExecCalls = 0;
  desktopHealthChecks = 0;
  desktopKillCalls = 0;
  desktopLogsText = "";
  desktopScriptWrites = 0;
  desktopStopCalls = 0;
  desktopVersionWrites = 0;
  executeExecCalls = 0;
  executeHealthChecks = 0;
  executeKillCalls = 0;
  executeLogsText = "";
  executeStopCalls = 0;
  lastPreviewName: string | null = null;
  lastPreviewPort: number | null = null;
  lastPreviewPublic: boolean | null = null;
  previewCreates = 0;
  previewTokenCreates = 0;
  previewUrl = "https://preview.example.com";
  serverWrites = 0;
  versionWrites = 0;
  codeServerHealthy = false;
  desktopHealthy = false;
  executeHealthy = false;
  onCodeServerExec?: () => Promise<void> | void;
  onDesktopExec?: () => Promise<void> | void;
  onExecuteExec?: () => Promise<void> | void;

  readonly fs = {
    mkdir: async (path: string) => {
      this.directories.add(path);
    },
    read: async (path: string) => {
      const value = this.files.get(path);
      if (value === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return value;
    },
    write: async (path: string, content: string) => {
      this.files.set(path, content);
      if (path === EXECUTE_RUNTIME_SERVER_PATH_FOR_TESTS) {
        this.serverWrites += 1;
      }
      if (path === EXECUTE_RUNTIME_VERSION_PATH_FOR_TESTS) {
        this.versionWrites += 1;
      }
      if (path === CODE_SERVER_CONFIG_PATH_FOR_TESTS) {
        this.codeServerConfigWrites += 1;
      }
      if (path === DESKTOP_RUNTIME_SCRIPT_PATH_FOR_TESTS) {
        this.desktopScriptWrites += 1;
      }
      if (path === DESKTOP_RUNTIME_VERSION_PATH_FOR_TESTS) {
        this.desktopVersionWrites += 1;
      }
    },
  };

  readonly previews = {
    createIfNotExists: async (args: {
      readonly metadata: { readonly name: string };
      readonly spec: { readonly port: number; readonly public: boolean };
    }) => {
      this.previewCreates += 1;
      this.lastPreviewName = args.metadata.name;
      this.lastPreviewPort = args.spec.port;
      this.lastPreviewPublic = args.spec.public;
      return {
        spec: {
          url: this.previewUrl,
        },
        tokens: {
          create: async (expiresAt: Date) => {
            this.previewTokenCreates += 1;
            return {
              expiresAt,
              value: `token-${this.previewTokenCreates}`,
            };
          },
        },
      };
    },
  };

  readonly process = {
    exec: async (options: {
      readonly command: string;
      readonly name: string;
      readonly workingDir?: string;
    }) => {
      if (options.name === EXECUTE_RUNTIME_PROCESS_NAME_FOR_TESTS) {
        this.executeExecCalls += 1;
        this.lastExecuteExecCommand = options.command;
        this.lastExecuteWorkingDir = options.workingDir ?? null;
        await this.onExecuteExec?.();
        return;
      }

      if (options.name === CODE_SERVER_PROCESS_NAME_FOR_TESTS) {
        this.codeServerExecCalls += 1;
        this.lastCodeServerExecCommand = options.command;
        this.lastCodeServerWorkingDir = options.workingDir ?? null;
        await this.onCodeServerExec?.();
        return;
      }

      if (options.name === DESKTOP_RUNTIME_PROCESS_NAME_FOR_TESTS) {
        this.desktopExecCalls += 1;
        this.lastDesktopExecCommand = options.command;
        this.lastDesktopWorkingDir = options.workingDir ?? null;
        await this.onDesktopExec?.();
        return;
      }

      throw new Error(`Unexpected process.exec(${options.name})`);
    },
    kill: async (name: string) => {
      if (name === EXECUTE_RUNTIME_PROCESS_NAME_FOR_TESTS) {
        this.executeKillCalls += 1;
        return;
      }

      if (name === CODE_SERVER_PROCESS_NAME_FOR_TESTS) {
        this.codeServerKillCalls += 1;
        return;
      }

      if (name === DESKTOP_RUNTIME_PROCESS_NAME_FOR_TESTS) {
        this.desktopKillCalls += 1;
        return;
      }

      throw new Error(`Unexpected process.kill(${name})`);
    },
    logs: async (name: string) => {
      if (name === EXECUTE_RUNTIME_PROCESS_NAME_FOR_TESTS) {
        return this.executeLogsText;
      }

      if (name === CODE_SERVER_PROCESS_NAME_FOR_TESTS) {
        return this.codeServerLogsText;
      }

      if (name === DESKTOP_RUNTIME_PROCESS_NAME_FOR_TESTS) {
        return this.desktopLogsText;
      }

      throw new Error(`Unexpected process.logs(${name})`);
    },
    stop: async (name: string) => {
      if (name === EXECUTE_RUNTIME_PROCESS_NAME_FOR_TESTS) {
        this.executeStopCalls += 1;
        return;
      }

      if (name === CODE_SERVER_PROCESS_NAME_FOR_TESTS) {
        this.codeServerStopCalls += 1;
        return;
      }

      if (name === DESKTOP_RUNTIME_PROCESS_NAME_FOR_TESTS) {
        this.desktopStopCalls += 1;
        return;
      }

      throw new Error(`Unexpected process.stop(${name})`);
    },
  };

  readonly fetch = async (port: number, path: string) => {
    if (port === 4789 && path === "/health") {
      this.executeHealthChecks += 1;
      return this.executeHealthy ? { ok: true, status: 200 } : { ok: false, status: 503 };
    }

    if (port === 8081 && path === "/healthz") {
      this.codeServerHealthChecks += 1;
      return this.codeServerHealthy ? { ok: true, status: 200 } : { ok: false, status: 503 };
    }

    if (port === 6080 && path === "/vnc.html") {
      this.desktopHealthChecks += 1;
      return this.desktopHealthy ? { ok: true, status: 200 } : { ok: false, status: 503 };
    }

    throw new Error(`Unexpected fetch(${port}, ${path})`);
  };
}

const makeProvider = (calls: { create: number; wake: number }): SandboxProvider => ({
  createOrGetSandbox: async ({ organizationId }) => {
    calls.create += 1;
    return {
      externalId: `sbx_${organizationId}`,
      sandboxName: getSandboxNameForOrganization(organizationId),
      status: "created",
    };
  },
  wakeSandbox: async ({ externalId, organizationId }) => {
    calls.wake += 1;
    return {
      externalId,
      sandboxName: getSandboxNameForOrganization(organizationId),
      status: "reused",
    };
  },
});

const makeHandleProvider = (
  handle: FakeSandboxHandle,
  calls: { getHandle: number },
): SandboxHandleProvider => ({
  getSandboxHandle: async () => {
    calls.getHandle += 1;
    return handle;
  },
});

describe("sandboxes service", () => {
  it("builds a blaxel-safe sandbox name from the organization id", () => {
    const sandboxName = getSandboxNameForOrganization("Org_ID.With Weird__Chars");
    const longSandboxName = getSandboxNameForOrganization(
      "ORG_WITH_A_VERY_LONG_IDENTIFIER_THAT_SHOULD_BE_TRUNCATED_SAFELY_1234567890",
    );

    expect(sandboxName).toMatch(/^godtool-org-[a-z0-9-]+-[a-f0-9]{8}$/);
    expect(sandboxName.length).toBeLessThanOrEqual(49);
    expect(sandboxName).not.toContain("_");
    expect(sandboxName).not.toContain(".");
    expect(sandboxName).toBe(getSandboxNameForOrganization("Org_ID.With Weird__Chars"));
    expect(sandboxName).not.toBe(getSandboxNameForOrganization("org-id-with-weird-chars"));
    expect(longSandboxName.length).toBeLessThanOrEqual(49);
  });

  it("creates the sandbox, installs runtime assets, and starts the execute server", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onExecuteExec = () => {
      handle.executeHealthy = true;
    };

    const ensured = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Acme" }),
        );
        return yield* Effect.promise(() =>
          makeSandboxesService(
            db,
            makeProvider(providerCalls),
            makeHandleProvider(handle, handleCalls),
          ).ensureExecuteRuntimeRunning(orgId),
        );
      }),
    );

    expect(providerCalls).toEqual({ create: 1, wake: 0 });
    expect(handleCalls).toEqual({ getHandle: 2 });
    expect(ensured.sandbox.status).toBe("created");
    expect(ensured.install.cacheHit).toBe(false);
    expect(ensured.runtime.status).toBe("started");
    expect(ensured.health).toEqual({ ok: true, status: 200 });
    expect(handle.executeExecCalls).toBe(1);
    expect(handle.lastExecuteExecCommand).toContain("'/root/.godtool/runtime/execute/server.js'");
    expect(handle.lastExecuteExecCommand).not.toContain("/workspace/runtime");
    expect(handle.lastExecuteWorkingDir).toBe("/workspace");
    expect(handle.serverWrites).toBe(1);
    expect(handle.versionWrites).toBe(1);
    expect(handle.files.get(EXECUTE_RUNTIME_VERSION_PATH_FOR_TESTS)).toBe(
      getExecuteRuntimeVersion(),
    );
    expect(handle.files.get("/workspace/SYSTEM.md")).toContain("# System");
    expect(handle.files.get("/workspace/MEMORY.md")?.trim()).toBe("");
  });

  it("backfills missing scaffold files for reused sandboxes without overwriting existing ones", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.files.set("/workspace/MEMORY.md", "existing memory");

    await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Backfill" }),
        );
        const service = makeSandboxesService(
          db,
          makeProvider(providerCalls),
          makeHandleProvider(handle, handleCalls),
        );
        yield* Effect.promise(() => service.ensureSandbox(orgId));
        yield* Effect.promise(() => service.ensureSandbox(orgId));
      }),
    );

    expect(providerCalls).toEqual({ create: 1, wake: 1 });
    expect(handleCalls).toEqual({ getHandle: 2 });
    expect(handle.files.get("/workspace/SYSTEM.md")).toContain("# System");
    expect(handle.files.get("/workspace/MEMORY.md")).toBe("existing memory");
  });

  it("reuses a healthy runtime without reinstalling or restarting it", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onExecuteExec = () => {
      handle.executeHealthy = true;
    };

    const ensured = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Reuse" }),
        );
        const service = makeSandboxesService(
          db,
          makeProvider(providerCalls),
          makeHandleProvider(handle, handleCalls),
        );
        yield* Effect.promise(() => service.ensureExecuteRuntimeRunning(orgId));
        return yield* Effect.promise(() => service.ensureExecuteRuntimeRunning(orgId));
      }),
    );

    expect(providerCalls).toEqual({ create: 1, wake: 1 });
    expect(handleCalls).toEqual({ getHandle: 4 });
    expect(ensured.sandbox.status).toBe("reused");
    expect(ensured.install.cacheHit).toBe(true);
    expect(ensured.runtime.status).toBe("reused");
    expect(handle.executeExecCalls).toBe(1);
    expect(handle.serverWrites).toBe(1);
    expect(handle.versionWrites).toBe(1);
  });

  it("reinstalls assets when the runtime version changes before restarting", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onExecuteExec = () => {
      handle.executeHealthy = true;
    };

    const ensured = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Upgrade" }),
        );
        const service = makeSandboxesService(
          db,
          makeProvider(providerCalls),
          makeHandleProvider(handle, handleCalls),
        );
        yield* Effect.promise(() => service.ensureExecuteRuntimeRunning(orgId));
        handle.executeHealthy = false;
        handle.files.set(EXECUTE_RUNTIME_VERSION_PATH_FOR_TESTS, "old-runtime-version");
        return yield* Effect.promise(() => service.ensureExecuteRuntimeRunning(orgId));
      }),
    );

    expect(providerCalls).toEqual({ create: 1, wake: 1 });
    expect(handleCalls).toEqual({ getHandle: 4 });
    expect(ensured.install.cacheHit).toBe(false);
    expect(ensured.runtime.status).toBe("started");
    expect(handle.executeExecCalls).toBe(2);
    expect(handle.serverWrites).toBe(2);
    expect(handle.versionWrites).toBe(2);
  });

  it("restarts a healthy runtime when the installed version changes", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onExecuteExec = () => {
      handle.executeHealthy = true;
    };

    const ensured = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "UpgradeHealthy" }),
        );
        const service = makeSandboxesService(
          db,
          makeProvider(providerCalls),
          makeHandleProvider(handle, handleCalls),
        );
        yield* Effect.promise(() => service.ensureExecuteRuntimeRunning(orgId));
        handle.files.set(EXECUTE_RUNTIME_VERSION_PATH_FOR_TESTS, "old-runtime-version");
        return yield* Effect.promise(() => service.ensureExecuteRuntimeRunning(orgId));
      }),
    );

    expect(providerCalls).toEqual({ create: 1, wake: 1 });
    expect(handleCalls).toEqual({ getHandle: 4 });
    expect(ensured.install.cacheHit).toBe(false);
    expect(ensured.runtime.status).toBe("started");
    expect(handle.executeExecCalls).toBe(2);
    expect(handle.executeStopCalls).toBe(2);
    expect(handle.serverWrites).toBe(2);
    expect(handle.versionWrites).toBe(2);
  });

  it("marks the sandbox broken if the runtime never becomes healthy", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.executeLogsText = "boot failed forever";

    const result = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "BrokenStart" }),
        );
        const service = makeSandboxesService(
          db,
          makeProvider(providerCalls),
          makeHandleProvider(handle, handleCalls),
          {
            executeRuntimeStartPollMs: 0,
            executeRuntimeStartTimeoutMs: 1,
          },
        );
        const ensured = yield* Effect.promise(async () => {
          try {
            await service.ensureExecuteRuntimeRunning(orgId);
            return null;
          } catch (error) {
            return error;
          }
        });
        const row = yield* Effect.promise(() => service.getSandbox(orgId));
        return { ensured, row };
      }),
    );

    expect(providerCalls).toEqual({ create: 1, wake: 0 });
    expect(handleCalls).toEqual({ getHandle: 2 });
    expect(String(result.ensured)).toContain("boot failed forever");
    expect(result.row?.status).toBe("error");
    expect(result.row?.error).toContain("boot failed forever");
  });

  it("does not poison the sandbox row on retryable execute-runtime failures", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();

    let attempts = 0;
    handle.onExecuteExec = () => {
      attempts += 1;
      if (attempts === 1) {
        throw {
          code: "WORKLOAD_UNAVAILABLE",
          message: "runtime is warming up",
          retryable: true,
        };
      }
      handle.executeHealthy = true;
    };

    const result = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Retryable" }),
        );
        const service = makeSandboxesService(
          db,
          makeProvider(providerCalls),
          makeHandleProvider(handle, handleCalls),
        );
        const firstError = yield* Effect.promise(async () => {
          try {
            await service.ensureExecuteRuntimeRunning(orgId);
            return null;
          } catch (error) {
            return error;
          }
        });
        const rowAfterFirstAttempt = yield* Effect.promise(() => service.getSandbox(orgId));
        const recovered = yield* Effect.promise(() => service.ensureExecuteRuntimeRunning(orgId));
        const rowAfterRecovery = yield* Effect.promise(() => service.getSandbox(orgId));
        return { firstError, recovered, rowAfterFirstAttempt, rowAfterRecovery };
      }),
    );

    expect(String(result.firstError)).toContain("runtime is warming up");
    expect(result.rowAfterFirstAttempt?.status).toBe("ready");
    expect(result.rowAfterFirstAttempt?.error).toBeNull();
    expect(result.recovered.runtime.status).toBe("started");
    expect(result.rowAfterRecovery?.status).toBe("ready");
    expect(result.rowAfterRecovery?.error).toBeNull();
    expect(providerCalls).toEqual({ create: 1, wake: 1 });
    expect(handleCalls).toEqual({ getHandle: 4 });
  });

  it("reprovisions a newly created sandbox when its handle is unavailable", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const unavailableId = `sbx_unavailable_${orgId}`;
    const recoveredId = `sbx_recovered_${orgId}`;
    let createCalls = 0;
    const handleCalls: string[] = [];
    const recoveredHandle = new FakeSandboxHandle();
    recoveredHandle.onCodeServerExec = () => {
      recoveredHandle.codeServerHealthy = true;
    };

    const result = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "UnavailableHandle" }),
        );
        const service = makeSandboxesService(
          db,
          {
            createOrGetSandbox: async ({ organizationId }) => {
              createCalls += 1;
              return {
                externalId: createCalls === 1 ? unavailableId : recoveredId,
                sandboxName: getSandboxNameForOrganization(organizationId),
                status: "created",
              };
            },
            wakeSandbox: async () => {
              throw new Error("unexpected wake");
            },
          },
          {
            getSandboxHandle: async (externalId) => {
              handleCalls.push(externalId);
              if (externalId === unavailableId) {
                throw {
                  code: "WORKLOAD_UNAVAILABLE",
                  message: `Resource '${externalId}' is currently not available. Please verify it exists and is running.`,
                  retryable: true,
                  status: 404,
                };
              }
              return recoveredHandle;
            },
          },
        );
        const session = yield* Effect.promise(() => service.ensureCodeServerSession(orgId));
        const row = yield* Effect.promise(() => service.getSandbox(orgId));
        return { row, session };
      }),
    );

    expect(createCalls).toBe(2);
    expect(handleCalls).toEqual([unavailableId, recoveredId, recoveredId]);
    expect(result.session.sandboxId).toBe(recoveredId);
    expect(result.session.sandboxStatus).toBe("created");
    expect(result.row?.externalId).toBe(recoveredId);
    expect(result.row?.status).toBe("ready");
    expect(result.row?.error).toBeNull();
  });

  it("reprovisions a stored sandbox when waking it returns unavailable", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const initialId = `sbx_initial_${orgId}`;
    const recoveredId = `sbx_recovered_${orgId}`;
    let createCalls = 0;
    let wakeCalls = 0;
    const initialHandle = new FakeSandboxHandle();
    initialHandle.onCodeServerExec = () => {
      initialHandle.codeServerHealthy = true;
    };
    const recoveredHandle = new FakeSandboxHandle();
    recoveredHandle.onCodeServerExec = () => {
      recoveredHandle.codeServerHealthy = true;
    };

    const result = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "UnavailableWake" }),
        );
        const service = makeSandboxesService(
          db,
          {
            createOrGetSandbox: async ({ organizationId }) => {
              createCalls += 1;
              return {
                externalId: createCalls === 1 ? initialId : recoveredId,
                sandboxName: getSandboxNameForOrganization(organizationId),
                status: "created",
              };
            },
            wakeSandbox: async ({ externalId }) => {
              wakeCalls += 1;
              if (externalId === initialId) {
                throw {
                  code: "WORKLOAD_UNAVAILABLE",
                  message: `Resource '${externalId}' is currently not available. Please verify it exists and is running.`,
                  retryable: true,
                  status: 404,
                };
              }
              return {
                externalId,
                sandboxName: getSandboxNameForOrganization(orgId),
                status: "reused" as const,
              };
            },
          },
          {
            getSandboxHandle: async (externalId) =>
              externalId === initialId ? initialHandle : recoveredHandle,
          },
        );
        const firstSession = yield* Effect.promise(() => service.ensureCodeServerSession(orgId));
        const secondSession = yield* Effect.promise(() => service.ensureCodeServerSession(orgId));
        const row = yield* Effect.promise(() => service.getSandbox(orgId));
        return { firstSession, row, secondSession };
      }),
    );

    expect(createCalls).toBe(2);
    expect(wakeCalls).toBe(1);
    expect(result.firstSession.sandboxId).toBe(initialId);
    expect(result.secondSession.sandboxId).toBe(recoveredId);
    expect(result.secondSession.sandboxStatus).toBe("created");
    expect(result.row?.externalId).toBe(recoveredId);
    expect(result.row?.status).toBe("ready");
    expect(result.row?.error).toBeNull();
  });

  it("treats error rows as permanently broken for runtime ensures too", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onExecuteExec = () => {
      handle.executeHealthy = true;
    };

    const result = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Broken" }),
        );
        const service = makeSandboxesService(
          db,
          makeProvider(providerCalls),
          makeHandleProvider(handle, handleCalls),
        );
        yield* Effect.promise(() => service.ensureSandbox(orgId));
        yield* Effect.promise(() =>
          db.execute(
            `update sandboxes set status = 'error', error = 'sandbox is broken' where organization_id = '${orgId}'`,
          ),
        );
        return yield* Effect.promise(async () => {
          try {
            await service.ensureExecuteRuntimeRunning(orgId);
            return null;
          } catch (error) {
            return error;
          }
        });
      }),
    );

    expect(String(result)).toContain("sandbox is broken");
    expect(providerCalls).toEqual({ create: 1, wake: 0 });
    expect(handleCalls).toEqual({ getHandle: 1 });
  });

  it("recovers previously poisoned retryable error rows", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onExecuteExec = () => {
      handle.executeHealthy = true;
    };

    const result = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "RetryablePoisoned" }),
        );
        const service = makeSandboxesService(
          db,
          makeProvider(providerCalls),
          makeHandleProvider(handle, handleCalls),
        );
        yield* Effect.promise(() => service.ensureSandbox(orgId));
        yield* Effect.promise(() =>
          db.execute(
            `update sandboxes set status = 'error', error = 'sandbox warming up (WORKLOAD_UNAVAILABLE)' where organization_id = '${orgId}'`,
          ),
        );
        const recovered = yield* Effect.promise(() => service.ensureExecuteRuntimeRunning(orgId));
        const row = yield* Effect.promise(() => service.getSandbox(orgId));
        return { recovered, row };
      }),
    );

    expect(result.recovered.runtime.status).toBe("started");
    expect(result.row?.status).toBe("ready");
    expect(result.row?.error).toBeNull();
    expect(providerCalls).toEqual({ create: 1, wake: 1 });
    expect(handleCalls).toEqual({ getHandle: 3 });
  });

  it("starts code-server on demand and returns a tokenized preview url", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onCodeServerExec = () => {
      handle.codeServerHealthy = true;
    };

    const session = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Files" }),
        );
        return yield* Effect.promise(() =>
          makeSandboxesService(
            db,
            makeProvider(providerCalls),
            makeHandleProvider(handle, handleCalls),
          ).ensureCodeServerSession(orgId),
        );
      }),
    );

    expect(providerCalls).toEqual({ create: 1, wake: 0 });
    expect(handleCalls).toEqual({ getHandle: 2 });
    expect(handle.codeServerExecCalls).toBe(1);
    expect(handle.codeServerConfigWrites).toBe(1);
    expect(handle.previewCreates).toBe(1);
    expect(handle.previewTokenCreates).toBe(1);
    expect(handle.lastCodeServerExecCommand).toContain("'/workspace'");
    expect(handle.lastCodeServerWorkingDir).toBe("/workspace");
    expect(session.sandboxStatus).toBe("created");
    expect(session.sandboxId).toBe(`sbx_${orgId}`);
    expect(session.url).toContain("https://preview.example.com");
    expect(session.url).toContain("bl_preview_token=token-1");
  });

  it("reuses a healthy code-server and only mints a fresh preview token", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onCodeServerExec = () => {
      handle.codeServerHealthy = true;
    };

    const secondSession = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Files Reuse" }),
        );
        const service = makeSandboxesService(
          db,
          makeProvider(providerCalls),
          makeHandleProvider(handle, handleCalls),
        );
        yield* Effect.promise(() => service.ensureCodeServerSession(orgId));
        return yield* Effect.promise(() => service.ensureCodeServerSession(orgId));
      }),
    );

    expect(providerCalls).toEqual({ create: 1, wake: 1 });
    expect(handleCalls).toEqual({ getHandle: 4 });
    expect(handle.codeServerExecCalls).toBe(1);
    expect(handle.previewCreates).toBe(2);
    expect(handle.previewTokenCreates).toBe(2);
    expect(secondSession.sandboxStatus).toBe("reused");
    expect(secondSession.url).toContain("bl_preview_token=token-2");
  });

  it("returns a tokenized noVNC desktop session for a healthy sandbox desktop", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.desktopHealthy = true;

    const session = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Desktop" }),
        );
        return yield* Effect.promise(() =>
          makeSandboxesService(
            db,
            makeProvider(providerCalls),
            makeHandleProvider(handle, handleCalls),
          ).ensureDesktopSession(orgId),
        );
      }),
    );

    const url = new URL(session.url);

    expect(providerCalls).toEqual({ create: 1, wake: 0 });
    expect(handleCalls).toEqual({ getHandle: 2 });
    expect(handle.desktopExecCalls).toBe(1);
    expect(handle.desktopHealthChecks).toBe(2);
    expect(handle.desktopScriptWrites).toBe(1);
    expect(handle.desktopStopCalls).toBe(1);
    expect(handle.desktopVersionWrites).toBe(1);
    expect(handle.lastDesktopExecCommand).toContain("'/root/.godtool/runtime/desktop/start.sh'");
    expect(handle.lastDesktopWorkingDir).toBe("/workspace");
    expect(handle.previewCreates).toBe(1);
    expect(handle.previewTokenCreates).toBe(1);
    expect(handle.lastPreviewName).toBe("desktop-vnc");
    expect(handle.lastPreviewPort).toBe(6080);
    expect(handle.lastPreviewPublic).toBe(false);
    expect(session.sandboxStatus).toBe("created");
    expect(session.sandboxId).toBe(`sbx_${orgId}`);
    expect(url.origin).toBe("https://preview.example.com");
    expect(url.pathname).toBe("/vnc.html");
    expect(url.searchParams.get("autoconnect")).toBe("1");
    expect(url.searchParams.get("resize")).toBe("scale");
    expect(url.searchParams.get("bl_preview_token")).toBe("token-1");
    expect(url.searchParams.get("path")).toBe("websockify?bl_preview_token=token-1");
  });

  it("marks the sandbox broken when the desktop stream never becomes healthy", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();

    const result = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Broken Desktop" }),
        );
        const service = makeSandboxesService(
          db,
          makeProvider(providerCalls),
          makeHandleProvider(handle, handleCalls),
          {
            desktopStartPollMs: 0,
            desktopStartTimeoutMs: 1,
          },
        );
        const sessionError = yield* Effect.promise(async () => {
          try {
            await service.ensureDesktopSession(orgId);
            return null;
          } catch (error) {
            return error;
          }
        });
        const row = yield* Effect.promise(() => service.getSandbox(orgId));
        return { row, sessionError };
      }),
    );

    expect(providerCalls).toEqual({ create: 1, wake: 0 });
    expect(handleCalls).toEqual({ getHandle: 2 });
    expect(handle.desktopExecCalls).toBe(1);
    expect(handle.desktopScriptWrites).toBe(1);
    expect(handle.desktopStopCalls).toBe(1);
    expect(handle.desktopVersionWrites).toBe(1);
    expect(String(result.sessionError)).toContain("desktop stream");
    expect(result.row?.status).toBe("error");
    expect(result.row?.error).toContain("desktop stream");
  });

  it("treats an already-running code-server process as reusable", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onCodeServerExec = () => {
      handle.codeServerHealthy = true;
      throw {
        error: "process with name 'code-server' already exists and is running",
        status: 400,
        statusText: "Bad Request",
      };
    };

    const result = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "CodeServerRace" }),
        );
        const service = makeSandboxesService(
          db,
          makeProvider(providerCalls),
          makeHandleProvider(handle, handleCalls),
        );
        const session = yield* Effect.promise(() => service.ensureCodeServerSession(orgId));
        const row = yield* Effect.promise(() => service.getSandbox(orgId));
        return { row, session };
      }),
    );

    expect(providerCalls).toEqual({ create: 1, wake: 0 });
    expect(handleCalls).toEqual({ getHandle: 2 });
    expect(handle.codeServerExecCalls).toBe(1);
    expect(result.session.sandboxId).toBe(`sbx_${orgId}`);
    expect(result.row?.status).toBe("ready");
    expect(result.row?.error).toBeNull();
  });

  it("marks the sandbox broken when code-server never becomes healthy", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.codeServerLogsText = "code-server failed forever";

    const result = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Broken Files" }),
        );
        const service = makeSandboxesService(
          db,
          makeProvider(providerCalls),
          makeHandleProvider(handle, handleCalls),
          {
            codeServerStartPollMs: 0,
            codeServerStartTimeoutMs: 1,
          },
        );
        const sessionError = yield* Effect.promise(async () => {
          try {
            await service.ensureCodeServerSession(orgId);
            return null;
          } catch (error) {
            return error;
          }
        });
        const row = yield* Effect.promise(() => service.getSandbox(orgId));
        return { row, sessionError };
      }),
    );

    expect(providerCalls).toEqual({ create: 1, wake: 0 });
    expect(handleCalls).toEqual({ getHandle: 2 });
    expect(String(result.sessionError)).toContain("code-server failed forever");
    expect(result.row?.status).toBe("error");
    expect(result.row?.error).toContain("code-server failed forever");
  });

  it("persists structured provider errors instead of [object Object]", async () => {
    const orgId = `org_${crypto.randomUUID()}`;

    const result = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "StructuredError" }),
        );

        const service = makeSandboxesService(
          db,
          {
            createOrGetSandbox: async () => {
              throw {
                code: "sandbox_create_failed",
                message: "provider exploded",
                status: 500,
              };
            },
            wakeSandbox: async () => {
              throw new Error("unexpected wake");
            },
          },
          makeHandleProvider(new FakeSandboxHandle(), { getHandle: 0 }),
        );

        const error = yield* Effect.promise(async () => {
          try {
            await service.ensureSandbox(orgId);
            return null;
          } catch (cause) {
            return cause;
          }
        });
        const row = yield* Effect.promise(() => service.getSandbox(orgId));
        return { error, row };
      }),
    );

    expect(String(result.error)).toContain("provider exploded");
    expect(result.row?.status).toBe("error");
    expect(result.row?.error).toContain("provider exploded");
    expect(result.row?.error).toContain("sandbox_create_failed");
    expect(result.row?.error).not.toBe("[object Object]");
  });

  it("treats an already-running execute runtime as reusable", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onExecuteExec = () => {
      handle.executeHealthy = true;
      throw {
        error: "process with name 'godtool-execute-runtime' already exists and is running",
        status: 400,
        statusText: "Bad Request",
      };
    };

    const result = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "ExecuteRace" }),
        );
        const service = makeSandboxesService(
          db,
          makeProvider(providerCalls),
          makeHandleProvider(handle, handleCalls),
        );
        const ensured = yield* Effect.promise(() => service.ensureExecuteRuntimeRunning(orgId));
        const row = yield* Effect.promise(() => service.getSandbox(orgId));
        return { ensured, row };
      }),
    );

    expect(providerCalls).toEqual({ create: 1, wake: 0 });
    expect(handleCalls).toEqual({ getHandle: 2 });
    expect(handle.executeExecCalls).toBe(1);
    expect(result.ensured.runtime.status).toBe("started");
    expect(result.row?.status).toBe("ready");
    expect(result.row?.error).toBeNull();
  });
});

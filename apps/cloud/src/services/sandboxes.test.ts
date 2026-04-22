import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { DbService } from "./db";
import {
  CODE_SERVER_CONFIG_PATH_FOR_TESTS,
  CODE_SERVER_PROCESS_NAME_FOR_TESTS,
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
  lastExecuteExecCommand: string | null = null;
  lastCodeServerWorkingDir: string | null = null;
  lastExecuteWorkingDir: string | null = null;
  codeServerConfigWrites = 0;
  codeServerExecCalls = 0;
  codeServerHealthChecks = 0;
  codeServerKillCalls = 0;
  codeServerLogsText = "";
  codeServerStopCalls = 0;
  executeExecCalls = 0;
  executeHealthChecks = 0;
  executeKillCalls = 0;
  executeLogsText = "";
  executeStopCalls = 0;
  previewCreates = 0;
  previewTokenCreates = 0;
  previewUrl = "https://preview.example.com";
  serverWrites = 0;
  versionWrites = 0;
  codeServerHealthy = false;
  executeHealthy = false;
  onCodeServerExec?: () => Promise<void> | void;
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
    },
  };

  readonly previews = {
    createIfNotExists: async () => {
      this.previewCreates += 1;
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
    exec: async (options: { readonly command: string; readonly name: string; readonly workingDir?: string }) => {
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

      throw new Error(`Unexpected process.kill(${name})`);
    },
    logs: async (name: string) => {
      if (name === EXECUTE_RUNTIME_PROCESS_NAME_FOR_TESTS) {
        return this.executeLogsText;
      }

      if (name === CODE_SERVER_PROCESS_NAME_FOR_TESTS) {
        return this.codeServerLogsText;
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
    expect(handleCalls).toEqual({ getHandle: 1 });
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
    expect(handle.files.get(EXECUTE_RUNTIME_VERSION_PATH_FOR_TESTS)).toBe(getExecuteRuntimeVersion());
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
    expect(handleCalls).toEqual({ getHandle: 2 });
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
    expect(handleCalls).toEqual({ getHandle: 2 });
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
    expect(handleCalls).toEqual({ getHandle: 2 });
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
    expect(handleCalls).toEqual({ getHandle: 1 });
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
    expect(handleCalls).toEqual({ getHandle: 2 });
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
    expect(handleCalls).toEqual({ getHandle: 0 });
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
    expect(handleCalls).toEqual({ getHandle: 1 });
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
    expect(handleCalls).toEqual({ getHandle: 1 });
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
    expect(handleCalls).toEqual({ getHandle: 2 });
    expect(handle.codeServerExecCalls).toBe(1);
    expect(handle.previewCreates).toBe(2);
    expect(handle.previewTokenCreates).toBe(2);
    expect(secondSession.sandboxStatus).toBe("reused");
    expect(secondSession.url).toContain("bl_preview_token=token-2");
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
    expect(handleCalls).toEqual({ getHandle: 1 });
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
});

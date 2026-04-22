import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { DbService } from "./db";
import {
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
  execCalls = 0;
  healthChecks = 0;
  killCalls = 0;
  logsText = "";
  serverWrites = 0;
  stopCalls = 0;
  versionWrites = 0;
  healthy = false;
  onExec?: () => Promise<void> | void;

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
    },
  };

  readonly process = {
    exec: async (options: { readonly name: string }) => {
      expect(options.name).toBe(EXECUTE_RUNTIME_PROCESS_NAME_FOR_TESTS);
      this.execCalls += 1;
      await this.onExec?.();
    },
    kill: async (name: string) => {
      expect(name).toBe(EXECUTE_RUNTIME_PROCESS_NAME_FOR_TESTS);
      this.killCalls += 1;
    },
    logs: async (name: string) => {
      expect(name).toBe(EXECUTE_RUNTIME_PROCESS_NAME_FOR_TESTS);
      return this.logsText;
    },
    stop: async (name: string) => {
      expect(name).toBe(EXECUTE_RUNTIME_PROCESS_NAME_FOR_TESTS);
      this.stopCalls += 1;
    },
  };

  readonly fetch = async (port: number, path: string) => {
    expect(port).toBe(4789);
    expect(path).toBe("/health");
    this.healthChecks += 1;
    return this.healthy
      ? { ok: true, status: 200 }
      : { ok: false, status: 503 };
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
    handle.onExec = () => {
      handle.healthy = true;
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
    expect(handle.execCalls).toBe(1);
    expect(handle.serverWrites).toBe(1);
    expect(handle.versionWrites).toBe(1);
    expect(handle.files.get(EXECUTE_RUNTIME_VERSION_PATH_FOR_TESTS)).toBe(getExecuteRuntimeVersion());
  });

  it("reuses a healthy runtime without reinstalling or restarting it", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onExec = () => {
      handle.healthy = true;
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
    expect(handle.execCalls).toBe(1);
    expect(handle.serverWrites).toBe(1);
    expect(handle.versionWrites).toBe(1);
  });

  it("reinstalls assets when the runtime version changes before restarting", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onExec = () => {
      handle.healthy = true;
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
        handle.healthy = false;
        handle.files.set(EXECUTE_RUNTIME_VERSION_PATH_FOR_TESTS, "old-runtime-version");
        return yield* Effect.promise(() => service.ensureExecuteRuntimeRunning(orgId));
      }),
    );

    expect(providerCalls).toEqual({ create: 1, wake: 1 });
    expect(handleCalls).toEqual({ getHandle: 2 });
    expect(ensured.install.cacheHit).toBe(false);
    expect(ensured.runtime.status).toBe("started");
    expect(handle.execCalls).toBe(2);
    expect(handle.serverWrites).toBe(2);
    expect(handle.versionWrites).toBe(2);
  });

  it("restarts a healthy runtime when the installed version changes", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onExec = () => {
      handle.healthy = true;
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
    expect(handle.execCalls).toBe(2);
    expect(handle.stopCalls).toBe(2);
    expect(handle.serverWrites).toBe(2);
    expect(handle.versionWrites).toBe(2);
  });

  it("marks the sandbox broken if the runtime never becomes healthy", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.logsText = "boot failed forever";

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

  it("treats error rows as permanently broken for runtime ensures too", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const providerCalls = { create: 0, wake: 0 };
    const handleCalls = { getHandle: 0 };
    const handle = new FakeSandboxHandle();
    handle.onExec = () => {
      handle.healthy = true;
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

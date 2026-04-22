import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { eq } from "drizzle-orm";

import { DbService } from "./db";
import { makeSandboxesService, type SandboxProvider } from "./sandboxes";
import { sandboxes } from "./schema";
import { makeUserStore } from "./user-store";

const program = <A, E>(body: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(
    body.pipe(Effect.provide(DbService.Live), Effect.scoped) as Effect.Effect<A, E, never>,
  );

describe("sandboxes service", () => {
  it("creates and persists an org-scoped sandbox on first ensure", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const calls = { create: 0, wake: 0 };
    const provider: SandboxProvider = {
      createOrGetSandbox: async ({ organizationId }) => {
        calls.create += 1;
        return {
          externalId: `sbx_${organizationId}`,
          sandboxName: `godtool-org-${organizationId}`,
          status: "created",
        };
      },
      wakeSandbox: async ({ externalId, organizationId }) => {
        calls.wake += 1;
        return {
          externalId,
          sandboxName: `godtool-org-${organizationId}`,
          status: "reused",
        };
      },
    };

    const ensured = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Acme" }),
        );
        return yield* Effect.promise(() =>
          makeSandboxesService(db, provider).ensureSandbox(orgId),
        );
      }),
    );

    expect(calls).toEqual({ create: 1, wake: 0 });
    expect(ensured.record.organizationId).toBe(orgId);
    expect(ensured.record.externalId).toBe(`sbx_${orgId}`);
    expect(ensured.record.status).toBe("ready");
    expect(ensured.status).toBe("created");
  });

  it("wakes an existing ready sandbox instead of creating a new one", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const calls = { create: 0, wake: 0 };
    const provider: SandboxProvider = {
      createOrGetSandbox: async ({ organizationId }) => {
        calls.create += 1;
        return {
          externalId: `sbx_${organizationId}`,
          sandboxName: `godtool-org-${organizationId}`,
          status: "created",
        };
      },
      wakeSandbox: async ({ externalId, organizationId }) => {
        calls.wake += 1;
        return {
          externalId,
          sandboxName: `godtool-org-${organizationId}`,
          status: "reused",
        };
      },
    };

    const ensured = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Wakeful" }),
        );
        const service = makeSandboxesService(db, provider);
        yield* Effect.promise(() => service.ensureSandbox(orgId));
        return yield* Effect.promise(() => service.ensureSandbox(orgId));
      }),
    );

    expect(calls).toEqual({ create: 1, wake: 1 });
    expect(ensured.record.status).toBe("ready");
    expect(ensured.status).toBe("reused");
  });

  it("treats error rows as permanently broken for now", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const calls = { create: 0, wake: 0 };
    const provider: SandboxProvider = {
      createOrGetSandbox: async ({ organizationId }) => {
        calls.create += 1;
        return {
          externalId: `sbx_${organizationId}`,
          sandboxName: `godtool-org-${organizationId}`,
          status: "created",
        };
      },
      wakeSandbox: async ({ externalId, organizationId }) => {
        calls.wake += 1;
        return {
          externalId,
          sandboxName: `godtool-org-${organizationId}`,
          status: "reused",
        };
      },
    };

    const errorMessage = await program(
      Effect.gen(function* () {
        const { db } = yield* DbService;
        yield* Effect.promise(() =>
          makeUserStore(db).upsertOrganization({ id: orgId, name: "Broken" }),
        );
        const service = makeSandboxesService(db, provider);
        yield* Effect.promise(() => service.ensureSandbox(orgId)).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* Effect.promise(() =>
          db
            .update(sandboxes)
            .set({
              error: "sandbox is broken",
              status: "error",
              updatedAt: new Date(),
            })
            .where(eq(sandboxes.organizationId, orgId)),
        );
        return yield* Effect.promise(async () => {
          try {
            await service.ensureSandbox(orgId);
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        });
      }),
    );

    expect(errorMessage).toContain("sandbox is broken");
    expect(calls).toEqual({ create: 1, wake: 0 });
  });
});

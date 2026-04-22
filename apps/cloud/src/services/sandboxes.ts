import { initialize, SandboxInstance } from "@blaxel/core";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { sandboxes } from "./schema";
import type { DrizzleDb } from "./db";

const DEFAULT_BLAXEL_MEMORY_MB = 4096;
const DEFAULT_BLAXEL_REGION = "us-pdx-1";
const BLAXEL_PROVIDER = "blaxel" as const;

export type SandboxStatus = "creating" | "ready" | "error";
export type SandboxRecord = typeof sandboxes.$inferSelect;

export interface EnsuredSandbox {
  readonly externalId: string;
  readonly record: SandboxRecord;
  readonly sandboxName: string;
  readonly status: "created" | "reused";
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

export const getSandboxNameForOrganization = (organizationId: string) =>
  `godtool-org-${organizationId}`;

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

const inferBrokenMessage = (organizationId: string, error: string | null | undefined) =>
  error?.trim().length
    ? error
    : `Sandbox for organization "${organizationId}" is marked broken.`;

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

export const makeSandboxesService = (
  db: DrizzleDb,
  provider: SandboxProvider = makeBlaxelSandboxProvider(),
) => {
  const store = makeSandboxStore(db);

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
          error: error instanceof Error ? error.message : String(error),
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
        error: error instanceof Error ? error.message : String(error),
        organizationId: record.organizationId,
      });
      throw new Error(inferBrokenMessage(record.organizationId, broken.error));
    }
  };

  return {
    getSandbox: (organizationId: string) => store.getByOrganizationId(organizationId),

    ensureSandbox: async (organizationId: string) => {
      const row =
        (await store.getByOrganizationId(organizationId)) ??
        (await store.createPending(organizationId));

      if (!row) {
        throw new Error(`Failed to create sandbox row for organization "${organizationId}".`);
      }

      return await ensureProvisioned(row);
    },
  };
};

// ---------------------------------------------------------------------------
// Cloud executor — stateless, per-request, new SDK shape
// ---------------------------------------------------------------------------
//
// Each invocation of `createScopedExecutor` runs inside a request-scoped
// Effect and yields a fresh executor bound to the current DbService's
// per-request postgres.js client. Cloudflare Workers + Hyperdrive demand
// fresh connections per request, so "build once" means "once per request"
// here.

import { Effect } from "effect";

import {
  Scope,
  ScopeId,
  type AnyPlugin,
  collectSchemas,
  createExecutor,
} from "@executor/sdk";
import {
  makePostgresAdapter,
  makePostgresBlobStore,
} from "@executor/storage-postgres";
import { openApiPlugin } from "@executor/plugin-openapi";
import { mcpPlugin } from "@executor/plugin-mcp";
import { googleDiscoveryPlugin } from "@executor/plugin-google-discovery";
import { graphqlPlugin } from "@executor/plugin-graphql";
import { rawPlugin } from "@executor/plugin-raw";
import { workosVaultPlugin } from "@executor/plugin-workos-vault";

import { env } from "cloudflare:workers";
import { computerUsePlugin, type ComputerUseBackend } from "./computer-use-plugin";
import { makeSandboxesService } from "./sandboxes";
import { AutumnService, type IAutumnService } from "./autumn";
import { DbService, type DrizzleDb } from "./db";

// ---------------------------------------------------------------------------
// Plugin list — one place, used for both the runtime and the CLI config
// (executor.config.ts). No stdio MCP in cloud; no keychain/file-secrets/
// 1password.
//
// NOTE: the CLI config (executor.config.ts) imports these same plugins with
// stub credentials because it only reads `plugin.schema`. Here we pass
// real credentials from the env.
// ---------------------------------------------------------------------------

export interface CreateScopedExecutorOptions {
  readonly computerUseEnabled?: boolean;
}

const quoteShellArgument = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const createComputerUseBackend = (args: {
  readonly computerUseEnabled: boolean;
  readonly db: DrizzleDb;
  readonly organizationId: string;
  readonly autumn: IAutumnService;
}): ComputerUseBackend => {
  const sandboxes = makeSandboxesService(args.db);

  const assertComputerUseEnabled = async () => {
    if (!args.computerUseEnabled) {
      throw new Error("Computer use is available on the Pro plan.");
    }

    const hasAccess = await Effect.runPromise(
      args.autumn.hasPersistentSandbox(args.organizationId),
    );
    if (!hasAccess) {
      throw new Error("Computer use is available on the Pro plan.");
    }
  };

  const runDesktopCommand: ComputerUseBackend["runDesktopCommand"] = async (input) => {
    await assertComputerUseEnabled();
    return sandboxes.runDesktopCommand(args.organizationId, {
      command: input.command,
      timeoutSeconds: input.timeoutSeconds,
    });
  };

  return {
    runAgentBrowser: async (input) => {
      await assertComputerUseEnabled();
      return sandboxes.runDesktopCommand(args.organizationId, {
        command: ["agent-browser", "--cdp", "9222", ...input.args.map(quoteShellArgument)].join(
          " ",
        ),
        timeoutSeconds: input.timeoutSeconds,
      });
    },
    runDesktopCommand,
  };
};

const createOrgPlugins = (options: {
  readonly computerUseBackend?: ComputerUseBackend;
}) => {
  const plugins: AnyPlugin[] = [
    openApiPlugin({ composioApiKey: env.COMPOSIO_API_KEY || undefined }),
    mcpPlugin({ dangerouslyAllowStdioMCP: false }),
    googleDiscoveryPlugin({ composioApiKey: env.COMPOSIO_API_KEY || undefined }),
    graphqlPlugin({ composioApiKey: env.COMPOSIO_API_KEY || undefined }),
    rawPlugin({ composioApiKey: env.COMPOSIO_API_KEY || undefined }),
    workosVaultPlugin({
      credentials: {
        apiKey: env.WORKOS_API_KEY,
        clientId: env.WORKOS_CLIENT_ID,
      },
    }),
  ];

  if (options.computerUseBackend) {
    plugins.push(computerUsePlugin({ backend: options.computerUseBackend }));
  }

  return plugins;
};

// ---------------------------------------------------------------------------
// Create a fresh executor for a (user, org) pair (stateless, per-request).
//
// Scope stack is `[userOrgScope, orgScope]` — innermost first. The
// user-within-org scope id (`user-org:${userId}:${orgId}`) intentionally
// includes the org id so the same WorkOS user in a different org gets a
// distinct scope row; future workspace scopes can slot in between without
// conflicting with a hypothetical global user scope.
//
// OAuth tokens land at `ctx.scopes[0]` (the user-org scope) by default, so
// a member's access/refresh tokens can't leak to other members via
// `secrets.list`, while source rows and org-wide credentials live on the
// outer scope.
// ---------------------------------------------------------------------------

export const createScopedExecutor = (
  userId: string,
  organizationId: string,
  organizationName: string,
  options: CreateScopedExecutorOptions = {},
) =>
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const autumn = yield* AutumnService;

    const plugins = createOrgPlugins({
      computerUseBackend: options.computerUseEnabled
        ? createComputerUseBackend({
            autumn,
            computerUseEnabled: true,
            db,
            organizationId,
          })
        : undefined,
    });
    const schema = collectSchemas(plugins);
    const adapter = makePostgresAdapter({ db, schema });
    const blobs = makePostgresBlobStore({ db });

    const orgScope = new Scope({
      id: ScopeId.make(organizationId),
      name: organizationName,
      createdAt: new Date(),
    });
    const userOrgScope = new Scope({
      id: ScopeId.make(`user-org:${userId}:${organizationId}`),
      name: `Personal · ${organizationName}`,
      createdAt: new Date(),
    });

    // The executor surface returns raw `StorageFailure`; translation to
    // the opaque `InternalError({ traceId })` happens at the HTTP edge
    // via `withCapture` (see `api/protected-layers.ts`). That's
    // where `ErrorCaptureLive` (Sentry) gets wired in.
    return yield* createExecutor({
      scopes: [userOrgScope, orgScope],
      adapter,
      blobs,
      plugins,
    });
  });

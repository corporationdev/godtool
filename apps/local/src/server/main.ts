import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
} from "@effect/platform";
import { Context, Effect, Layer, ManagedRuntime } from "effect";

import { addGroup, observabilityMiddleware } from "@executor/api";
import { CoreHandlers, ExecutorService, ExecutionEngineService } from "@executor/api/server";
import { createExecutionEngine } from "@executor/execution";
import { makeQuickJsExecutor } from "@executor/runtime-quickjs";
import { ManagedAuthBillingService } from "@executor/plugin-managed-auth";
import {
  OpenApiGroup,
  OpenApiHandlers,
  OpenApiExtensionService,
} from "@executor/plugin-openapi/api";
import { McpGroup, McpHandlers, McpExtensionService } from "@executor/plugin-mcp/api";
import {
  GoogleDiscoveryGroup,
  GoogleDiscoveryHandlers,
  GoogleDiscoveryExtensionService,
} from "@executor/plugin-google-discovery/api";
import {
  OnePasswordGroup,
  OnePasswordHandlers,
  OnePasswordExtensionService,
} from "@executor/plugin-onepassword/api";
import {
  GraphqlGroup,
  GraphqlHandlers,
  GraphqlExtensionService,
} from "@executor/plugin-graphql/api";
import {
  RawBillingService,
  RawGroup,
  RawHandlers,
  RawExtensionService,
} from "@executor/plugin-raw/api";
import {
  ComputerUseGroup,
  ComputerUseHandlers,
  ComputerUseExtensionService,
} from "@executor/plugin-computer-use/api";
import type { Source, Tool } from "@executor/sdk";
import {
  deleteSourcePackages,
  exportSourcePackages,
  importSourcePackages,
  listSourceImportCandidates,
  type PortableSourcePackage,
} from "@executor/source-sync";
import { getExecutor } from "./executor";
import { createMcpRequestHandler, type McpRequestHandler } from "./mcp";
import { ErrorCaptureLive } from "./observability";

// ---------------------------------------------------------------------------
// Local server API — core + all plugin groups
// ---------------------------------------------------------------------------

const LocalApi = addGroup(OpenApiGroup)
  .add(McpGroup)
  .add(GoogleDiscoveryGroup)
  .add(OnePasswordGroup)
  .add(GraphqlGroup)
  .add(RawGroup)
  .add(ComputerUseGroup);

// `ErrorCaptureLive` logs causes to the console and returns a short
// correlation id. Provided above the handler + middleware layers so
// both the `withCapture` typed-channel translation AND the
// `observabilityMiddleware` defect catchall see the same
// implementation.
const LocalObservability = observabilityMiddleware(LocalApi);

const LocalApiBase = HttpApiBuilder.api(LocalApi).pipe(
  Layer.provide(CoreHandlers),
  Layer.provide(
    Layer.mergeAll(
      OpenApiHandlers.pipe(Layer.provide(ManagedAuthBillingService.AllowAll)),
      McpHandlers,
      GoogleDiscoveryHandlers.pipe(Layer.provide(ManagedAuthBillingService.AllowAll)),
      OnePasswordHandlers,
      GraphqlHandlers.pipe(Layer.provide(ManagedAuthBillingService.AllowAll)),
      RawHandlers.pipe(Layer.provide(RawBillingService.AllowAll)),
      ComputerUseHandlers,
    ),
  ),
  Layer.provide(LocalObservability),
  Layer.provide(ErrorCaptureLive),
);

// ---------------------------------------------------------------------------
// Server handlers
// ---------------------------------------------------------------------------

export type ServerHandlers = {
  readonly api: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly dispose: () => Promise<void>;
  };
  readonly desktopRpc: {
    readonly handler: (request: Request) => Promise<Response>;
  };
  readonly mcp: McpRequestHandler;
};

const closeServerHandlers = async (handlers: ServerHandlers): Promise<void> => {
  await Promise.all([
    handlers.api.dispose().catch(() => undefined),
    handlers.mcp.close().catch(() => undefined),
  ]);
};

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
};

type DesktopCatalogSource = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly pluginId: string;
  readonly toolCount: number;
};

const makeDesktopRpcHandler = (engine: ReturnType<typeof createExecutionEngine>) => {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== "/execute") return json({ error: "not_found" }, { status: 404 });
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, { status: 405 });
    }

    const payload = (await request.json().catch(() => null)) as { readonly code?: unknown } | null;
    if (!payload || typeof payload.code !== "string") {
      return json({ error: "invalid_request" }, { status: 400 });
    }

    try {
      const outcome = await Effect.runPromise(engine.executeWithPause(payload.code));
      if (outcome.status === "completed") {
        return json({
          status: "completed",
          result: outcome.result,
        });
      }

      return json(
        {
          status: "error",
          error: `Execution paused locally and cannot be resumed over the desktop device RPC yet: ${outcome.execution.elicitationContext.request.message}`,
        },
        { status: 409 },
      );
    } catch (error) {
      return json({ status: "error", error: errorMessage(error) }, { status: 500 });
    }
  };
};

const makeDesktopCatalogHandler = (executor: Awaited<ReturnType<typeof getExecutor>>) => {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== "/catalog") return json({ error: "not_found" }, { status: 404 });
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, { status: 405 });
    }

    try {
      const [sources, tools] = await Promise.all([
        Effect.runPromise(executor.sources.list()),
        Effect.runPromise(executor.tools.list({ includeAnnotations: false })),
      ]);
      const toolCountBySource = new Map<string, number>();
      for (const tool of tools as readonly Tool[]) {
        toolCountBySource.set(tool.sourceId, (toolCountBySource.get(tool.sourceId) ?? 0) + 1);
      }

      const catalog = (sources as readonly Source[]).map(
        (source): DesktopCatalogSource => ({
          id: source.id,
          name: source.name,
          kind: source.kind,
          pluginId: source.pluginId,
          toolCount: toolCountBySource.get(source.id) ?? 0,
        }),
      );

      return json({ sources: catalog });
    } catch (error) {
      return json({ status: "error", error: errorMessage(error) }, { status: 500 });
    }
  };
};

const makeDesktopSourceSyncHandler = (executor: Awaited<ReturnType<typeof getExecutor>>) => {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/sources/")) return json({ error: "not_found" }, { status: 404 });
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, { status: 405 });
    }

    try {
      const scopeId = executor.scopes[0]?.id as string | undefined;
      if (!scopeId) return json({ error: "scope_unavailable" }, { status: 500 });
      const payload = (await request.json().catch(() => ({}))) as {
        readonly sourceIds?: unknown;
        readonly sources?: unknown;
      };

      if (url.pathname === "/sources/import-candidates") {
        return json({ sources: await listSourceImportCandidates(executor, scopeId) });
      }

      const sourceIds = Array.isArray(payload.sourceIds)
        ? payload.sourceIds.filter((id): id is string => typeof id === "string")
        : [];

      if (url.pathname === "/sources/export") {
        return json({ sources: await exportSourcePackages(executor, sourceIds, scopeId) });
      }

      if (url.pathname === "/sources/import") {
        const sources = Array.isArray(payload.sources)
          ? (payload.sources as readonly PortableSourcePackage[])
          : [];
        return json({ sourceIds: await importSourcePackages(executor, sources, scopeId) });
      }

      if (url.pathname === "/sources/delete") {
        return json({ sourceIds: await deleteSourcePackages(executor, sourceIds) });
      }

      return json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return json({ error: errorMessage(error) }, { status: 500 });
    }
  };
};

export const createServerHandlers = async (): Promise<ServerHandlers> => {
  const executor = await getExecutor();
  const engine = createExecutionEngine({ executor, codeExecutor: makeQuickJsExecutor() });

  // Handlers wrap their own bodies with `capture(...)` — the edge
  // translation lives per-handler, not at service construction.
  const pluginExtensions = Layer.mergeAll(
    Layer.succeed(OpenApiExtensionService, executor.openapi),
    Layer.succeed(McpExtensionService, executor.mcp),
    Layer.succeed(GoogleDiscoveryExtensionService, executor.googleDiscovery),
    Layer.succeed(OnePasswordExtensionService, executor.onepassword),
    Layer.succeed(GraphqlExtensionService, executor.graphql),
    Layer.succeed(RawExtensionService, executor.raw),
    Layer.succeed(ComputerUseExtensionService, executor.computer_use),
  );

  const api = HttpApiBuilder.toWebHandler(
    HttpApiSwagger.layer({ path: "/docs" }).pipe(
      Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
      Layer.provideMerge(LocalApiBase),
      Layer.provideMerge(pluginExtensions),
      Layer.provideMerge(Layer.succeed(ExecutorService, executor)),
      Layer.provideMerge(Layer.succeed(ExecutionEngineService, engine)),
      Layer.provideMerge(HttpServer.layerContext),
      Layer.provideMerge(HttpRouter.setRouterConfig({ maxParamLength: 1000 })),
    ),
    { middleware: HttpMiddleware.logger },
  );

  const mcp = createMcpRequestHandler({ engine });
  const executeHandler = makeDesktopRpcHandler(engine);
  const catalogHandler = makeDesktopCatalogHandler(executor);
  const sourceSyncHandler = makeDesktopSourceSyncHandler(executor);
  const desktopRpc = {
    handler: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/catalog") return catalogHandler(request);
      if (url.pathname.startsWith("/sources/")) return sourceSyncHandler(request);
      return executeHandler(request);
    },
  };

  return { api, desktopRpc, mcp };
};

export class ServerHandlersService extends Context.Tag("@executor/local/ServerHandlersService")<
  ServerHandlersService,
  ServerHandlers
>() {}

const ServerHandlersLive = Layer.scoped(
  ServerHandlersService,
  Effect.acquireRelease(
    Effect.promise(() => createServerHandlers()),
    (handlers) => Effect.promise(() => closeServerHandlers(handlers)),
  ),
);

const serverHandlersRuntime = ManagedRuntime.make(ServerHandlersLive);

export const getServerHandlers = (): Promise<ServerHandlers> =>
  serverHandlersRuntime.runPromise(ServerHandlersService);

export const disposeServerHandlers = async (): Promise<void> => {
  await serverHandlersRuntime.dispose().catch(() => undefined);
};

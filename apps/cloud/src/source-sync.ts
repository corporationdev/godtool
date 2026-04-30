import { env } from "cloudflare:workers";
import { Effect } from "effect";
import {
  deleteSourcePackages,
  exportSourcePackages,
  importSourcePackages,
  type PortableSourcePackage,
  type SourceImportCandidate,
} from "@executor/source-sync";

import { authorizeOrganization } from "./auth/authorize-organization";
import { WorkOSAuth } from "./auth/workos";
import { SharedServices } from "./api/layers";
import { createScopedExecutor } from "./services/executor";
import { createComposioBrokerToken } from "./composio-proxy";

type DeviceSessionBinding = DurableObjectNamespace<import("./device-session").DeviceSessionDO>;

const INTERNAL_USER_ID_HEADER = "x-godtool-device-user-id";
const INTERNAL_ORGANIZATION_ID_HEADER = "x-godtool-device-organization-id";
const INTERNAL_ORGANIZATION_NAME_HEADER = "x-godtool-device-organization-name";

type SourceSyncAuth = {
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName: string;
};

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

const authenticateSourceSyncRequest = (request: Request) =>
  Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    const session = yield* workos.authenticateRequest(request);
    if (!session?.organizationId) return null;
    const org = yield* authorizeOrganization(session.userId, session.organizationId);
    if (!org) return null;
    return { userId: session.userId, organizationId: org.id, organizationName: org.name };
  }).pipe(
    Effect.provide(SharedServices),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error("[source-sync] auth failed", error);
        return null;
      }),
    ),
  );

const deviceSessionNamespace = (): DeviceSessionBinding | null =>
  (env as Env & { DEVICE_SESSION?: DeviceSessionBinding }).DEVICE_SESSION ?? null;

const deviceStubForOrganization = (organizationId: string) => {
  const namespace = deviceSessionNamespace();
  if (!namespace) return null;
  return namespace.get(namespace.idFromName(`org:${organizationId}`));
};

const withDeviceHeaders = (request: Request, auth: SourceSyncAuth): Headers => {
  const headers = new Headers(request.headers);
  headers.set(INTERNAL_USER_ID_HEADER, auth.userId);
  headers.set(INTERNAL_ORGANIZATION_ID_HEADER, auth.organizationId);
  headers.set(INTERNAL_ORGANIZATION_NAME_HEADER, auth.organizationName);
  headers.set("content-type", "application/json");
  return headers;
};

const deviceRequest = async (
  auth: SourceSyncAuth,
  originalRequest: Request,
  route: "export" | "import" | "delete" | "import-candidates",
  payload: unknown,
): Promise<Response> => {
  const stub = deviceStubForOrganization(auth.organizationId);
  if (!stub) return json({ error: "device_session_unavailable" }, { status: 503 });
  return stub.fetch(
    new Request(`https://device-session/source/${route}`, {
      method: "POST",
      headers: withDeviceHeaders(originalRequest, auth),
      body: JSON.stringify(payload ?? {}),
    }),
  );
};

const readPayload = async (request: Request) =>
  (await request.json().catch(() => ({}))) as {
    readonly sourceIds?: unknown;
    readonly sources?: unknown;
    readonly placements?: unknown;
  };

const sourceIdsFromPayload = (payload: { readonly sourceIds?: unknown }): readonly string[] =>
  Array.isArray(payload.sourceIds)
    ? payload.sourceIds.filter((id): id is string => typeof id === "string")
    : [];

const portableSourcesFromPayload = (payload: {
  readonly sources?: unknown;
}): readonly PortableSourcePackage[] =>
  Array.isArray(payload.sources) ? (payload.sources as readonly PortableSourcePackage[]) : [];

const placementsFromPayload = (payload: {
  readonly placements?: unknown;
}): ReadonlySet<"local" | "cloud"> => {
  if (!Array.isArray(payload.placements)) return new Set(["local", "cloud"]);
  const placements = payload.placements.filter(
    (placement): placement is "local" | "cloud" => placement === "local" || placement === "cloud",
  );
  return new Set(placements.length > 0 ? placements : ["local", "cloud"]);
};

const attachManagedAuthBrokers = async (
  auth: SourceSyncAuth,
  request: Request,
  sources: readonly PortableSourcePackage[],
): Promise<readonly PortableSourcePackage[]> => {
  const brokerUrl = new URL("/api/composio-proxy/http", request.url).toString();
  const out: PortableSourcePackage[] = [];
  for (const source of sources) {
    const connections = [];
    for (const connection of source.connections) {
      if (!connection.provider.endsWith("-composio")) {
        connections.push(connection);
        continue;
      }
      connections.push({
        ...connection,
        accessToken: await createComposioBrokerToken(auth, connection.id),
        providerState: {
          ...(connection.providerState ?? {}),
          brokerUrl,
        },
      });
    }
    out.push({ ...source, connections });
  }
  return out;
};

const sourceSyncEffect = (auth: SourceSyncAuth, request: Request, route: string) =>
  Effect.gen(function* () {
    const payload = yield* Effect.promise(() => readPayload(request));
    const executor = yield* createScopedExecutor(
      auth.userId,
      auth.organizationId,
      auth.organizationName,
    );
    const scopeId = auth.organizationId;

    if (route === "import-candidates") {
      const deviceResponse = yield* Effect.promise(() =>
        deviceRequest(auth, request, "import-candidates", {}),
      );
      if (!deviceResponse.ok) return deviceResponse;
      const data = (yield* Effect.promise(() => deviceResponse.json().catch(() => ({})))) as {
        readonly sources?: readonly SourceImportCandidate[];
      };
      const cloudIds = new Set((yield* executor.sources.list()).map((source) => source.id));
      return json({
        sources: (data.sources ?? []).filter((source) => !cloudIds.has(source.id)),
      });
    }

    if (route === "to-cloud") {
      let sources = portableSourcesFromPayload(payload);
      if (sources.length === 0) {
        const deviceResponse = yield* Effect.promise(() =>
          deviceRequest(auth, request, "export", { sourceIds: sourceIdsFromPayload(payload) }),
        );
        if (!deviceResponse.ok) return deviceResponse;
        const data = (yield* Effect.promise(() => deviceResponse.json().catch(() => ({})))) as {
          readonly sources?: readonly PortableSourcePackage[];
        };
        sources = data.sources ?? [];
      }
      const sourceIds = yield* Effect.promise(() =>
        importSourcePackages(executor, sources, scopeId),
      );
      return json({ sourceIds });
    }

    if (route === "to-local") {
      const sourceIds = sourceIdsFromPayload(payload);
      const sources = yield* Effect.promise(async () =>
        attachManagedAuthBrokers(
          auth,
          request,
          await exportSourcePackages(executor, sourceIds, scopeId),
        ),
      );
      return yield* Effect.promise(() => deviceRequest(auth, request, "import", { sources }));
    }

    if (route === "delete") {
      const sourceIds = sourceIdsFromPayload(payload);
      const placements = placementsFromPayload(payload);
      let deletedLocal: readonly string[] = [];
      if (placements.has("local")) {
        const localDelete = yield* Effect.promise(() =>
          deviceRequest(auth, request, "delete", { sourceIds }),
        );
        if (!localDelete.ok) return localDelete;
        const data = (yield* Effect.promise(() => localDelete.json().catch(() => ({})))) as {
          readonly sourceIds?: readonly string[];
        };
        deletedLocal = data.sourceIds ?? [];
      }
      const deletedCloud = placements.has("cloud")
        ? yield* Effect.promise(() => deleteSourcePackages(executor, sourceIds).catch(() => []))
        : [];
      return json({
        sourceIds: Array.from(new Set([...sourceIds, ...deletedLocal, ...deletedCloud])),
      });
    }

    return json({ error: "not_found" }, { status: 404 });
  }).pipe(
    Effect.provide(SharedServices),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error("[source-sync] request failed", error);
        return json({ error: "source_sync_failed" }, { status: 500 });
      }),
    ),
  );

export const sourceSyncFetch = async (request: Request): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/source-sync/")) return null;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });

  const auth = await Effect.runPromise(authenticateSourceSyncRequest(request));
  if (!auth) return json({ error: "unauthorized" }, { status: 401 });

  const route = url.pathname.slice("/api/source-sync/".length);
  return Effect.runPromise(sourceSyncEffect(auth, request, route));
};

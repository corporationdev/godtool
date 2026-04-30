import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { authorizeOrganization } from "./auth/authorize-organization";
import { WorkOSAuth } from "./auth/workos";
import { SharedServices } from "./api/layers";
import { DbService } from "./services/db";

type DeviceSessionBinding = DurableObjectNamespace<import("./device-session").DeviceSessionDO>;

const INTERNAL_USER_ID_HEADER = "x-godtool-device-user-id";
const INTERNAL_ORGANIZATION_ID_HEADER = "x-godtool-device-organization-id";
const INTERNAL_ORGANIZATION_NAME_HEADER = "x-godtool-device-organization-name";
const AUTH_PROTOCOL_PREFIX = "godtool-auth.";

// TODO: Replace the sealed-session websocket subprotocol with a scoped,
// revocable desktop device credential minted after normal WorkOS auth. The
// current path is acceptable over wss:// because cloud re-authenticates the
// sealed WorkOS session before opening the device tunnel, but the long-term
// contract should avoid replaying the full app session on every reconnect.

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

type DeviceAuth = {
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName: string;
};

type CatalogSourceInput = {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly kind?: unknown;
  readonly pluginId?: unknown;
  readonly toolCount?: unknown;
};

type CatalogPayload = {
  readonly deviceId?: unknown;
  readonly sources?: unknown;
};

type DeviceStatus = {
  readonly activeDeviceId: string | null;
  readonly devices: readonly {
    readonly deviceId: string;
    readonly online: boolean;
  }[];
};

type CatalogRow = {
  readonly source_id: string;
  readonly name: string;
  readonly kind: string;
  readonly plugin_id: string;
  readonly tool_count: number;
};

const decodeBase64Url = (value: string): string | null => {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return atob(padded);
  } catch {
    return null;
  }
};

const cookieFromWebSocketProtocol = (request: Request): string | null => {
  const protocol = request.headers
    .get("sec-websocket-protocol")
    ?.split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith(AUTH_PROTOCOL_PREFIX));
  if (!protocol) return null;

  const session = decodeBase64Url(protocol.slice(AUTH_PROTOCOL_PREFIX.length));
  return session ? `wos-session=${session}` : null;
};

const withProtocolCookie = (request: Request): Request => {
  if (request.headers.get("cookie")) return request;
  const cookie = cookieFromWebSocketProtocol(request);
  if (!cookie) return request;

  const headers = new Headers(request.headers);
  headers.set("cookie", cookie);
  return new Request(request, { headers });
};

const authenticateDeviceRequest = (request: Request) =>
  Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    const session = yield* workos.authenticateRequest(withProtocolCookie(request));
    if (!session?.organizationId) return null;

    const org = yield* authorizeOrganization(session.userId, session.organizationId);
    if (!org) return null;

    return { userId: session.userId, organizationId: org.id, organizationName: org.name };
  }).pipe(
    Effect.provide(SharedServices),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error("[devices] auth failed", error);
        return null;
      }),
    ),
  );

const getDeviceSessionNamespace = (): DeviceSessionBinding | null =>
  (env as Env & { DEVICE_SESSION?: DeviceSessionBinding }).DEVICE_SESSION ?? null;

const deviceStubForOrganization = (organizationId: string) => {
  const namespace = getDeviceSessionNamespace();
  if (!namespace) return null;
  return namespace.get(namespace.idFromName(`org:${organizationId}`));
};

const sanitizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, 160) : null;
};

const sanitizeToolCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100_000, Math.trunc(value)));
};

const parseCatalogPayload = async (request: Request) => {
  const payload = (await request.json().catch(() => null)) as CatalogPayload | null;
  const deviceId = sanitizeText(payload?.deviceId);
  if (!deviceId || !Array.isArray(payload?.sources)) return null;

  const sources = payload.sources
    .map((raw): CatalogSourceInput | null =>
      typeof raw === "object" && raw !== null ? (raw as CatalogSourceInput) : null,
    )
    .filter((source): source is CatalogSourceInput => source !== null)
    .map((source) => {
      const id = sanitizeText(source.id);
      const name = sanitizeText(source.name);
      const kind = sanitizeText(source.kind);
      const pluginId = sanitizeText(source.pluginId);
      if (!id || !name || !kind || !pluginId) return null;
      return {
        id,
        name,
        kind,
        pluginId,
        toolCount: sanitizeToolCount(source.toolCount),
      };
    })
    .filter((source): source is NonNullable<typeof source> => source !== null)
    .slice(0, 500);

  return { deviceId, sources };
};

const persistCatalog = (auth: DeviceAuth, request: Request) =>
  Effect.gen(function* () {
    const payload = yield* Effect.promise(() => parseCatalogPayload(request));
    if (!payload) return json({ error: "invalid_request" }, { status: 400 });

    const { sql } = yield* DbService;
    const now = new Date();
    yield* Effect.promise(() =>
      sql.begin(async (tx) => {
        await tx`
          delete from source_catalog
          where organization_id = ${auth.organizationId}
            and device_id = ${payload.deviceId}
        `;

        for (const source of payload.sources) {
          await tx`
            insert into source_catalog (
              organization_id,
              device_id,
              source_id,
              plugin_id,
              kind,
              name,
              tool_count,
              local_available,
              remote_available,
              updated_at
            ) values (
              ${auth.organizationId},
              ${payload.deviceId},
              ${source.id},
              ${source.pluginId},
              ${source.kind},
              ${source.name},
              ${source.toolCount},
              ${true},
              ${false},
              ${now}
            )
          `;
        }
      }),
    );

    return json({ ok: true, sourceCount: payload.sources.length });
  }).pipe(
    Effect.provide(SharedServices),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error("[devices] catalog sync failed", error);
        return json({ error: "catalog_sync_failed" }, { status: 500 });
      }),
    ),
  );

const listCatalog = (auth: DeviceAuth) =>
  Effect.gen(function* () {
    const stub = deviceStubForOrganization(auth.organizationId);
    if (!stub) return json({ error: "device_session_unavailable" }, { status: 503 });

    const statusResponse = yield* Effect.promise(() => stub.fetch("https://device-session/status"));
    const status = (yield* Effect.promise(() =>
      statusResponse.json().catch(() => null),
    )) as DeviceStatus | null;
    const onlineDeviceIds = new Set(
      (status?.devices ?? []).filter((device) => device.online).map((device) => device.deviceId),
    );
    if (onlineDeviceIds.size === 0) return json({ sources: [] });

    const { sql } = yield* DbService;
    const rows = yield* Effect.promise(
      () => sql<CatalogRow[]>`
      select source_id, name, kind, plugin_id, max(tool_count)::int as tool_count
      from source_catalog
      where organization_id = ${auth.organizationId}
        and device_id in ${sql(Array.from(onlineDeviceIds))}
        and local_available = true
      group by source_id, name, kind, plugin_id
      order by source_id asc
    `,
    );

    return json({
      sources: rows.map((row) => ({
        id: row.source_id,
        name: row.name,
        kind: row.kind,
        pluginId: row.plugin_id,
        toolCount: row.tool_count,
        localAvailable: true,
      })),
    });
  }).pipe(
    Effect.provide(SharedServices),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error("[devices] catalog list failed", error);
        return json({ error: "catalog_list_failed" }, { status: 500 });
      }),
    ),
  );

export const deviceFetch = async (request: Request): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/devices/")) return null;

  const auth = await Effect.runPromise(authenticateDeviceRequest(request));
  if (!auth) return json({ error: "unauthorized" }, { status: 401 });

  if (url.pathname === "/api/devices/catalog") {
    if (request.method === "GET") return Effect.runPromise(listCatalog(auth));
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
    return Effect.runPromise(persistCatalog(auth, request));
  }

  const stub = deviceStubForOrganization(auth.organizationId);
  if (!stub) return json({ error: "device_session_unavailable" }, { status: 503 });

  const headers = new Headers(request.headers);
  headers.set(INTERNAL_USER_ID_HEADER, auth.userId);
  headers.set(INTERNAL_ORGANIZATION_ID_HEADER, auth.organizationId);
  headers.set(INTERNAL_ORGANIZATION_NAME_HEADER, auth.organizationName);

  const target = new URL(request.url);
  target.pathname = target.pathname.replace(/^\/api\/devices/, "") || "/";

  return stub.fetch(new Request(target, { headers, method: request.method, body: request.body }));
};

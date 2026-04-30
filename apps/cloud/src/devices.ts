import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { authorizeOrganization } from "./auth/authorize-organization";
import { WorkOSAuth } from "./auth/workos";
import { SharedServices } from "./api/layers";

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

export const deviceFetch = async (request: Request): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== "/api/devices/connect" && url.pathname !== "/api/devices/status") {
    return null;
  }

  const auth = await Effect.runPromise(authenticateDeviceRequest(request));
  if (!auth) return json({ error: "unauthorized" }, { status: 401 });

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

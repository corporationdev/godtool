import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { createScopedExecutor } from "./services/executor";
import { SharedServices } from "./api/layers";

const COMPOSIO_PROXY_URL = "https://backend.composio.dev/api/v3/tools/execute/proxy";

export type ComposioBrokerAuth = {
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName: string;
};

type BrokerTokenPayload = ComposioBrokerAuth & {
  readonly connectionId: string;
  readonly exp: number;
};

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

const textEncoder = new TextEncoder();

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const base64UrlDecode = (value: string): Uint8Array | null => {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

const brokerSecret = (): string =>
  (env as Env & { COMPOSIO_BROKER_SECRET?: string }).COMPOSIO_BROKER_SECRET ||
  env.WORKOS_COOKIE_PASSWORD;

const hmac = async (data: string): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(brokerSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(data)));
};

export const createComposioBrokerToken = async (
  auth: ComposioBrokerAuth,
  connectionId: string,
): Promise<string> => {
  const payload: BrokerTokenPayload = {
    ...auth,
    connectionId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
  };
  const body = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
  const sig = base64UrlEncode(await hmac(body));
  return `${body}.${sig}`;
};

const verifyComposioBrokerToken = async (token: string): Promise<BrokerTokenPayload | null> => {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = base64UrlEncode(await hmac(body));
  if (expected !== sig) return null;
  const decoded = base64UrlDecode(body);
  if (!decoded) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(decoded)) as BrokerTokenPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.userId || !payload.organizationId || !payload.connectionId) return null;
    return payload;
  } catch {
    return null;
  }
};

const bearerToken = (request: Request): string | null => {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
};

const composioProxyRequest = async (
  apiKey: string,
  connectedAccountId: string,
  payload: Record<string, unknown>,
) => {
  const response = await fetch(COMPOSIO_PROXY_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...payload,
      connected_account_id: connectedAccountId,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" && body && "message" in body
        ? String((body as { message?: unknown }).message)
        : `Composio proxy failed: ${response.status}`;
    return json({ error: message }, { status: response.status });
  }
  return json(body);
};

export const composioProxyFetch = async (request: Request): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== "/api/composio-proxy/http" && url.pathname !== "/api/composio-proxy/raw") {
    return null;
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });

  const token = bearerToken(request);
  if (!token) return json({ error: "unauthorized" }, { status: 401 });
  const auth = await verifyComposioBrokerToken(token);
  if (!auth) return json({ error: "unauthorized" }, { status: 401 });

  const apiKey = (env as Env & { COMPOSIO_API_KEY?: string }).COMPOSIO_API_KEY;
  if (!apiKey) return json({ error: "managed_auth_not_configured" }, { status: 503 });

  return Effect.runPromise(
    Effect.gen(function* () {
      const executor = yield* createScopedExecutor(
        auth.userId,
        auth.organizationId,
        auth.organizationName,
      );
      const connection = yield* executor.connections.get(auth.connectionId);
      if (!connection || !connection.provider.endsWith("-composio")) {
        return json({ error: "connection_not_found" }, { status: 404 });
      }
      const connectedAccountId = connection.providerState?.connectedAccountId;
      if (typeof connectedAccountId !== "string" || !connectedAccountId) {
        return json({ error: "connection_not_ready" }, { status: 409 });
      }
      const payload = (yield* Effect.promise(() => request.json().catch(() => null))) as
        | Record<string, unknown>
        | null;
      if (!payload || typeof payload.endpoint !== "string" || typeof payload.method !== "string") {
        return json({ error: "invalid_request" }, { status: 400 });
      }
      return yield* Effect.promise(() => composioProxyRequest(apiKey, connectedAccountId, payload));
    }).pipe(
      Effect.provide(SharedServices),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.error("[composio-proxy] request failed", error);
          return json({ error: "managed_auth_proxy_failed" }, { status: 500 });
        }),
      ),
    ),
  );
};

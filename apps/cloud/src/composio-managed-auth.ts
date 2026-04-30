import { env } from "cloudflare:workers";
import { Effect } from "effect";

import {
  createComposioConnectLink,
  ensureComposioManagedAuthConfig,
  executeComposioProxy,
  getComposioConnectedAccount,
  type ManagedHttpRequest,
} from "@executor/plugin-managed-auth";

import { authorizeOrganization } from "./auth/authorize-organization";
import { WorkOSAuth } from "./auth/workos";
import { SharedServices } from "./api/protected-layers";
import { AutumnService } from "./services/autumn";

type Placement = "local" | "cloud";

type ConnectStatePayload = {
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly app: string;
  readonly authConfigId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly placement: Placement;
  readonly channel: string;
  readonly desktopCallbackUrl?: string;
  readonly exp: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

const html = (body: string, init?: ResponseInit) =>
  new Response(body, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...init?.headers,
    },
  });

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

const signingSecret = (): string =>
  (env as Env & { COMPOSIO_BROKER_SECRET?: string }).COMPOSIO_BROKER_SECRET ||
  env.WORKOS_COOKIE_PASSWORD;

const hmac = async (data: string): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
};

const signPayload = async (payload: Record<string, unknown>): Promise<string> => {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = base64UrlEncode(await hmac(body));
  return `${body}.${sig}`;
};

const verifyPayload = async <T extends Record<string, unknown>>(
  token: string,
): Promise<T | null> => {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  if (base64UrlEncode(await hmac(body)) !== sig) return null;
  const decoded = base64UrlDecode(body);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoder.decode(decoded)) as T;
    if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const callbackHtml = (channel: string, payload: unknown): string => `<!doctype html>
<html>
<head><meta charset="utf-8"><title>GOD TOOL</title></head>
<body>
<script>
  const message = ${JSON.stringify({ channel, payload })};
  try { window.opener && window.opener.postMessage(message, "*"); } catch {}
  try { window.close(); } catch {}
</script>
</body>
</html>`;

const desktopCallbackHtml = (callbackUrl: string, payload: unknown): string => `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>GOD TOOL</title></head>
<body>
<form id="callback" method="post" action="${callbackUrl}">
  <input type="hidden" name="payload" value="${String(JSON.stringify(payload)).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" />
</form>
<script>
  try { document.getElementById("callback").submit(); } catch {}
</script>
</body>
</html>`;

const requireManagedAuth = (organizationId: string) =>
  Effect.gen(function* () {
    const autumn = yield* AutumnService;
    const allowed = yield* autumn.isFeatureAllowed(organizationId, "managed-auth");
    return allowed ? null : json({ error: "upgrade_required" }, { status: 402 });
  });

const composioEntityId = (organizationId: string, userId: string) => `${organizationId}:${userId}`;

const startConnect = (request: Request) =>
  Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    const session = yield* workos.authenticateRequest(request);
    if (!session?.organizationId) return json({ error: "unauthorized" }, { status: 401 });
    const org = yield* authorizeOrganization(session.userId, session.organizationId);
    if (!org) return json({ error: "forbidden" }, { status: 403 });
    const upgradeRequired = yield* requireManagedAuth(org.id);
    if (upgradeRequired) return upgradeRequired;

    const apiKey = env.COMPOSIO_API_KEY;
    if (!apiKey) return json({ error: "managed_auth_not_configured" }, { status: 503 });

    const body = (yield* Effect.promise(() => request.json().catch(() => null))) as {
      readonly app?: unknown;
      readonly provider?: unknown;
      readonly placement?: unknown;
      readonly connectionId?: unknown;
      readonly channel?: unknown;
      readonly desktopCallbackUrl?: unknown;
    } | null;
    const app = typeof body?.app === "string" ? body.app.trim() : "";
    const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
    const placement = body?.placement === "local" ? "local" : "cloud";
    const connectionId =
      typeof body?.connectionId === "string" && body.connectionId.length > 0
        ? body.connectionId
        : `composio-${crypto.randomUUID()}`;
    const channel =
      typeof body?.channel === "string" && body.channel.length > 0
        ? body.channel
        : "godtool:composio";
    const desktopCallbackUrl =
      typeof body?.desktopCallbackUrl === "string" && body.desktopCallbackUrl.length > 0
        ? body.desktopCallbackUrl
        : undefined;
    if (!app || !provider) return json({ error: "invalid_request" }, { status: 400 });

    const authConfigId = yield* Effect.promise(() => ensureComposioManagedAuthConfig(apiKey, app));
    const state = yield* Effect.promise(() =>
      signPayload({
        userId: session.userId,
        organizationId: org.id,
        organizationName: org.name,
        app,
        authConfigId,
        connectionId,
        provider,
        placement,
        channel,
        ...(desktopCallbackUrl ? { desktopCallbackUrl } : {}),
        exp: Math.floor(Date.now() / 1000) + 10 * 60,
      } satisfies ConnectStatePayload),
    );
    const callbackUrl = new URL("/api/managed-auth/composio/callback", request.url);
    callbackUrl.searchParams.set("state", state);
    const link = yield* Effect.promise(() =>
      createComposioConnectLink({
        apiKey,
        app,
        authConfigId,
        userId: composioEntityId(org.id, session.userId),
        alias: `${org.name} ${app} ${connectionId}`,
        callbackUrl: callbackUrl.toString(),
      }),
    );
    return json({ redirectUrl: link.redirectUrl, connectionId, authConfigId });
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error("[managed-auth] start failed", error);
        return json({ error: "managed_auth_start_failed" }, { status: 500 });
      }),
    ),
  );

const completeConnect = (request: Request) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    if (!state) return html("Missing state", { status: 400 });
    const payload = yield* Effect.promise(() => verifyPayload<ConnectStatePayload>(state));
    if (!payload) return html("Invalid state", { status: 400 });
    const connectedAccountId = url.searchParams.get("connected_account_id");
    if (!connectedAccountId) return html("Missing connected account", { status: 400 });

    const apiKey = env.COMPOSIO_API_KEY;
    if (!apiKey) return html("Managed auth is not configured", { status: 503 });

    const account = yield* Effect.promise(() =>
      getComposioConnectedAccount(apiKey, connectedAccountId),
    );
    const result = {
        ok: true,
        managedAuth: {
          kind: "composio",
          app: payload.app,
          authConfigId: payload.authConfigId,
          connectionId: payload.connectionId,
        },
        managedConnection: {
          connectionId: payload.connectionId,
          provider: payload.provider,
          identityLabel: account.displayName ?? account.appName ?? payload.app,
          connectedAccountId,
        },
      };
    return html(
      payload.desktopCallbackUrl
        ? desktopCallbackHtml(payload.desktopCallbackUrl, result)
        : callbackHtml(payload.channel, result),
    );
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error("[managed-auth] callback failed", error);
        return html("Managed auth failed", { status: 500 });
      }),
    ),
  );

const proxy = (request: Request) =>
  Effect.gen(function* () {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });

    const workos = yield* WorkOSAuth;
    const session = yield* workos.authenticateRequest(request);
    if (!session?.organizationId) return json({ error: "unauthorized" }, { status: 401 });
    const org = yield* authorizeOrganization(session.userId, session.organizationId);
    if (!org) return json({ error: "forbidden" }, { status: 403 });
    const upgradeRequired = yield* requireManagedAuth(org.id);
    if (upgradeRequired) return upgradeRequired;

    const apiKey = env.COMPOSIO_API_KEY;
    if (!apiKey) return json({ error: "managed_auth_not_configured" }, { status: 503 });

    const payload = (yield* Effect.promise(() =>
      request.json().catch(() => null),
    )) as { readonly connectedAccountId?: unknown; readonly request?: unknown } | null;
    const connectedAccountId =
      typeof payload?.connectedAccountId === "string" ? payload.connectedAccountId : "";
    const managedRequest = payload?.request as ManagedHttpRequest | undefined;
    if (
      !connectedAccountId ||
      !managedRequest ||
      typeof managedRequest.endpoint !== "string" ||
      typeof managedRequest.method !== "string"
    ) {
      return json({ error: "invalid_request" }, { status: 400 });
    }

    const account = yield* Effect.promise(() =>
      getComposioConnectedAccount(apiKey, connectedAccountId),
    );
    if (account.userId !== composioEntityId(org.id, session.userId)) {
      return json({ error: "forbidden" }, { status: 403 });
    }

    const result = yield* Effect.promise(() =>
      executeComposioProxy({
        apiKey,
        connectedAccountId,
        request: managedRequest,
      }),
    );
    return json(result);
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error("[managed-auth] proxy failed", error);
        return json({ error: "managed_auth_proxy_failed" }, { status: 500 });
      }),
    ),
  );

export const composioManagedAuthFetch = async (request: Request): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname === "/api/managed-auth/composio/start" && request.method === "POST") {
    return Effect.runPromise(startConnect(request).pipe(Effect.provide(SharedServices)));
  }
  if (url.pathname === "/api/managed-auth/composio/callback" && request.method === "GET") {
    return Effect.runPromise(completeConnect(request).pipe(Effect.provide(SharedServices)));
  }
  if (url.pathname === "/api/managed-auth/composio/proxy") {
    return Effect.runPromise(proxy(request).pipe(Effect.provide(SharedServices)));
  }
  return null;
};

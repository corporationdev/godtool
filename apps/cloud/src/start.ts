import { env } from "cloudflare:workers";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { handleApiRequest } from "./api";
import { deviceFetch } from "./devices";
import { mcpFetch } from "./mcp";
import { sourceSyncFetch } from "./source-sync";
import { composioProxyFetch } from "./composio-proxy";

// ---------------------------------------------------------------------------
// MCP middleware — routes /mcp and /.well-known/* to the MCP handler
// ---------------------------------------------------------------------------

const mcpRequestMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
    if (pathname === "/mcp" || pathname.startsWith("/.well-known/")) {
      const response = await mcpFetch(request);
      if (response) return response;
    }
    return next();
  },
);

// ---------------------------------------------------------------------------
// Sentry tunnel — the browser SDK POSTs envelopes to /api/sentry-tunnel
// (configured in routes/__root.tsx) to dodge adblockers and CSP. We parse
// the envelope header to recover the DSN, validate against our own, and
// forward the body to Sentry's ingest endpoint. See
// https://docs.sentry.io/platforms/javascript/troubleshooting/#using-the-tunnel-option
// ---------------------------------------------------------------------------

const sentryTunnelMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
    if (pathname !== "/api/sentry-tunnel" || request.method !== "POST") {
      return next();
    }

    const configuredDsn = (env as { SENTRY_DSN?: string }).SENTRY_DSN;
    if (!configuredDsn) return new Response(null, { status: 204 });

    try {
      const envelope = await request.text();
      const firstLine = envelope.slice(0, envelope.indexOf("\n"));
      const header = JSON.parse(firstLine) as { dsn?: string };
      if (!header.dsn) return new Response("missing dsn", { status: 400 });

      const envelopeDsn = new URL(header.dsn);
      const ourDsn = new URL(configuredDsn);
      if (envelopeDsn.host !== ourDsn.host || envelopeDsn.pathname !== ourDsn.pathname) {
        return new Response("dsn mismatch", { status: 400 });
      }

      const projectId = envelopeDsn.pathname.replace(/^\//, "");
      const ingestUrl = `https://${envelopeDsn.host}/api/${projectId}/envelope/`;
      return fetch(ingestUrl, {
        method: "POST",
        body: envelope,
        headers: { "Content-Type": "application/x-sentry-envelope" },
      });
    } catch {
      return new Response("bad envelope", { status: 400 });
    }
  },
);

// ---------------------------------------------------------------------------
// Device middleware — authenticated desktop presence websocket + status API
// ---------------------------------------------------------------------------

const deviceRequestMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
    if (pathname.startsWith("/api/devices/")) {
      const response = await deviceFetch(request);
      if (response) return response;
    }
    return next();
  },
);

// ---------------------------------------------------------------------------
// Source sync middleware — routes source placement operations before /api/*
// ---------------------------------------------------------------------------

const sourceSyncRequestMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
    if (pathname.startsWith("/api/source-sync/")) {
      const response = await sourceSyncFetch(request);
      if (response) return response;
    }
    return next();
  },
);

const composioProxyRequestMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
    if (pathname.startsWith("/api/composio-proxy/")) {
      const response = await composioProxyFetch(request);
      if (response) return response;
    }
    return next();
  },
);

// ---------------------------------------------------------------------------
// API middleware — routes /api/* to the Effect HTTP layer
// ---------------------------------------------------------------------------

const apiRequestMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const url = new URL(request.url);
      url.pathname = url.pathname.replace(/^\/api/, "");
      return handleApiRequest(new Request(url, request));
    }
    return next();
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [
    mcpRequestMiddleware,
    sentryTunnelMiddleware,
    deviceRequestMiddleware,
    sourceSyncRequestMiddleware,
    composioProxyRequestMiddleware,
    apiRequestMiddleware,
  ],
}));

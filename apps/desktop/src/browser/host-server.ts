import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { BrowserSessionManager } from "./session-manager";
import type { BrowserBounds, EnsureBrowserSessionInput } from "./types";

interface BrowserHostServerOptions {
  readonly port: number;
  readonly manager: BrowserSessionManager;
}

const readJson = async <T>(request: IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  return (raw ? JSON.parse(raw) : {}) as T;
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  response.end(JSON.stringify(body));
};

const sendError = (response: ServerResponse, status: number, error: unknown): void => {
  sendJson(response, status, {
    error: error instanceof Error ? error.message : String(error),
  });
};

export const startBrowserHostServer = async (
  options: BrowserHostServerOptions,
): Promise<Server> => {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        sendJson(response, 204, null);
        return;
      }

      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      const parts = url.pathname.split("/").filter(Boolean);

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/sessions") {
        sendJson(response, 200, { sessions: options.manager.list() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/sessions/ensure") {
        const input = await readJson<EnsureBrowserSessionInput>(request);
        const session = await options.manager.ensure(input);
        sendJson(response, 200, { session });
        return;
      }

      if (parts[0] === "sessions" && parts[1]) {
        const sessionId = decodeURIComponent(parts[1]);
        const action = parts[2];

        if (request.method === "POST" && action === "touch") {
          const input = await readJson<{ readonly busy?: boolean; readonly pinned?: boolean }>(
            request,
          );
          const session = await options.manager.touch(sessionId, input);
          sendJson(response, 200, { session });
          return;
        }

        if (request.method === "POST" && action === "show") {
          const input = await readJson<{ readonly bounds: BrowserBounds }>(request);
          const session = options.manager.show(sessionId, input.bounds);
          sendJson(response, 200, { session });
          return;
        }

        if (request.method === "POST" && action === "bounds") {
          const input = await readJson<{ readonly bounds: BrowserBounds }>(request);
          const session = options.manager.setBounds(sessionId, input.bounds);
          sendJson(response, 200, { session });
          return;
        }

        if (request.method === "POST" && action === "hide") {
          const session = options.manager.hide(sessionId);
          sendJson(response, 200, { session });
          return;
        }

        if (request.method === "POST" && action === "navigate") {
          const input = await readJson<{ readonly url: string }>(request);
          const session = await options.manager.navigate(sessionId, input.url);
          sendJson(response, 200, { session });
          return;
        }

        if (request.method === "POST" && action === "back") {
          const session = await options.manager.goBack(sessionId);
          sendJson(response, 200, { session });
          return;
        }

        if (request.method === "POST" && action === "forward") {
          const session = await options.manager.goForward(sessionId);
          sendJson(response, 200, { session });
          return;
        }

        if (request.method === "POST" && action === "reload") {
          const session = await options.manager.reload(sessionId);
          sendJson(response, 200, { session });
          return;
        }

        if (request.method === "POST" && action === "close") {
          options.manager.close(sessionId);
          sendJson(response, 200, { ok: true });
          return;
        }
      }

      sendError(response, 404, "Not found");
    } catch (error) {
      sendError(response, 500, error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
};

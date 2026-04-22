// @ts-nocheck

import { unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 4789;

type ExecuteRequest = {
  readonly moduleSource?: string;
};

const parseArgs = (argv: string[]) => {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const nextValue = argv[index + 1];

    if (token === "--host") {
      if (!nextValue) {
        throw new Error("--host requires a value.");
      }
      host = nextValue;
      index += 1;
      continue;
    }

    if (token === "--port") {
      if (!nextValue) {
        throw new Error("--port requires a value.");
      }

      const parsedPort = Number.parseInt(nextValue, 10);
      if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
        throw new Error(`Invalid --port value "${nextValue}".`);
      }

      port = parsedPort;
      index += 1;
    }
  }

  return { host, port };
};

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

const badRequestResponse = (message: string): Response =>
  jsonResponse(
    {
      error: message,
      logs: [],
      result: null,
    },
    { status: 400 },
  );

const runServer = async (): Promise<void> => {
  const { host, port } = parseArgs(process.argv.slice(2));

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);

      if (request.method === "GET" && pathname === "/health") {
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && pathname === "/execute") {
        let payload: ExecuteRequest;
        try {
          payload = (await request.json()) as ExecuteRequest;
        } catch {
          return badRequestResponse("Invalid execute request JSON.");
        }

        if (
          typeof payload.moduleSource !== "string" ||
          payload.moduleSource.trim().length === 0
        ) {
          return badRequestResponse("moduleSource is required.");
        }

        const modulePath = `/tmp/godtool-exec-${crypto.randomUUID()}.mjs`;

        try {
          await Bun.write(modulePath, payload.moduleSource);
          const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}`;
          const loaded = await import(moduleUrl);

          if (typeof loaded.default !== "function") {
            throw new Error("Sandbox execute module must export a default function.");
          }

          return jsonResponse(await loaded.default());
        } catch (error) {
          return jsonResponse(
            {
              error: error instanceof Error ? error.message : String(error),
              logs: [],
              result: null,
            },
            { status: 500 },
          );
        } finally {
          await unlink(modulePath).catch(() => undefined);
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(
    JSON.stringify({
      host,
      port: server.port,
      type: "sandbox-runtime-ready",
    }),
  );
};

try {
  await runServer();
} catch (error) {
  console.error(error);
  process.exit(1);
}

export {};

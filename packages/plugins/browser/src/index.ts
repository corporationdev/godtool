import { spawn } from "node:child_process";
import { Effect, Schema } from "effect";

import { definePlugin } from "@executor/sdk";

export interface BrowserSessionSnapshot {
  readonly id: string;
  readonly agentId: string;
  readonly url: string;
  readonly title: string;
  readonly busy: boolean;
  readonly pinned: boolean;
  readonly visible: boolean;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly targetId: string | null;
  readonly cdpUrl: string;
  readonly webSocketDebuggerUrl: string | null;
}

export interface BrowserPluginConfig {
  readonly hostUrl?: string;
  readonly agentBrowserPath?: string;
}

interface BrowserHostResponse<T> {
  readonly session?: BrowserSessionSnapshot;
  readonly sessions?: readonly BrowserSessionSnapshot[];
  readonly ok?: boolean;
  readonly error?: string;
  readonly value?: T;
}

const EnsureSessionArgs = Schema.Struct({
  agentId: Schema.String,
  url: Schema.optional(Schema.String),
  busy: Schema.optional(Schema.Boolean),
  pinned: Schema.optional(Schema.Boolean),
});

const TouchSessionArgs = Schema.Struct({
  sessionId: Schema.String,
  busy: Schema.optional(Schema.Boolean),
  pinned: Schema.optional(Schema.Boolean),
});

const CloseSessionArgs = Schema.Struct({
  sessionId: Schema.String,
});

const AgentBrowserArgs = Schema.Struct({
  agentId: Schema.String,
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
});

const emptyInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

const ensureInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId"],
  properties: {
    agentId: { type: "string" },
    url: { type: "string" },
    busy: { type: "boolean" },
    pinned: { type: "boolean" },
  },
};

const touchInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId"],
  properties: {
    sessionId: { type: "string" },
    busy: { type: "boolean" },
    pinned: { type: "boolean" },
  },
};

const closeInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId"],
  properties: {
    sessionId: { type: "string" },
  },
};

const runInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "command"],
  properties: {
    agentId: { type: "string" },
    command: { type: "string" },
    args: { type: "array", items: { type: "string" } },
  },
};

const decodeEnsureSessionArgs = Schema.decodeUnknownSync(EnsureSessionArgs);
const decodeTouchSessionArgs = Schema.decodeUnknownSync(TouchSessionArgs);
const decodeCloseSessionArgs = Schema.decodeUnknownSync(CloseSessionArgs);
const decodeAgentBrowserArgs = Schema.decodeUnknownSync(AgentBrowserArgs);

const hostUrlFromConfig = (config?: BrowserPluginConfig): string =>
  (config?.hostUrl ?? process.env.EXECUTOR_BROWSER_HOST_URL ?? "http://127.0.0.1:14789").replace(
    /\/+$/,
    "",
  );

const agentBrowserPathFromConfig = (config?: BrowserPluginConfig): string =>
  config?.agentBrowserPath ?? process.env.EXECUTOR_AGENT_BROWSER_PATH ?? "agent-browser";

const request = async <T>(
  hostUrl: string,
  path: string,
  init?: RequestInit,
): Promise<BrowserHostResponse<T>> => {
  const response = await fetch(`${hostUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const data = (await response.json()) as BrowserHostResponse<T>;
  if (!response.ok) {
    throw new Error(data.error ?? `Browser host request failed: ${response.status}`);
  }
  return data;
};

const runAgentBrowser = (
  binary: string,
  session: BrowserSessionSnapshot,
  command: string,
  args: readonly string[],
) =>
  Effect.async<
    {
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly stderr: string;
    },
    Error
  >((resume) => {
    const cdpArg = session.webSocketDebuggerUrl ?? session.cdpUrl;
    const child = spawn(binary, ["--cdp", cdpArg, command, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (cause) => {
      resume(Effect.fail(cause));
    });
    child.on("close", (exitCode) => {
      resume(Effect.succeed({ exitCode, stdout, stderr }));
    });
  });

export const browserPlugin = definePlugin((config?: BrowserPluginConfig) => ({
  id: "browser" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "browser",
      kind: "browser",
      name: "Browser",
      canRemove: false,
      tools: [
        {
          name: "ensureSession",
          description: "Create or reuse the browser session assigned to an agent.",
          inputSchema: ensureInputSchema,
          handler: ({ args }) =>
            Effect.tryPromise(async () => {
              const input = decodeEnsureSessionArgs(args);
              const data = await request<never>(hostUrlFromConfig(config), "/sessions/ensure", {
                method: "POST",
                body: JSON.stringify(input),
              });
              return data.session;
            }),
        },
        {
          name: "listSessions",
          description: "List Electron browser sessions currently managed by the desktop app.",
          inputSchema: emptyInputSchema,
          handler: () =>
            Effect.tryPromise(async () => {
              const data = await request<never>(hostUrlFromConfig(config), "/sessions");
              return data.sessions ?? [];
            }),
        },
        {
          name: "touchSession",
          description: "Mark a browser session as in use or idle.",
          inputSchema: touchInputSchema,
          handler: ({ args }) =>
            Effect.tryPromise(async () => {
              const input = decodeTouchSessionArgs(args);
              const data = await request<never>(
                hostUrlFromConfig(config),
                `/sessions/${encodeURIComponent(input.sessionId)}/touch`,
                {
                  method: "POST",
                  body: JSON.stringify({ busy: input.busy, pinned: input.pinned }),
                },
              );
              return data.session;
            }),
        },
        {
          name: "closeSession",
          description: "Close a browser session by id.",
          inputSchema: closeInputSchema,
          handler: ({ args }) =>
            Effect.tryPromise(async () => {
              const input = decodeCloseSessionArgs(args);
              await request<never>(
                hostUrlFromConfig(config),
                `/sessions/${encodeURIComponent(input.sessionId)}/close`,
                { method: "POST", body: "{}" },
              );
              return { ok: true };
            }),
        },
        {
          name: "runAgentBrowser",
          description: "Run one agent-browser command against the browser assigned to an agent.",
          inputSchema: runInputSchema,
          handler: ({ args }) =>
            Effect.gen(function* () {
              const input = decodeAgentBrowserArgs(args);
              const hostUrl = hostUrlFromConfig(config);
              const ensured = yield* Effect.tryPromise(async () => {
                const data = await request<never>(hostUrl, "/sessions/ensure", {
                  method: "POST",
                  body: JSON.stringify({ agentId: input.agentId, busy: true }),
                });
                if (!data.session) throw new Error("Browser host did not return a session");
                return data.session;
              });
              try {
                return yield* runAgentBrowser(
                  agentBrowserPathFromConfig(config),
                  ensured,
                  input.command,
                  input.args ?? [],
                );
              } finally {
                yield* Effect.promise(() =>
                  request<never>(hostUrl, `/sessions/${encodeURIComponent(ensured.id)}/touch`, {
                    method: "POST",
                    body: JSON.stringify({ busy: false }),
                  }).then(() => undefined),
                ).pipe(Effect.orElseSucceed(() => undefined));
              }
            }),
        },
      ],
    },
  ],
}));

export type BrowserPlugin = ReturnType<typeof browserPlugin>;

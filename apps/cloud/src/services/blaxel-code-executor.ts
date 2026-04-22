import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import {
  recoverExecutionBody,
  type CodeExecutor,
  type ExecuteResult,
  type SandboxToolInvoker,
} from "@executor/codemode-core";

import type { DrizzleDb } from "./db";

export const INTERNAL_TOOL_CALL_PATH_PREFIX = "/mcp/internal/tool-call/";
export const SANDBOX_TOOL_CALL_TOKEN_HEADER = "x-executor-callback-token";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export class BlaxelExecutionError extends Data.TaggedError("BlaxelExecutionError")<{
  readonly message: string;
}> {}

type ActiveRunRegistry = {
  readonly register: (input: {
    readonly runId: string;
    readonly token: string;
    readonly toolInvoker: SandboxToolInvoker;
  }) => void;
  readonly unregister: (runId: string) => void;
};

type BlaxelCodeExecutorOptions = {
  readonly activeRuns: ActiveRunRegistry;
  readonly callbackOrigin: string;
  readonly db: DrizzleDb;
  readonly organizationId: string;
  readonly sessionId: string;
  readonly timeoutMs?: number;
};

const renderErrorMessage = (value: unknown): string => {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }

  return String(value);
};

const readResponseText = async (response: {
  readonly text?: () => Promise<string>;
}): Promise<string> => {
  if (typeof response.text !== "function") {
    return "";
  }

  return response.text();
};

const buildCallbackUrl = (origin: string, sessionId: string): string =>
  new URL(`${INTERNAL_TOOL_CALL_PATH_PREFIX}${encodeURIComponent(sessionId)}`, origin).toString();

const buildExecutorModule = (args: {
  readonly callbackToken: string;
  readonly callbackUrl: string;
  readonly code: string;
  readonly runId: string;
  readonly timeoutMs: number;
}): string => {
  const body = recoverExecutionBody(args.code);

  return [
    `const __callbackUrl = ${JSON.stringify(args.callbackUrl)};`,
    `const __callbackToken = ${JSON.stringify(args.callbackToken)};`,
    `const __runId = ${JSON.stringify(args.runId)};`,
    "",
    "export default async function execute() {",
    "  const __logs = [];",
    "  const __originalConsole = {",
    "    log: console.log,",
    "    warn: console.warn,",
    "    error: console.error,",
    "  };",
    "  console.log = (...a) => { __logs.push(a.map(String).join(\" \")); };",
    "  console.warn = (...a) => { __logs.push(\"[warn] \" + a.map(String).join(\" \")); };",
    "  console.error = (...a) => { __logs.push(\"[error] \" + a.map(String).join(\" \")); };",
    "  const __renderMessage = (value) => {",
    "    if (typeof value === 'string') return value;",
    "    if (value instanceof Error) return value.message;",
    "    if (value && typeof value === 'object' && typeof value.message === 'string') {",
    "      return value.message;",
    "    }",
    "    if (typeof value === 'undefined') return 'Unknown error';",
    "    if (value && typeof value === 'object') {",
    "      try {",
    "        return JSON.stringify(value);",
    "      } catch {",
    "        return String(value);",
    "      }",
    "    }",
    "    return String(value);",
    "  };",
    "  const __callTool = async (toolPath, args) => {",
    "    const response = await fetch(__callbackUrl, {",
    "      method: 'POST',",
    "      headers: {",
    "        'content-type': 'application/json',",
    `        ${JSON.stringify(SANDBOX_TOOL_CALL_TOKEN_HEADER)}: __callbackToken,`,
    "      },",
    "      body: JSON.stringify({ runId: __runId, path: toolPath, args }),",
    "    });",
    "    const raw = await response.text();",
    "    let data = {};",
    "    if (raw) {",
    "      try {",
    "        data = JSON.parse(raw);",
    "      } catch {",
    "        throw new Error(`Invalid tool callback response (${response.status}): ${raw}`);",
    "      }",
    "    }",
    "    if (!response.ok) {",
    "      throw new Error(data && typeof data === 'object' && data.error && typeof data.error.message === 'string' ? data.error.message : `Tool callback failed with status ${response.status}`);",
    "    }",
    "    if (!data || typeof data !== 'object' || data.ok !== true) {",
    "      throw new Error(data && typeof data === 'object' && data.error && typeof data.error.message === 'string' ? data.error.message : 'Tool callback failed');",
    "    }",
    "    return data.result;",
    "  };",
    "  const __makeToolsProxy = (path = []) => new Proxy(() => undefined, {",
    "    get(_target, prop) {",
    "      if (prop === 'then' || typeof prop === 'symbol') return undefined;",
    "      return __makeToolsProxy([...path, String(prop)]);",
    "    },",
    "    apply(_target, _thisArg, args) {",
    "      const toolPath = path.join('.');",
    "      if (!toolPath) throw new Error('Tool path missing in invocation');",
    "      return __callTool(toolPath, args[0] ?? {});",
    "    },",
    "  });",
    "  const tools = __makeToolsProxy();",
    "  try {",
    "    const result = await Promise.race([",
    "      (async () => {",
    body,
    "      })(),",
    "      new Promise((_, reject) =>",
    `        setTimeout(() => reject(new Error("Execution timed out after ${args.timeoutMs}ms")), ${args.timeoutMs})`,
    "      ),",
    "    ]);",
    "    return { result, logs: __logs };",
    "  } catch (error) {",
    "    return { result: null, error: __renderMessage(error), logs: __logs };",
    "  } finally {",
    "    console.log = __originalConsole.log;",
    "    console.warn = __originalConsole.warn;",
    "    console.error = __originalConsole.error;",
    "  }",
    "}",
  ].join("\n");
};

export const makeBlaxelCodeExecutor = (
  options: BlaxelCodeExecutorOptions,
): CodeExecutor<BlaxelExecutionError> => {
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const callbackUrl = buildCallbackUrl(options.callbackOrigin, options.sessionId);

  return {
    execute: (code: string, toolInvoker: SandboxToolInvoker) =>
      Effect.gen(function* () {
        const runId = `run_${crypto.randomUUID()}`;
        const callbackToken = crypto.randomUUID();
        const moduleSource = buildExecutorModule({
          callbackToken,
          callbackUrl,
          code,
          runId,
          timeoutMs,
        });

        yield* Effect.sync(() => {
          options.activeRuns.register({
            runId,
            token: callbackToken,
            toolInvoker,
          });
        });

        return yield* Effect.tryPromise({
          try: async () => {
            const sandboxesModule = await import("./sandboxes");
            const sandboxes = sandboxesModule.makeSandboxesService(options.db);
            const sandboxHandleProvider = sandboxesModule.makeBlaxelSandboxHandleProvider();
            const ensured = await sandboxes.ensureExecuteRuntimeRunning(options.organizationId);
            const sandbox = await sandboxHandleProvider.getSandboxHandle(
              ensured.sandbox.externalId,
            );
            const response = await sandbox.fetch(sandboxesModule.EXECUTE_RUNTIME_PORT, "/execute", {
              body: JSON.stringify({ moduleSource }),
              headers: {
                "content-type": "application/json",
              },
              method: "POST",
            });
            const raw = await readResponseText(response);

            if (!response.ok) {
              throw new Error(
                raw.trim().length > 0
                  ? `Sandbox execute failed (${response.status}): ${raw}`
                  : `Sandbox execute failed (${response.status})`,
              );
            }

            return JSON.parse(raw) as ExecuteResult;
          },
          catch: (error) =>
            new BlaxelExecutionError({
              message: renderErrorMessage(error),
            }),
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              options.activeRuns.unregister(runId);
            }),
          ),
        );
      }).pipe(
        Effect.withSpan("executor.code.exec.blaxel", {
          attributes: {
            "executor.runtime": "blaxel-sandbox",
            "executor.code.length": code.length,
            "executor.timeout_ms": timeoutMs,
          },
        }),
      ),
  };
};

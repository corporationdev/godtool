import { Deferred, Effect, Fiber, Ref } from "effect";
import type * as Cause from "effect/Cause";

import type {
  Executor,
  InvokeOptions,
  ElicitationResponse,
  ElicitationHandler,
  ElicitationContext,
} from "@executor/sdk";
import { CodeExecutionError } from "@executor/codemode-core";
import type {
  CodeExecutor,
  ExecuteArtifact,
  ExecuteContentBlock,
  ExecuteResult,
  SandboxToolInvoker,
} from "@executor/codemode-core";

import {
  makeExecutorToolInvoker,
  searchTools,
  listExecutorSources,
  describeTool,
} from "./tool-invoker";
import { ExecutionToolError } from "./errors";
import { buildExecuteDescription } from "./description";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionEngineConfig<
  E extends Cause.YieldableError = CodeExecutionError,
> = {
  readonly executor: Executor;
  readonly codeExecutor: CodeExecutor<E>;
};

export type ExecutionResult =
  | { readonly status: "completed"; readonly result: ExecuteResult }
  | { readonly status: "paused"; readonly execution: PausedExecution };

export type PausedExecution = {
  readonly id: string;
  readonly elicitationContext: ElicitationContext;
};

/** Internal representation with Effect runtime state for pause/resume. */
type InternalPausedExecution<E> = PausedExecution & {
  readonly response: Deferred.Deferred<typeof ElicitationResponse.Type>;
  readonly fiber: Fiber.Fiber<ExecuteResult, E>;
  readonly pauseSignalRef: Ref.Ref<Deferred.Deferred<InternalPausedExecution<E>>>;
};

export type ResumeResponse = {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

const MAX_PREVIEW_CHARS = 30_000;
const ARTIFACT_MARKER = "__executorArtifact";
const CONTENT_MARKER = "__executorContent";

const truncate = (value: string, max: number): string =>
  value.length > max
    ? `${value.slice(0, max)}\n... [truncated ${value.length - max} chars]`
    : value;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isContentBlock = (value: unknown): value is ExecuteContentBlock => {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "image" || value.type === "audio") {
    return typeof value.data === "string" && typeof value.mimeType === "string";
  }
  if (value.type === "resource_link") {
    return typeof value.uri === "string" && typeof value.name === "string";
  }
  if (value.type === "resource") {
    return isRecord(value.resource) && typeof value.resource.uri === "string";
  }
  return false;
};

const isArtifactEnvelope = (
  value: unknown,
): value is {
  readonly [ARTIFACT_MARKER]: true;
  readonly artifact: ExecuteArtifact;
  readonly content: ExecuteContentBlock;
} =>
  isRecord(value) &&
  value[ARTIFACT_MARKER] === true &&
  isRecord(value.artifact) &&
  isContentBlock(value.content);

const isContentEnvelope = (
  value: unknown,
): value is { readonly [CONTENT_MARKER]: true; readonly content: ExecuteContentBlock } =>
  isRecord(value) && value[CONTENT_MARKER] === true && isContentBlock(value.content);

const collectAttachedContent = (
  value: unknown,
  seen = new WeakSet<object>(),
): { readonly content: ExecuteContentBlock[]; readonly artifacts: ExecuteArtifact[] } => {
  if (Array.isArray(value)) {
    const content: ExecuteContentBlock[] = [];
    const artifacts: ExecuteArtifact[] = [];
    for (const item of value) {
      const nested = collectAttachedContent(item, seen);
      content.push(...nested.content);
      artifacts.push(...nested.artifacts);
    }
    return { content, artifacts };
  }

  if (!isRecord(value)) return { content: [], artifacts: [] };
  if (seen.has(value)) return { content: [], artifacts: [] };
  seen.add(value);

  const content: ExecuteContentBlock[] = [];
  const artifacts: ExecuteArtifact[] = [];

  if (isArtifactEnvelope(value)) {
    content.push(value.content);
    artifacts.push(value.artifact);
  } else if (isContentEnvelope(value)) {
    content.push(value.content);
  }

  for (const child of Object.values(value)) {
    if (isRecord(child)) {
      const nested = collectAttachedContent(child, seen);
      content.push(...nested.content);
      artifacts.push(...nested.artifacts);
      continue;
    }
    if (Array.isArray(child)) {
      for (const item of child) {
        const nested = collectAttachedContent(item, seen);
        content.push(...nested.content);
        artifacts.push(...nested.artifacts);
      }
    }
  }

  return { content, artifacts };
};

const sanitizeForPreview = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (!isRecord(value)) {
    if (Array.isArray(value)) return value.map((item) => sanitizeForPreview(item, seen));
    return value;
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (isArtifactEnvelope(value)) {
    return {
      attachedArtifact: value.artifact,
    };
  }

  if (isContentEnvelope(value)) {
    return {
      attachedContent: {
        type: value.content.type,
        mimeType:
          "mimeType" in value.content
            ? value.content.mimeType
            : value.content.type === "resource"
              ? value.content.resource.mimeType
              : undefined,
      },
    };
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = Array.isArray(child)
      ? child.map((item) => sanitizeForPreview(item, seen))
      : sanitizeForPreview(child, seen);
  }
  return output;
};

const dedupeContent = (content: readonly ExecuteContentBlock[]): ExecuteContentBlock[] => {
  const seen = new Set<string>();
  const result: ExecuteContentBlock[] = [];
  for (const item of content) {
    const key = JSON.stringify(
      item.type === "image" || item.type === "audio"
        ? { type: item.type, mimeType: item.mimeType, data: item.data.slice(0, 80) }
        : item,
    );
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};

const dedupeArtifacts = (artifacts: readonly ExecuteArtifact[]): ExecuteArtifact[] => {
  const seen = new Set<string>();
  const result: ExecuteArtifact[] = [];
  for (const artifact of artifacts) {
    const key = artifact.uri;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(artifact);
  }
  return result;
};

export const formatExecuteResult = (
  result: ExecuteResult,
): {
  text: string;
  content: ExecuteContentBlock[];
  structured: Record<string, unknown>;
  isError: boolean;
} => {
  const extracted = collectAttachedContent(result.result);
  const content = dedupeContent([...(result.content ?? []), ...extracted.content]);
  const artifacts = dedupeArtifacts([...(result.artifacts ?? []), ...extracted.artifacts]);
  const sanitizedResult = sanitizeForPreview(result.result);
  const resultText =
    sanitizedResult != null
      ? typeof sanitizedResult === "string"
        ? sanitizedResult
        : JSON.stringify(sanitizedResult, null, 2)
      : null;

  const logText = result.logs && result.logs.length > 0 ? result.logs.join("\n") : null;
  const artifactText =
    artifacts.length > 0
      ? `Attached artifacts:\n${artifacts
          .map((artifact) => `- ${artifact.name} (${artifact.mimeType}, ${artifact.size} bytes)`)
          .join("\n")}`
      : null;

  if (result.error) {
    const parts = [
      `Error: ${result.error}`,
      ...(artifactText ? [`\n${artifactText}`] : []),
      ...(logText ? [`\nLogs:\n${logText}`] : []),
    ];
    return {
      text: truncate(parts.join("\n"), MAX_PREVIEW_CHARS),
      content,
      structured: { status: "error", error: result.error, logs: result.logs ?? [], artifacts },
      isError: true,
    };
  }

  const parts = [
    ...(resultText ? [truncate(resultText, MAX_PREVIEW_CHARS)] : []),
    ...(artifactText ? [artifactText] : []),
    ...(!resultText && !artifactText ? ["(no result)"] : []),
    ...(logText ? [`\nLogs:\n${logText}`] : []),
  ];
  return {
    text: parts.join("\n"),
    content,
    structured: {
      status: "completed",
      result: sanitizedResult ?? null,
      logs: result.logs ?? [],
      artifacts,
    },
    isError: false,
  };
};

export const formatPausedExecution = (
  paused: PausedExecution,
): {
  text: string;
  structured: Record<string, unknown>;
} => {
  const req = paused.elicitationContext.request;
  const lines: string[] = [`Execution paused: ${req.message}`];

  if (req._tag === "UrlElicitation") {
    lines.push(`\nOpen this URL in a browser:\n${req.url}`);
    lines.push("\nAfter the browser flow, resume with the executionId below:");
  } else {
    lines.push("\nAsk the user for the requested information before continuing.");
    lines.push("\nResume with the executionId below and a response matching the requested schema:");
    const schema = req.requestedSchema;
    if (schema && Object.keys(schema).length > 0) {
      lines.push(`\nRequested schema:\n${JSON.stringify(schema, null, 2)}`);
    }
  }

  lines.push(`\nexecutionId: ${paused.id}`);

  return {
    text: lines.join("\n"),
    structured: {
      status: "waiting_for_interaction",
      executionId: paused.id,
      interaction: {
        kind: req._tag === "UrlElicitation" ? "url" : "form",
        message: req.message,
        ...(req._tag === "UrlElicitation" ? { url: req.url } : {}),
        ...(req._tag === "FormElicitation" ? { requestedSchema: req.requestedSchema } : {}),
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Full invoker (base + discover + describe)
// ---------------------------------------------------------------------------

const readOptionalLimit = (value: unknown, toolName: string): number | ExecutionToolError => {
  if (value === undefined) {
    return 12;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return new ExecutionToolError({
      message: `${toolName} limit must be a positive number when provided`,
    });
  }

  return Math.floor(value);
};

const makeFullInvoker = (executor: Executor, invokeOptions: InvokeOptions): SandboxToolInvoker => {
  const base = makeExecutorToolInvoker(executor, { invokeOptions });
  return {
    invoke: ({ path, args }) => {
      if (path === "search") {
        if (!isRecord(args)) {
          return Effect.fail(
            new ExecutionToolError({
              message:
                "tools.search expects an object: { query?: string; namespace?: string; limit?: number }",
            }),
          );
        }

        if (args.query !== undefined && typeof args.query !== "string") {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.search query must be a string when provided",
            }),
          );
        }

        if (args.namespace !== undefined && typeof args.namespace !== "string") {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.search namespace must be a string when provided",
            }),
          );
        }

        const limit = readOptionalLimit(args.limit, "tools.search");
        if (limit instanceof ExecutionToolError) {
          return Effect.fail(limit);
        }

        return searchTools(executor, args.query ?? "", limit, {
          namespace: args.namespace,
        }).pipe(
          Effect.withSpan("mcp.tool.dispatch", {
            attributes: { "mcp.tool.name": path, "executor.tool.builtin": true },
          }),
        );
      }
      if (path === "executor.sources.list") {
        if (args !== undefined && !isRecord(args)) {
          return Effect.fail(
            new ExecutionToolError({
              message:
                "tools.executor.sources.list expects an object: { query?: string; limit?: number }",
            }),
          );
        }

        if (isRecord(args) && args.query !== undefined && typeof args.query !== "string") {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.executor.sources.list query must be a string when provided",
            }),
          );
        }

        const limit = readOptionalLimit(
          isRecord(args) ? args.limit : undefined,
          "tools.executor.sources.list",
        );
        if (limit instanceof ExecutionToolError) {
          return Effect.fail(limit);
        }

        return listExecutorSources(executor, {
          query: isRecord(args) && typeof args.query === "string" ? args.query : undefined,
          limit,
        }).pipe(
          Effect.withSpan("mcp.tool.dispatch", {
            attributes: { "mcp.tool.name": path, "executor.tool.builtin": true },
          }),
        );
      }
      if (path === "describe.tool") {
        if (!isRecord(args)) {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.describe.tool expects an object: { path: string }",
            }),
          );
        }

        if (typeof args.path !== "string" || args.path.trim().length === 0) {
          return Effect.fail(new ExecutionToolError({ message: "describe.tool requires a path" }));
        }

        if ("includeSchemas" in args) {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.describe.tool no longer accepts includeSchemas",
            }),
          );
        }

        return describeTool(executor, args.path).pipe(
          Effect.withSpan("mcp.tool.dispatch", {
            attributes: {
              "mcp.tool.name": path,
              "executor.tool.builtin": true,
              "executor.tool.target_path": args.path,
            },
          }),
        );
      }
      return base.invoke({ path, args });
    },
  };
};

// ---------------------------------------------------------------------------
// Execution Engine
// ---------------------------------------------------------------------------

export type ExecutionEngine<E extends Cause.YieldableError = CodeExecutionError> = {
  /**
   * Execute code with elicitation handled inline by the provided handler.
   * Use this when the host supports elicitation (e.g. MCP with elicitation capability).
   *
   * Fails with the code executor's typed error `E` (defaults to
   * `CodeExecutionError`). Runtimes surface their own `Data.TaggedError`
   * subclass, which flows through here unchanged.
   */
  readonly execute: (
    code: string,
    options: { readonly onElicitation: ElicitationHandler },
  ) => Effect.Effect<ExecuteResult, E>;

  /**
   * Execute code, intercepting the first elicitation as a pause point.
   * Use this when the host doesn't support inline elicitation.
   * Returns either a completed result or a paused execution that can be resumed.
   */
  readonly executeWithPause: (code: string) => Effect.Effect<ExecutionResult, E>;

  /**
   * Resume a paused execution. Returns a completed result, a new pause, or
   * null if the executionId was not found.
   */
  readonly resume: (
    executionId: string,
    response: ResumeResponse,
  ) => Effect.Effect<ExecutionResult | null, E>;

  /**
   * Get the dynamic tool description (workflow + namespaces).
   */
  readonly getDescription: Effect.Effect<string>;
};

export const createExecutionEngine = <
  E extends Cause.YieldableError = CodeExecutionError,
>(
  config: ExecutionEngineConfig<E>,
): ExecutionEngine<E> => {
  const { executor, codeExecutor } = config;
  const pausedExecutions = new Map<string, InternalPausedExecution<E>>();
  let nextId = 0;

  /**
   * Race a running fiber against a pause signal. Returns when either
   * the fiber completes or an elicitation handler fires (whichever
   * comes first). Re-used by both executeWithPause and resume.
   */
  const awaitCompletionOrPause = (
    fiber: Fiber.Fiber<ExecuteResult, E>,
    pauseSignal: Deferred.Deferred<InternalPausedExecution<E>>,
  ): Effect.Effect<ExecutionResult, E> =>
    Effect.race(
      Fiber.join(fiber).pipe(
        Effect.map((result): ExecutionResult => ({ status: "completed", result })),
      ),
      Deferred.await(pauseSignal).pipe(
        Effect.map((paused): ExecutionResult => ({ status: "paused", execution: paused })),
      ),
    );

  /**
   * Start an execution in pause/resume mode.
   *
   * The sandbox is forked as a daemon because paused executions can outlive the
   * caller scope that returned the first pause, such as an HTTP request handler.
   */
  const startPausableExecution = Effect.fn("mcp.execute")(function* (code: string) {
    yield* Effect.annotateCurrentSpan({
      "mcp.execute.mode": "pausable",
      "mcp.execute.code_length": code.length,
    });

    // Ref holds the current pause signal. The elicitation handler reads
    // it each time it fires, so resume() can swap in a fresh Deferred
    // before unblocking the fiber.
    const pauseSignalRef = yield* Ref.make(yield* Deferred.make<InternalPausedExecution<E>>());

    // Will be set once the fiber is forked.
    let fiber: Fiber.Fiber<ExecuteResult, E>;

    const elicitationHandler: ElicitationHandler = (ctx) =>
      Effect.gen(function* () {
        const responseDeferred = yield* Deferred.make<typeof ElicitationResponse.Type>();
        const id = `exec_${++nextId}`;

        const paused: InternalPausedExecution<E> = {
          id,
          elicitationContext: ctx,
          response: responseDeferred,
          fiber: fiber!,
          pauseSignalRef,
        };
        pausedExecutions.set(id, paused);

        const currentSignal = yield* Ref.get(pauseSignalRef);
        yield* Deferred.succeed(currentSignal, paused);

        // Suspend until resume() completes responseDeferred.
        return yield* Deferred.await(responseDeferred);
      });

    const invoker = makeFullInvoker(executor, { onElicitation: elicitationHandler });
    fiber = yield* Effect.forkDaemon(
      codeExecutor.execute(code, invoker).pipe(Effect.withSpan("executor.code.exec")),
    );

    const initialSignal = yield* Ref.get(pauseSignalRef);
    return (yield* awaitCompletionOrPause(fiber, initialSignal)) as ExecutionResult;
  });

  /**
   * Resume a paused execution. Swaps in a fresh pause signal, completes
   * the response Deferred to unblock the fiber, then races completion
   * against the next pause.
   */
  const resumeExecution = Effect.fn("mcp.execute.resume")(function* (
    executionId: string,
    response: ResumeResponse,
  ) {
    yield* Effect.annotateCurrentSpan({
      "mcp.execute.resume.action": response.action,
    });

    const paused = pausedExecutions.get(executionId);
    if (!paused) return null;
    pausedExecutions.delete(executionId);

    // Swap in a fresh pause signal BEFORE unblocking the fiber, so the
    // next elicitation handler call signals this new Deferred.
    const nextSignal = yield* Deferred.make<InternalPausedExecution<E>>();
    yield* Ref.set(paused.pauseSignalRef, nextSignal);

    yield* Deferred.succeed(paused.response, {
      action: response.action,
      content: response.content,
    });

    return (yield* awaitCompletionOrPause(paused.fiber, nextSignal)) as ExecutionResult;
  });

  /**
   * Inline-elicitation execute path. Wrapped so every call produces an
   * `mcp.execute` span with the inner `executor.code.exec` as a child.
   */
  const runInlineExecution = Effect.fn("mcp.execute")(function* (
    code: string,
    options: { readonly onElicitation: ElicitationHandler },
  ) {
    yield* Effect.annotateCurrentSpan({
      "mcp.execute.mode": "inline",
      "mcp.execute.code_length": code.length,
    });
    const invoker = makeFullInvoker(executor, {
      onElicitation: options.onElicitation,
    });
    return yield* codeExecutor
      .execute(code, invoker)
      .pipe(Effect.withSpan("executor.code.exec"));
  });

  return {
    execute: runInlineExecution,
    executeWithPause: startPausableExecution,
    resume: resumeExecution,
    getDescription: buildExecuteDescription(executor),
  };
};

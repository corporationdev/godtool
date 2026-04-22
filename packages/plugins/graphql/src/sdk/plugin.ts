import { randomUUID } from "node:crypto";

import { Effect, Option } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import type { Layer } from "effect";

import {
  ConnectionId,
  CreateConnectionInput,
  ScopeId,
  definePlugin,
  SourceDetectionResult,
  type ConnectionProvider,
  type StorageFailure,
  type ToolAnnotations,
  type ToolRow,
} from "@executor/sdk";

import {
  headersToConfigValues,
  type ConfigFileSink,
  type GraphqlSourceConfig as GraphqlConfigEntry,
} from "@executor/config";

import {
  ensureComposioManagedAuthConfig,
  createComposioConnectLink,
  getComposioConnectedAccount,
  executeComposioProxy,
  ComposioClientError,
} from "../composio/client";
import {
  introspect,
  INTROSPECTION_QUERY,
  parseIntrospectionJson,
  type IntrospectionResult,
  type IntrospectionType,
  type IntrospectionField,
  type IntrospectionTypeRef,
} from "./introspect";
import { extract } from "./extract";
import {
  GraphqlComposioError,
  GraphqlExtractionError,
  GraphqlIntrospectionError,
} from "./errors";
import { invokeWithLayer, resolveHeaders } from "./invoke";
import {
  graphqlSchema,
  makeDefaultGraphqlStore,
  type GraphqlStore,
  type StoredGraphqlSource,
  type StoredOperation,
} from "./store";
import {
  ComposioSourceConfig,
  ExtractedField,
  GraphqlComposioSession,
  GraphqlInvocationAuth,
  OperationBinding,
  InvocationResult,
  type HeaderValue as HeaderValueValue,
  type GraphqlOperationKind,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export type HeaderValue = HeaderValueValue;

export interface GraphqlSourceConfig {
  /** The GraphQL endpoint URL */
  readonly endpoint: string;
  /**
   * Executor scope id that owns this source row. Must be one of the
   * executor's configured scopes. Typical shape: an admin adds the
   * source at the outermost (organization) scope so it's visible to
   * every inner (per-user) scope via fall-through reads.
   */
  readonly scope: string;
  /** Display name for the source. Falls back to namespace if not provided. */
  readonly name?: string;
  /** Optional: introspection JSON text (if endpoint doesn't support introspection) */
  readonly introspectionJson?: string;
  /** Namespace for the tools (derived from endpoint if not provided) */
  readonly namespace?: string;
  /** Headers applied to every request. Values can reference secrets. */
  readonly headers?: Record<string, HeaderValue>;
  /** Managed auth metadata kept on the source for reconnect. */
  readonly composio?: ComposioSourceConfig;
  /** Active auth path for invocation / introspection. */
  readonly auth?: GraphqlInvocationAuth;
}

// ---------------------------------------------------------------------------
// Plugin extension
// ---------------------------------------------------------------------------

export interface GraphqlUpdateSourceInput {
  readonly name?: string;
  readonly endpoint?: string;
  readonly headers?: Record<string, HeaderValue>;
  readonly composio?: ComposioSourceConfig | null;
  readonly auth?: GraphqlInvocationAuth | null;
}

export type StartComposioConnectInput =
  | {
      readonly scopeId: string;
      readonly sourceId: string;
      readonly callbackUrl: string;
    }
  | {
      readonly scopeId: string;
      readonly callbackUrl: string;
      readonly app: string;
      readonly authConfigId?: string | null;
      readonly connectionId: string;
      readonly displayName?: string;
    };

export interface StartComposioConnectResponse {
  readonly redirectUrl: string;
}

export interface CompleteComposioConnectInput {
  readonly state: string;
  readonly connectedAccountId: string;
}

export interface CompleteComposioConnectResponse {
  readonly connectionId: string;
}

/**
 * Errors any GraphQL extension method may surface. `GraphqlIntrospectionError`
 * and `GraphqlExtractionError` are plugin-domain tagged errors that flow
 * directly to clients (4xx, each carrying its own `HttpApiSchema` status).
 * `StorageFailure` covers raw backend failures (`StorageError` plus
 * `UniqueViolationError`); the HTTP edge (`@executor/api`'s `withCapture`)
 * translates `StorageError` to the opaque `InternalError({ traceId })` at
 * Layer composition.
 */
export type GraphqlExtensionFailure =
  | GraphqlComposioError
  | GraphqlIntrospectionError
  | GraphqlExtractionError
  | StorageFailure;

export interface GraphqlPluginExtension {
  /** Add a GraphQL endpoint and register its operations as tools */
  readonly addSource: (
    config: GraphqlSourceConfig,
  ) => Effect.Effect<
    { readonly toolCount: number; readonly namespace: string },
    GraphqlExtensionFailure
  >;

  /** Remove all tools from a previously added GraphQL source by namespace.
   *  `scope` pins the cleanup to the exact row — without it a shadowed
   *  outer-scope source with the same namespace could be wiped instead. */
  readonly removeSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;

  /** Fetch the full stored source by namespace (or null if missing).
   *  `scope` returns the exact row at that scope. For fall-through
   *  reads across the executor's scope stack, use `executor.sources.*`. */
  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<StoredGraphqlSource | null, StorageFailure>;

  /** Update config (endpoint, headers) for an existing GraphQL source.
   *  Does NOT re-introspect or re-register tools — just patches the
   *  stored endpoint/headers used at invoke time. `scope` pins the
   *  mutation to a single row so shadowed rows at other scopes are
   *  untouched. */
  readonly updateSource: (
    namespace: string,
    scope: string,
    input: GraphqlUpdateSourceInput,
  ) => Effect.Effect<void, StorageFailure>;
  readonly startComposioConnect: (
    input: StartComposioConnectInput,
  ) => Effect.Effect<StartComposioConnectResponse, GraphqlComposioError>;
  readonly completeComposioConnect: (
    input: CompleteComposioConnectInput,
  ) => Effect.Effect<CompleteComposioConnectResponse, GraphqlComposioError>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a namespace from an endpoint URL */
const namespaceFromEndpoint = (endpoint: string): string => {
  try {
    const url = new URL(endpoint);
    return url.hostname.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  } catch {
    return "graphql";
  }
};

const formatTypeRef = (ref: IntrospectionTypeRef): string => {
  switch (ref.kind) {
    case "NON_NULL":
      return ref.ofType ? `${formatTypeRef(ref.ofType)}!` : "Unknown!";
    case "LIST":
      return ref.ofType ? `[${formatTypeRef(ref.ofType)}]` : "[Unknown]";
    default:
      return ref.name ?? "Unknown";
  }
};

const unwrapTypeName = (ref: IntrospectionTypeRef): string => {
  if (ref.name) return ref.name;
  if (ref.ofType) return unwrapTypeName(ref.ofType);
  return "Unknown";
};

const buildSelectionSet = (
  ref: IntrospectionTypeRef,
  types: ReadonlyMap<string, IntrospectionType>,
  depth: number,
  seen: Set<string>,
): string => {
  if (depth > 2) return "";

  const leafName = unwrapTypeName(ref);
  if (seen.has(leafName)) return "";

  const objectType = types.get(leafName);
  if (!objectType?.fields) return "";

  const kind = objectType.kind;
  if (kind === "SCALAR" || kind === "ENUM") return "";

  seen.add(leafName);

  const subFields = objectType.fields
    .filter((f) => !f.name.startsWith("__"))
    .slice(0, 12)
    .map((f) => {
      const sub = buildSelectionSet(f.type, types, depth + 1, seen);
      return sub ? `${f.name} ${sub}` : f.name;
    });

  seen.delete(leafName);

  return subFields.length > 0 ? `{ ${subFields.join(" ")} }` : "";
};

const buildOperationStringForField = (
  kind: GraphqlOperationKind,
  field: IntrospectionField,
  types: ReadonlyMap<string, IntrospectionType>,
): string => {
  const opType = kind === "query" ? "query" : "mutation";

  const varDefs = field.args.map((arg) => {
    const typeName = formatTypeRef(arg.type);
    return `$${arg.name}: ${typeName}`;
  });

  const argPasses = field.args.map((arg) => `${arg.name}: $${arg.name}`);
  const selectionSet = buildSelectionSet(field.type, types, 0, new Set());

  const varDefsStr = varDefs.length > 0 ? `(${varDefs.join(", ")})` : "";
  const argPassStr = argPasses.length > 0 ? `(${argPasses.join(", ")})` : "";

  return `${opType}${varDefsStr} { ${field.name}${argPassStr}${selectionSet ? ` ${selectionSet}` : ""} }`;
};

interface PreparedOperation {
  readonly toolPath: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly binding: OperationBinding;
}

const prepareOperations = (
  fields: readonly ExtractedField[],
  introspection: IntrospectionResult,
): readonly PreparedOperation[] => {
  const typeMap = new Map<string, IntrospectionType>();
  for (const t of introspection.__schema.types) {
    typeMap.set(t.name, t);
  }

  const fieldMap = new Map<
    string,
    { kind: GraphqlOperationKind; field: IntrospectionField }
  >();
  const schema = introspection.__schema;
  for (const rootKind of ["query", "mutation"] as const) {
    const typeName =
      rootKind === "query" ? schema.queryType?.name : schema.mutationType?.name;
    if (!typeName) continue;
    const rootType = typeMap.get(typeName);
    if (!rootType?.fields) continue;
    for (const f of rootType.fields) {
      if (!f.name.startsWith("__")) {
        fieldMap.set(`${rootKind}.${f.name}`, { kind: rootKind, field: f });
      }
    }
  }

  return fields.map((extracted) => {
    const prefix = extracted.kind === "mutation" ? "mutation" : "query";
    const toolPath = `${prefix}.${extracted.fieldName}`;
    const description = Option.getOrElse(
      extracted.description,
      () =>
        `GraphQL ${extracted.kind}: ${extracted.fieldName} -> ${extracted.returnTypeName}`,
    );

    const key = `${extracted.kind}.${extracted.fieldName}`;
    const entry = fieldMap.get(key);
    const operationString = entry
      ? buildOperationStringForField(entry.kind, entry.field, typeMap)
      : `${extracted.kind} { ${extracted.fieldName} }`;

    const binding = new OperationBinding({
      kind: extracted.kind,
      fieldName: extracted.fieldName,
      operationString,
      variableNames: extracted.arguments.map((a) => a.name),
    });

    return {
      toolPath,
      description,
      inputSchema: Option.getOrUndefined(extracted.inputSchema),
      binding,
    };
  });
};

const annotationsFor = (binding: OperationBinding): ToolAnnotations => {
  if (binding.kind === "mutation") {
    return {
      requiresApproval: true,
      approvalDescription: `mutation ${binding.fieldName}`,
    };
  }
  return {};
};

const withQueryParam = (url: string, key: string, value: string): string => {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
};

const composioAliasForAttempt = (displayName: string, sessionId: string): string =>
  `${displayName} (${sessionId.slice(0, 8)})`;

const buildGraphqlRequestBody = (
  operation: OperationBinding,
  args: Record<string, unknown>,
): { readonly query: string; readonly variables?: Record<string, unknown> } => {
  const variables: Record<string, unknown> = {};
  for (const varName of operation.variableNames) {
    if (args[varName] !== undefined) {
      variables[varName] = args[varName];
    }
  }

  if (typeof args.variables === "object" && args.variables !== null) {
    Object.assign(variables, args.variables);
  }

  return {
    query: operation.operationString,
    variables: Object.keys(variables).length > 0 ? variables : undefined,
  };
};

const parseIntrospectionPayload = (
  raw: unknown,
): Effect.Effect<IntrospectionResult, GraphqlIntrospectionError> =>
  Effect.gen(function* () {
    const json = raw as { data?: IntrospectionResult; errors?: unknown[] } | null;

    if (json?.errors && Array.isArray(json.errors) && json.errors.length > 0) {
      return yield* new GraphqlIntrospectionError({
        message: `Introspection returned ${json.errors.length} error(s)`,
      });
    }

    if (!json?.data?.__schema) {
      return yield* new GraphqlIntrospectionError({
        message: "Introspection response missing __schema",
      });
    }

    return json.data;
  });

const invocationResultFromGraphqlBody = (
  status: number,
  body: unknown,
): InvocationResult => {
  const gqlBody = body as { data?: unknown; errors?: unknown[] } | null;
  const hasErrors = Array.isArray(gqlBody?.errors) && gqlBody.errors.length > 0;

  return new InvocationResult({
    status,
    data: gqlBody?.data ?? null,
    errors: hasErrors ? gqlBody!.errors : status >= 200 && status < 300 ? null : body,
  });
};

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface GraphqlPluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly composioApiKey?: string;
  /** If provided, source add/remove is mirrored to executor.jsonc
   *  (best-effort — file errors are logged, not raised). */
  readonly configFile?: ConfigFileSink;
}

const toGraphqlConfigEntry = (
  namespace: string,
  config: GraphqlSourceConfig,
): GraphqlConfigEntry => ({
  kind: "graphql",
  endpoint: config.endpoint,
  introspectionJson: config.introspectionJson,
  namespace,
  headers: headersToConfigValues(config.headers),
});

export const graphqlPlugin = definePlugin(
  (options?: GraphqlPluginOptions) => {
    const httpClientLayer = options?.httpClientLayer ?? FetchHttpClient.layer;
    const composioApiKey = options?.composioApiKey;
    const COMPOSIO_PROVIDER_KEY = "graphql-composio" as const;

    return {
      id: "graphql" as const,
      schema: graphqlSchema,
      storage: (deps): GraphqlStore => makeDefaultGraphqlStore(deps),

      extension: (ctx) => {
        const resolveConfigHeaders = (
          headers: Record<string, HeaderValue> | undefined,
        ) =>
          Effect.gen(function* () {
            if (!headers) return undefined;
            const resolved = yield* resolveHeaders(headers, ctx.secrets);
            return Object.keys(resolved).length > 0 ? resolved : undefined;
          });

        const introspectViaComposio = (
          endpoint: string,
          headers: Record<string, string> | undefined,
          auth: ComposioSourceConfig,
        ) =>
          Effect.gen(function* () {
            if (!composioApiKey) {
              return yield* new GraphqlComposioError({
                message: "Composio API key is not configured",
              });
            }

            const connection = yield* ctx.connections.get(auth.connectionId).pipe(
              Effect.mapError(
                (err) =>
                  new GraphqlComposioError({
                    message:
                      "message" in err ? (err as { message: string }).message : String(err),
                  }),
              ),
            );
            if (!connection) {
              return yield* new GraphqlComposioError({
                message: `Composio connection "${auth.connectionId}" was not found`,
              });
            }
            if (connection.provider !== COMPOSIO_PROVIDER_KEY) {
              return yield* new GraphqlComposioError({
                message:
                  `Connection "${auth.connectionId}" is provider "${connection.provider}", expected "${COMPOSIO_PROVIDER_KEY}"`,
              });
            }

            const connectedAccountId = connection.providerState?.connectedAccountId;
            if (typeof connectedAccountId !== "string" || connectedAccountId.length === 0) {
              return yield* new GraphqlComposioError({
                message:
                  `Composio connection "${auth.connectionId}" is missing connectedAccountId`,
              });
            }

            const providerApp = connection.providerState?.app;
            if (typeof providerApp === "string" && providerApp !== auth.app) {
              return yield* new GraphqlComposioError({
                message:
                  `Composio connection app mismatch: source expects "${auth.app}" but connection is "${providerApp}"`,
              });
            }

            const proxyResponse = yield* Effect.tryPromise({
              try: () =>
                executeComposioProxy({
                  apiKey: composioApiKey,
                  connectedAccountId,
                  endpoint,
                  method: "POST",
                  body: { query: INTROSPECTION_QUERY },
                  parameters: [
                    ...Object.entries(headers ?? {}).map(([name, value]) => ({
                      name,
                      value,
                      type: "header" as const,
                    })),
                  ],
                }),
              catch: (err) =>
                new GraphqlComposioError({
                  message:
                    err instanceof ComposioClientError
                      ? err.message
                      : "Failed to execute Composio introspection proxy",
                }),
            });

            if (proxyResponse.status !== 200) {
              return yield* new GraphqlIntrospectionError({
                message: `Introspection failed with status ${proxyResponse.status}`,
              });
            }

            return yield* parseIntrospectionPayload(
              proxyResponse.data ?? proxyResponse.error ?? proxyResponse.binaryData,
            );
          });

        const addSourceInternal = (config: GraphqlSourceConfig) =>
          ctx.transaction(
            Effect.gen(function* () {
              let introspectionResult: IntrospectionResult;
              if (config.introspectionJson) {
                introspectionResult = yield* parseIntrospectionJson(
                  config.introspectionJson,
                );
              } else {
                const resolved = yield* resolveConfigHeaders(config.headers);
                introspectionResult =
                  config.auth?.kind === "composio"
                    ? yield* introspectViaComposio(
                        config.endpoint,
                        resolved,
                        config.auth,
                      )
                    : yield* introspect(
                        config.endpoint,
                        resolved,
                      ).pipe(Effect.provide(httpClientLayer));
              }

              const { result, definitions } = yield* extract(
                introspectionResult,
              );
              const namespace =
                config.namespace ?? namespaceFromEndpoint(config.endpoint);
              const prepared = prepareOperations(
                result.fields,
                introspectionResult,
              );

              const displayName = config.name?.trim() || namespace;

              // Persist the source + per-operation bindings first so any
              // subsequent core-source register collision rolls back both.
              const storedSource: StoredGraphqlSource = {
                namespace,
                scope: config.scope,
                name: displayName,
                endpoint: config.endpoint,
                headers: config.headers ?? {},
                composio: config.composio,
                auth: config.auth,
              };

              const storedOps: StoredOperation[] = prepared.map((p) => ({
                toolId: `${namespace}.${p.toolPath}`,
                sourceId: namespace,
                binding: p.binding,
              }));

              yield* ctx.storage.upsertSource(storedSource, storedOps);

              yield* ctx.core.sources.register({
                id: namespace,
                scope: config.scope,
                kind: "graphql",
                name: displayName,
                url: config.endpoint,
                canRemove: true,
                canRefresh: false,
                canEdit: true,
                tools: prepared.map((p) => ({
                  name: p.toolPath,
                  description: p.description,
                  inputSchema: p.inputSchema,
                })),
              });

              if (Object.keys(definitions).length > 0) {
                yield* ctx.core.definitions.register({
                  sourceId: namespace,
                  scope: config.scope,
                  definitions,
                });
              }

              return { toolCount: prepared.length, namespace };
            }),
          );

        const configFile = options?.configFile;

        return {
          addSource: (config) =>
            addSourceInternal(config).pipe(
              Effect.tap((result) =>
                configFile
                  ? configFile.upsertSource(
                      toGraphqlConfigEntry(result.namespace, config),
                    )
                  : Effect.void,
              ),
              Effect.map(({ toolCount, namespace }) => ({ toolCount, namespace })),
            ),

          removeSource: (namespace, scope) =>
            Effect.gen(function* () {
              yield* ctx.transaction(
                Effect.gen(function* () {
                  yield* ctx.storage.removeSource(namespace, scope);
                  yield* ctx.core.sources.unregister(namespace);
                }),
              );
              if (configFile) {
                yield* configFile.removeSource(namespace);
              }
            }),

          getSource: (namespace, scope) =>
            ctx.storage.getSource(namespace, scope),

          updateSource: (namespace, scope, input) =>
            ctx.storage.updateSourceMeta(namespace, scope, {
              name: input.name?.trim() || undefined,
              endpoint: input.endpoint,
              headers: input.headers,
              composio: input.composio,
              auth: input.auth,
            }),

          startComposioConnect: (input) =>
            Effect.gen(function* () {
              if (!composioApiKey) {
                return yield* new GraphqlComposioError({
                  message: "Composio API key is not configured",
                });
              }

              const tokenScope = input.scopeId;
              const connectConfig =
                "sourceId" in input
                  ? yield* Effect.gen(function* () {
                      const source = yield* ctx.storage.getSource(input.sourceId, tokenScope).pipe(
                        Effect.mapError(
                          (err) => new GraphqlComposioError({ message: err.message }),
                        ),
                      );
                      if (!source) {
                        return yield* new GraphqlComposioError({
                          message: `Source "${input.sourceId}" not found`,
                        });
                      }
                      if (!source.composio) {
                        return yield* new GraphqlComposioError({
                          message:
                            `Source "${input.sourceId}" does not have Composio auth configured`,
                        });
                      }

                      return {
                        sourceId: input.sourceId,
                        app: source.composio.app,
                        authConfigId: source.composio.authConfigId,
                        connectionId: source.composio.connectionId,
                        displayName: source.name,
                      } as const;
                    })
                  : {
                      sourceId: null,
                      app: input.app,
                      authConfigId: input.authConfigId ?? null,
                      connectionId: input.connectionId,
                      displayName: input.displayName ?? input.app,
                    };

              const authConfigId =
                connectConfig.authConfigId ??
                (yield* Effect.tryPromise({
                  try: () =>
                    ensureComposioManagedAuthConfig(composioApiKey, connectConfig.app),
                  catch: (err) =>
                    new GraphqlComposioError({
                      message:
                        err instanceof ComposioClientError
                          ? err.message
                          : "Failed to resolve Composio auth config",
                    }),
                }));

              const sessionId = randomUUID();
              yield* ctx.storage.putComposioSession(
                sessionId,
                new GraphqlComposioSession({
                  tokenScope,
                  sourceId: connectConfig.sourceId,
                  connectionId: connectConfig.connectionId,
                  displayName: connectConfig.displayName,
                  app: connectConfig.app,
                  authConfigId,
                }),
              ).pipe(
                Effect.mapError((err) => new GraphqlComposioError({ message: err.message })),
              );

              const link = yield* Effect.tryPromise({
                try: () =>
                  createComposioConnectLink({
                    apiKey: composioApiKey,
                    app: connectConfig.app,
                    authConfigId,
                    userId: tokenScope,
                    callbackUrl: withQueryParam(input.callbackUrl, "state", sessionId),
                    alias: composioAliasForAttempt(connectConfig.displayName, sessionId),
                  }),
                catch: (err) =>
                  new GraphqlComposioError({
                    message:
                      err instanceof ComposioClientError
                        ? err.message
                        : "Failed to create Composio connect link",
                  }),
              });

              return { redirectUrl: link.redirectUrl };
            }),

          completeComposioConnect: (input) =>
            ctx.transaction(
              Effect.gen(function* () {
                const session = yield* ctx.storage.getComposioSession(input.state).pipe(
                  Effect.mapError((err) => new GraphqlComposioError({ message: err.message })),
                );
                if (!session) {
                  return yield* new GraphqlComposioError({
                    message: "Composio session not found or has expired",
                  });
                }

                yield* ctx.storage.deleteComposioSession(input.state).pipe(
                  Effect.mapError((err) => new GraphqlComposioError({ message: err.message })),
                );

                if (!composioApiKey) {
                  return yield* new GraphqlComposioError({
                    message: "Composio API key is not configured",
                  });
                }

                const account = yield* Effect.tryPromise({
                  try: () =>
                    getComposioConnectedAccount(composioApiKey, input.connectedAccountId),
                  catch: (err) =>
                    new GraphqlComposioError({
                      message:
                        err instanceof ComposioClientError
                          ? err.message
                          : "Failed to verify Composio connected account",
                    }),
                });

                if (account.status !== "ACTIVE") {
                  return yield* new GraphqlComposioError({
                    message:
                      `Composio connected account is not active yet (status: ${account.status})`,
                  });
                }
                if (account.appName && account.appName !== session.app) {
                  return yield* new GraphqlComposioError({
                    message: `Connected account app mismatch: expected ${session.app}, got ${account.appName}`,
                  });
                }
                if (
                  session.authConfigId !== null &&
                  account.authConfigId !== null &&
                  account.authConfigId !== session.authConfigId
                ) {
                  return yield* new GraphqlComposioError({
                    message:
                      `Connected account auth config mismatch: expected ${session.authConfigId}, got ${account.authConfigId}`,
                  });
                }

                yield* ctx.connections.create(
                  new CreateConnectionInput({
                    id: ConnectionId.make(session.connectionId),
                    scope: ScopeId.make(session.tokenScope),
                    provider: COMPOSIO_PROVIDER_KEY,
                    kind: "user",
                    identityLabel: session.displayName,
                    accessToken: null,
                    refreshToken: null,
                    expiresAt: null,
                    oauthScope: null,
                    providerState: {
                      connectedAccountId: input.connectedAccountId,
                      app: session.app,
                      authConfigId: session.authConfigId,
                    },
                  }),
                ).pipe(
                  Effect.mapError(
                    (err) =>
                      new GraphqlComposioError({
                        message:
                          "message" in err ? (err as { message: string }).message : String(err),
                      }),
                  ),
                );

                return { connectionId: session.connectionId };
              }),
            ).pipe(
              Effect.mapError((err) =>
                err instanceof GraphqlComposioError
                  ? err
                  : new GraphqlComposioError({ message: err.message }),
              ),
            ),
        } satisfies GraphqlPluginExtension;
      },

      staticSources: (self) => [
        {
          id: "graphql",
          kind: "control",
          name: "GraphQL",
          tools: [
            {
              name: "addSource",
              description:
                "Add a GraphQL endpoint and register its operations as tools",
              inputSchema: {
                type: "object",
                properties: {
                  endpoint: { type: "string" },
                  name: { type: "string" },
                  introspectionJson: { type: "string" },
                  namespace: { type: "string" },
                  headers: { type: "object" },
                  composio: { type: "object" },
                  auth: { type: "object" },
                },
                required: ["endpoint"],
              },
              outputSchema: {
                type: "object",
                properties: {
                  toolCount: { type: "number" },
                  namespace: { type: "string" },
                },
                required: ["toolCount", "namespace"],
              },
              // Static-tool callers don't name a scope. Default to the
              // outermost scope in the executor's stack — for a single-
              // scope executor that's the only scope; for a per-user
              // stack `[user, org]` it writes at `org` so the source is
              // visible across every user.
              handler: ({ ctx, args }) =>
                self.addSource({
                  ...(args as Omit<GraphqlSourceConfig, "scope">),
                  scope: ctx.scopes.at(-1)!.id as string,
                }),
            },
          ],
        },
      ],

      invokeTool: ({ ctx, toolRow, args }) =>
        Effect.gen(function* () {
          // toolRow.scope_id is the resolved owning scope of the tool
          // (innermost-wins from the executor's stack). The matching
          // graphql_operation + graphql_source rows live at the same
          // scope, so pin every store lookup to it instead of relying
          // on the scoped adapter's stack-wide fall-through.
          const toolScope = toolRow.scope_id as string;
          const op = yield* ctx.storage.getOperationByToolId(
            toolRow.id,
            toolScope,
          );
          if (!op) {
            return yield* Effect.fail(
              new Error(`No GraphQL operation found for tool "${toolRow.id}"`),
            );
          }
          const source = yield* ctx.storage.getSource(op.sourceId, toolScope);
          if (!source) {
            return yield* Effect.fail(
              new Error(`No GraphQL source found for "${op.sourceId}"`),
            );
          }

          const resolvedHeaders = yield* resolveHeaders(
            source.headers,
            ctx.secrets,
          );

          if (source.auth?.kind === "composio") {
            if (!composioApiKey) {
              return yield* Effect.fail(
                new Error(
                  `Composio-backed auth is configured for source "${source.namespace}", but COMPOSIO_API_KEY is not configured.`,
                ),
              );
            }

            const connection = yield* ctx.connections.get(source.auth.connectionId).pipe(
              Effect.mapError(
                (err) =>
                  new Error(
                    `Composio connection resolution failed: ${
                      "message" in err ? (err as { message: string }).message : String(err)
                    }`,
                  ),
              ),
            );
            if (!connection) {
              return yield* Effect.fail(
                new Error(
                  `Composio connection "${source.auth.connectionId}" was not found for source "${source.namespace}".`,
                ),
              );
            }
            if (connection.provider !== COMPOSIO_PROVIDER_KEY) {
              return yield* Effect.fail(
                new Error(
                  `Connection "${source.auth.connectionId}" is provider "${connection.provider}", expected "${COMPOSIO_PROVIDER_KEY}".`,
                ),
              );
            }

            const connectedAccountId = connection.providerState?.connectedAccountId;
            if (typeof connectedAccountId !== "string" || connectedAccountId.length === 0) {
              return yield* Effect.fail(
                new Error(
                  `Composio connection "${source.auth.connectionId}" is missing connectedAccountId.`,
                ),
              );
            }

            const providerApp = connection.providerState?.app;
            if (
              typeof providerApp === "string" &&
              providerApp !== source.auth.app
            ) {
              return yield* Effect.fail(
                new Error(
                  `Composio connection app mismatch: source expects "${source.auth.app}" but connection is "${providerApp}".`,
                ),
              );
            }

            const proxyResponse = yield* Effect.tryPromise({
              try: () =>
                executeComposioProxy({
                  apiKey: composioApiKey,
                  connectedAccountId,
                  endpoint: source.endpoint,
                  method: "POST",
                  body: buildGraphqlRequestBody(
                    op.binding,
                    (args ?? {}) as Record<string, unknown>,
                  ),
                  parameters: Object.entries(resolvedHeaders).map(([name, value]) => ({
                    name,
                    value,
                    type: "header" as const,
                  })),
                }),
              catch: (err) =>
                new GraphqlComposioError({
                  message:
                    err instanceof ComposioClientError
                      ? `Composio proxy request failed: ${err.message}`
                      : "Composio proxy request failed",
                }),
            });

            return invocationResultFromGraphqlBody(
              proxyResponse.status,
              proxyResponse.data ?? proxyResponse.error ?? proxyResponse.binaryData,
            );
          }

          return yield* invokeWithLayer(
            op.binding,
            (args ?? {}) as Record<string, unknown>,
            source.endpoint,
            resolvedHeaders,
            httpClientLayer,
          );
        }),

      resolveAnnotations: ({ ctx, sourceId, toolRows }) =>
        Effect.gen(function* () {
          // toolRows for a single (plugin_id, source_id) group can still
          // straddle multiple scopes when the source is shadowed (e.g. an
          // org-level GraphQL source plus a per-user override that
          // re-registers the same tool ids). Run one listOperationsBySource
          // per distinct scope so each lookup pins {source_id, scope_id}
          // and we don't fall through to the wrong scope's bindings.
          const scopes = new Set<string>();
          for (const row of toolRows as readonly ToolRow[]) {
            scopes.add(row.scope_id as string);
          }
          const byScope = new Map<string, Map<string, OperationBinding>>();
          for (const scope of scopes) {
            const ops = yield* ctx.storage.listOperationsBySource(
              sourceId,
              scope,
            );
            const byId = new Map<string, OperationBinding>();
            for (const op of ops) byId.set(op.toolId, op.binding);
            byScope.set(scope, byId);
          }

          const out: Record<string, ToolAnnotations> = {};
          for (const row of toolRows as readonly ToolRow[]) {
            const binding = byScope.get(row.scope_id as string)?.get(row.id);
            if (binding) out[row.id] = annotationsFor(binding);
          }
          return out;
        }),

      removeSource: ({ ctx, sourceId, scope }) =>
        ctx.storage.removeSource(sourceId, scope),

      detect: ({ url }) =>
        Effect.gen(function* () {
          const trimmed = url.trim();
          if (!trimmed) return null;
          const parsed = yield* Effect.try(() => new URL(trimmed)).pipe(
            Effect.option,
          );
          if (parsed._tag === "None") return null;

          const ok = yield* introspect(trimmed).pipe(
            Effect.provide(httpClientLayer),
            Effect.map(() => true),
            Effect.catchAll(() => Effect.succeed(false)),
          );

          if (!ok) return null;

          const name = namespaceFromEndpoint(trimmed);
          return new SourceDetectionResult({
            kind: "graphql",
            confidence: "high",
            endpoint: trimmed,
            name,
            namespace: name,
          });
        }),

      connectionProviders: (): readonly ConnectionProvider[] => [
        {
          key: COMPOSIO_PROVIDER_KEY,
        },
      ],
    };
  },
);

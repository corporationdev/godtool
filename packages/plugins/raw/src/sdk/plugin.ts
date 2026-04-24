import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import type { Layer } from "effect";

import {
  ConnectionId,
  CreateConnectionInput,
  ScopeId,
  definePlugin,
  FormElicitation,
  type ConnectionProvider,
  type StorageFailure,
  type ToolAnnotations,
} from "@executor/sdk";

import {
  headersToConfigValues,
  type ConfigFileSink,
  type RawSourceConfig as RawConfigEntry,
} from "@executor/config";

import {
  ensureComposioManagedAuthConfig,
  createComposioConnectLink,
  executeComposioProxy,
  getComposioConnectedAccount,
  ComposioClientError,
} from "../composio/client";
import { RawComposioError } from "./errors";
import {
  buildRequestUrl,
  invokeWithLayer,
  normalizeMethod,
  requiresApprovalForMethod,
  resolveHeaders,
} from "./invoke";
import {
  makeDefaultRawStore,
  rawSchema,
  type RawStore,
  type StoredRawSource,
} from "./store";
import {
  ComposioSourceConfig,
  RawComposioSession,
  RawFetchResult,
  type HeaderValue as HeaderValueValue,
  type RawInvocationAuth,
} from "./types";

export type HeaderValue = HeaderValueValue;

export interface RawSourceConfig {
  readonly baseUrl: string;
  readonly scope: string;
  readonly name?: string;
  readonly namespace?: string;
  readonly headers?: Record<string, HeaderValue>;
  readonly composio?: ComposioSourceConfig;
  readonly auth?: RawInvocationAuth;
}

export interface RawUpdateSourceInput {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, HeaderValue>;
  readonly composio?: ComposioSourceConfig | null;
  readonly auth?: RawInvocationAuth | null;
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

export type RawExtensionFailure = RawComposioError | StorageFailure;

export interface RawPluginExtension {
  readonly addSource: (
    config: RawSourceConfig,
  ) => Effect.Effect<
    { readonly sourceId: string; readonly toolCount: number },
    StorageFailure
  >;
  readonly removeSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<StoredRawSource | null, StorageFailure>;
  readonly updateSource: (
    namespace: string,
    scope: string,
    input: RawUpdateSourceInput,
  ) => Effect.Effect<void, StorageFailure>;
  readonly startComposioConnect: (
    input: StartComposioConnectInput,
  ) => Effect.Effect<StartComposioConnectResponse, RawComposioError>;
  readonly completeComposioConnect: (
    input: CompleteComposioConnectInput,
  ) => Effect.Effect<CompleteComposioConnectResponse, RawComposioError>;
}

export interface RawPluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly composioApiKey?: string;
  readonly configFile?: ConfigFileSink;
}

const namespaceFromBaseUrl = (baseUrl: string): string => {
  try {
    const url = new URL(baseUrl);
    return url.hostname.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  } catch {
    return "raw";
  }
};

const toRawConfigEntry = (
  namespace: string,
  config: RawSourceConfig,
): RawConfigEntry => ({
  kind: "raw",
  baseUrl: config.baseUrl,
  namespace: config.namespace ?? namespace,
  headers: headersToConfigValues(config.headers),
});

const toSourceName = (config: RawSourceConfig, namespace: string): string =>
  config.name?.trim() || namespace;

const composioAliasForAttempt = (displayName: string, sessionId: string): string =>
  `${displayName} (${sessionId.slice(0, 8)})`;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const toHeaderParameterList = (
  headers: Record<string, string>,
): ReadonlyArray<{ readonly name: string; readonly value: string; readonly type: "header" }> =>
  Object.entries(headers).map(([name, value]) => ({
    name,
    value,
    type: "header" as const,
  }));

export const rawPlugin = definePlugin((options?: RawPluginOptions) => {
  const httpClientLayer = options?.httpClientLayer ?? FetchHttpClient.layer;
  const composioApiKey = options?.composioApiKey;
  const COMPOSIO_PROVIDER_KEY = "raw-composio" as const;

  return {
    id: "raw" as const,
    schema: rawSchema,
    storage: (deps): RawStore => makeDefaultRawStore(deps),

    extension: (ctx) => {
      const addSourceInternal = (config: RawSourceConfig) =>
        ctx.transaction(
          Effect.gen(function* () {
            const namespace = config.namespace ?? namespaceFromBaseUrl(config.baseUrl);
            const source: StoredRawSource = {
              namespace,
              scope: config.scope,
              name: toSourceName(config, namespace),
              baseUrl: config.baseUrl,
              headers: config.headers ?? {},
              composio: config.composio,
              auth: config.auth,
            };

            yield* ctx.storage.upsertSource(source);
            yield* ctx.core.sources.register({
              id: namespace,
              scope: config.scope,
              kind: "raw",
              name: source.name,
              url: config.baseUrl,
              canRemove: true,
              canRefresh: false,
              canEdit: true,
              tools: [
                {
                  name: "fetch",
                  description: "Make an HTTP request relative to this source's base URL",
                  inputSchema: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      method: {
                        type: "string",
                        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
                      },
                      query: { type: "object" },
                      headers: { type: "object" },
                      body: {},
                      contentType: { type: "string" },
                    },
                    required: ["path"],
                  },
                  outputSchema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      status: { type: "number" },
                      headers: { type: "object" },
                      body: {},
                    },
                    required: ["ok", "status", "headers", "body"],
                  },
                },
              ],
            });

            return { sourceId: namespace, toolCount: 1 };
          }),
        );

      const configFile = options?.configFile;

      return {
        addSource: (config) =>
          addSourceInternal(config).pipe(
            Effect.tap((result) =>
              configFile && !config.composio && !config.auth
                ? configFile.upsertSource(toRawConfigEntry(result.sourceId, config))
                : Effect.void,
            ),
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

        getSource: (namespace, scope) => ctx.storage.getSource(namespace, scope),

        updateSource: (namespace, scope, input) =>
          Effect.gen(function* () {
            yield* ctx.storage.updateSourceMeta(namespace, scope, {
              name: input.name?.trim() || undefined,
              baseUrl: input.baseUrl,
              headers: input.headers,
              composio: input.composio,
              auth: input.auth,
            });

            if (!configFile) return;

            const source = yield* ctx.storage.getSource(namespace, scope);
            if (!source) return;

            if (!source.composio && !source.auth) {
              yield* configFile.upsertSource({
                kind: "raw",
                baseUrl: source.baseUrl,
                namespace: source.namespace,
                headers: headersToConfigValues(source.headers),
              });
              return;
            }

            yield* configFile.removeSource(namespace);
          }),

        startComposioConnect: (input) =>
          Effect.gen(function* () {
            if (!composioApiKey) {
              return yield* new RawComposioError({
                message: "Managed auth is not configured",
              });
            }

            const tokenScope = input.scopeId;
            const connectConfig =
              "sourceId" in input
                ? yield* Effect.gen(function* () {
                    const source = yield* ctx.storage.getSource(input.sourceId, tokenScope).pipe(
                      Effect.mapError((err) => new RawComposioError({ message: err.message })),
                    );
                    if (!source) {
                      return yield* new RawComposioError({
                        message: `Source "${input.sourceId}" not found`,
                      });
                    }
                    if (!source.composio) {
                      return yield* new RawComposioError({
                        message: `Source "${input.sourceId}" does not have managed auth configured`,
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
                  new RawComposioError({
                    message:
                      err instanceof ComposioClientError
                        ? err.message
                        : "Failed to resolve managed auth config",
                  }),
              }));

            const sessionId = randomUUID();
            yield* ctx.storage.putComposioSession(
              sessionId,
              new RawComposioSession({
                tokenScope,
                sourceId: connectConfig.sourceId,
                connectionId: connectConfig.connectionId,
                displayName: connectConfig.displayName,
                app: connectConfig.app,
                authConfigId,
              }),
            ).pipe(
              Effect.mapError((err) => new RawComposioError({ message: err.message })),
            );

            const link = yield* Effect.tryPromise({
              try: () =>
                createComposioConnectLink({
                  apiKey: composioApiKey,
                  app: connectConfig.app,
                  authConfigId,
                  userId: tokenScope,
                  callbackUrl: `${input.callbackUrl}${input.callbackUrl.includes("?") ? "&" : "?"}state=${encodeURIComponent(sessionId)}`,
                  alias: composioAliasForAttempt(connectConfig.displayName, sessionId),
                }),
              catch: (err) =>
                new RawComposioError({
                  message:
                    err instanceof ComposioClientError
                      ? err.message
                      : "Failed to create managed auth link",
                }),
            });

            return { redirectUrl: link.redirectUrl };
          }),

        completeComposioConnect: (input) =>
          ctx.transaction(
            Effect.gen(function* () {
              const session = yield* ctx.storage.getComposioSession(input.state).pipe(
                Effect.mapError((err) => new RawComposioError({ message: err.message })),
              );
              if (!session) {
                return yield* new RawComposioError({
                  message: "Composio session not found or has expired",
                });
              }

              yield* ctx.storage.deleteComposioSession(input.state).pipe(
                Effect.mapError((err) => new RawComposioError({ message: err.message })),
              );

              if (!composioApiKey) {
                return yield* new RawComposioError({
                  message: "Managed auth is not configured",
                });
              }

              const account = yield* Effect.tryPromise({
                try: () =>
                  getComposioConnectedAccount(composioApiKey, input.connectedAccountId),
                catch: (err) =>
                  new RawComposioError({
                    message:
                      err instanceof ComposioClientError
                        ? err.message
                        : "Failed to verify managed account",
                  }),
              });

              if (account.status !== "ACTIVE") {
                return yield* new RawComposioError({
                  message: `Managed account is not active yet (status: ${account.status})`,
                });
              }
              if (account.appName && account.appName !== session.app) {
                return yield* new RawComposioError({
                  message: `Managed account app mismatch: expected "${session.app}" but got "${account.appName}"`,
                });
              }

              yield* ctx.connections.create(
                new CreateConnectionInput({
                  id: ConnectionId.make(session.connectionId),
                  scope: ScopeId.make(session.tokenScope),
                  provider: COMPOSIO_PROVIDER_KEY,
                  kind: "user",
                  identityLabel: account.displayName ?? session.displayName,
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
                Effect.mapError((err) => new RawComposioError({ message: err.message })),
              );

              return { connectionId: session.connectionId };
            }),
          ).pipe(
            Effect.mapError((err) =>
              err instanceof RawComposioError
                ? err
                : new RawComposioError({ message: err.message }),
            ),
          ),
      } satisfies RawPluginExtension;
    },

    staticSources: (self) => [
      {
        id: "raw",
        kind: "control",
        name: "Raw HTTP",
        tools: [
          {
            name: "addSource",
            description: "Add a raw HTTP source with a base URL and optional headers",
            inputSchema: {
              type: "object",
              properties: {
                baseUrl: { type: "string" },
                namespace: { type: "string" },
                name: { type: "string" },
                headers: { type: "object" },
              },
              required: ["baseUrl"],
            },
            outputSchema: {
              type: "object",
              properties: {
                sourceId: { type: "string" },
                toolCount: { type: "number" },
              },
              required: ["sourceId", "toolCount"],
            },
            handler: ({ ctx, args }) =>
              self.addSource({
                ...(args as Omit<RawSourceConfig, "scope">),
                scope: ctx.scopes.at(-1)!.id as string,
              }),
          },
        ],
      },
    ],

    invokeTool: ({ ctx, toolRow, args, elicit }) =>
      Effect.gen(function* () {
        const toolScope = toolRow.scope_id as string;
        const source = yield* ctx.storage.getSource(toolRow.source_id, toolScope);
        if (!source) {
          return yield* Effect.fail(
            new Error(`No raw source found for "${toolRow.source_id}"`),
          );
        }

        const input = asRecord(args);
        const method = normalizeMethod(input.method);
        const path = String(input.path ?? "");

        if (requiresApprovalForMethod(method)) {
          yield* elicit(
            new FormElicitation({
              message: `${method} ${path || source.baseUrl}`,
              requestedSchema: {},
            }),
          );
        }

        const resolvedHeaders = yield* resolveHeaders(source.headers, { get: ctx.secrets.get });

        if (source.auth?.kind === "composio") {
          if (!composioApiKey) {
            return yield* Effect.fail(
              new Error(
                `Managed auth is configured for source "${source.namespace}", but the managed provider is not configured.`,
              ),
            );
          }

          const connection = yield* ctx.connections.get(source.auth.connectionId).pipe(
            Effect.mapError(
              (err) =>
                new Error(
                  `Managed connection resolution failed: ${
                    "message" in err ? (err as { message: string }).message : String(err)
                  }`,
                ),
            ),
          );
          if (!connection) {
            return yield* Effect.fail(
              new Error(
                `Managed connection "${source.auth.connectionId}" was not found for source "${source.namespace}".`,
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
                `Managed connection "${source.auth.connectionId}" is missing connectedAccountId.`,
              ),
            );
          }

          const providerApp = connection.providerState?.app;
          if (typeof providerApp === "string" && providerApp !== source.auth.app) {
            return yield* Effect.fail(
              new Error(
                `Managed connection app mismatch: source expects "${source.auth.app}" but connection is "${providerApp}".`,
              ),
            );
          }

          const url = buildRequestUrl(
            source.baseUrl,
            String(input.path ?? ""),
            input.query as Record<string, string | number | boolean | null | readonly (string | number | boolean)[]> | undefined,
          );
          const mergedHeaders = {
            ...resolvedHeaders,
            ...((input.headers ?? {}) as Record<string, string>),
          };
          const proxyResponse = yield* Effect.tryPromise({
            try: () =>
              executeComposioProxy({
                apiKey: composioApiKey,
                connectedAccountId,
                endpoint: url.toString(),
                method,
                body: input.body,
                parameters: toHeaderParameterList(mergedHeaders),
              }),
            catch: (err) =>
              new Error(
                err instanceof ComposioClientError
                  ? `Managed request failed: ${err.message}`
                  : "Managed request failed",
              ),
          });

          return new RawFetchResult({
            ok: proxyResponse.status >= 200 && proxyResponse.status < 300,
            status: proxyResponse.status,
            headers: proxyResponse.headers,
            body: proxyResponse.data ?? proxyResponse.error ?? proxyResponse.binaryData,
          });
        }

        return yield* invokeWithLayer(
          source.baseUrl,
          args,
          resolvedHeaders,
          httpClientLayer,
        );
      }),

    resolveAnnotations: ({ toolRows }) =>
      Effect.succeed(
        Object.fromEntries(
          toolRows.map((row) => [row.id, { mayElicit: true } satisfies ToolAnnotations]),
        ),
      ),

    removeSource: ({ ctx, sourceId, scope }) =>
      ctx.storage.removeSource(sourceId, scope),

    connectionProviders: [
      {
        key: COMPOSIO_PROVIDER_KEY,
      } satisfies ConnectionProvider,
    ],
  };
});

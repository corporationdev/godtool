import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import type { Layer } from "effect";

import {
  ConnectionId,
  CreateConnectionInput,
  ScopeId,
  SecretId,
  SecretOwnedByConnectionError,
  TokenMaterial,
  definePlugin,
  FormElicitation,
  type StorageFailure,
} from "@executor/sdk";
import {
  invokeManagedHttp,
  type ManagedAuthConfig,
  type ManagedAuthConnectionMaterial,
  type ManagedAuthProxy,
  type ManagedHttpRequest,
} from "@executor/plugin-managed-auth";

import {
  headersToConfigValues,
  type ConfigFileSink,
  type RawSourceConfig as RawConfigEntry,
} from "@executor/config";

import {
  invokeWithLayer,
  normalizeMethod,
  requiresApprovalForMethod,
  resolveHeaders,
  buildRequestUrl,
} from "./invoke";
import { makeDefaultRawStore, rawSchema, type RawStore, type StoredRawSource } from "./store";
import { RawFetchResult, type HeaderValue as HeaderValueValue } from "./types";

export type HeaderValue = HeaderValueValue;

export interface RawSourceConfig {
  readonly baseUrl: string;
  readonly scope: string;
  readonly name?: string;
  readonly namespace?: string;
  readonly headers?: Record<string, HeaderValue>;
  readonly managedAuth?: ManagedAuthConfig;
  readonly managedConnection?: ManagedAuthConnectionMaterial;
}

export interface RawUpdateSourceInput {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, HeaderValue>;
  readonly managedAuth?: ManagedAuthConfig | null;
}

export interface RawPluginExtension {
  readonly addSource: (
    config: RawSourceConfig,
  ) => Effect.Effect<{ readonly sourceId: string; readonly toolCount: number }, StorageFailure>;
  readonly removeSource: (namespace: string, scope: string) => Effect.Effect<void, StorageFailure>;
  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<StoredRawSource | null, StorageFailure>;
  readonly updateSource: (
    namespace: string,
    scope: string,
    input: RawUpdateSourceInput,
  ) => Effect.Effect<void, StorageFailure>;
}

export interface RawPluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly configFile?: ConfigFileSink;
  readonly composioApiKey?: string;
  readonly managedAuthProxy?: ManagedAuthProxy;
}

const RAW_COMPOSIO_PROVIDER_KEY = "raw-composio";

const namespaceFromBaseUrl = (baseUrl: string): string => {
  try {
    const url = new URL(baseUrl);
    return url.hostname.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  } catch {
    return "raw";
  }
};

const toRawConfigEntry = (namespace: string, config: RawSourceConfig): RawConfigEntry => ({
  kind: "raw",
  baseUrl: config.baseUrl,
  namespace: config.namespace ?? namespace,
  headers: headersToConfigValues(config.headers),
});

const toSourceName = (config: RawSourceConfig, namespace: string): string =>
  config.name?.trim() || namespace;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const providerStateFromMaterial = (
  material: ManagedAuthConnectionMaterial,
): Record<string, unknown> => ({
  connectedAccountId: material.connectedAccountId,
});

const managedRequestForRaw = (
  baseUrl: string,
  args: Record<string, unknown>,
  resolvedHeaders: Record<string, string>,
): ManagedHttpRequest => {
  const method = normalizeMethod(args.method);
  if (method === "OPTIONS") {
    throw new Error("Managed auth does not support OPTIONS requests");
  }
  const query = asRecord(args.query) as Parameters<typeof buildRequestUrl>[2];
  const url = buildRequestUrl(baseUrl, String(args.path ?? ""), query);
  const mergedHeaders = {
    ...resolvedHeaders,
    ...(asRecord(args.headers) as Record<string, string>),
  };
  const parameters = [
    ...Object.entries(mergedHeaders).map(([name, value]) => ({
      type: "header" as const,
      name,
      value: String(value),
    })),
  ];
  return {
    endpoint: url.toString(),
    method,
    parameters,
    ...(args.body !== undefined ? { body: args.body } : {}),
  };
};

export const rawPlugin = definePlugin((options?: RawPluginOptions) => {
  const httpClientLayer = options?.httpClientLayer ?? FetchHttpClient.layer;

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
              managedAuth: config.managedAuth,
            };

            if (config.managedConnection) {
              yield* ctx.connections
                .create(
                  new CreateConnectionInput({
                    id: ConnectionId.make(config.managedConnection.connectionId),
                    scope: ScopeId.make(config.scope),
                    provider: RAW_COMPOSIO_PROVIDER_KEY,
                    identityLabel: config.managedConnection.identityLabel,
                    accessToken: new TokenMaterial({
                      secretId: SecretId.make(
                        `${config.managedConnection.connectionId}.managed_auth`,
                      ),
                      name: `${source.name} Managed Auth`,
                      value: "managed-by-composio",
                    }),
                    refreshToken: null,
                    expiresAt: null,
                    oauthScope: null,
                    providerState: providerStateFromMaterial(config.managedConnection),
                  }),
                )
                .pipe(Effect.orDie);
            }

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
              configFile
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
              managedAuth: input.managedAuth,
            });

            if (!configFile) return;

            const source = yield* ctx.storage.getSource(namespace, scope);
            if (!source) return;

            yield* configFile.upsertSource({
              kind: "raw",
              baseUrl: source.baseUrl,
              namespace: source.namespace,
              headers: headersToConfigValues(source.headers),
            });
          }),
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
                managedAuth: { type: "object" },
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
          return yield* Effect.fail(new Error(`No raw source found for "${toolRow.source_id}"`));
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

        const resolvedHeaders = yield* resolveHeaders(source.headers, {
          get: (id) =>
            ctx.secrets.get(id).pipe(
              Effect.catchIf(
                (err) => err instanceof SecretOwnedByConnectionError,
                () => Effect.succeed(null),
              ),
            ),
        });

        if (source.managedAuth) {
          const request = managedRequestForRaw(source.baseUrl, input, resolvedHeaders);
          const result = yield* invokeManagedHttp({
            config: source.managedAuth,
            request,
            composioApiKey: options?.composioApiKey,
            proxy: options?.managedAuthProxy,
            connections: ctx.connections,
          });
          return new RawFetchResult({
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            headers: result.headers,
            body: result.error ?? result.data ?? result.binaryData,
          });
        }

        return yield* invokeWithLayer(source.baseUrl, input, resolvedHeaders, httpClientLayer);
      }),

    connectionProviders: () => [{ key: RAW_COMPOSIO_PROVIDER_KEY }],
  };
});

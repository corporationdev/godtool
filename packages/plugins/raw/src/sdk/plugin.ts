import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import type { Layer } from "effect";

import {
  SecretOwnedByConnectionError,
  definePlugin,
  FormElicitation,
  type StorageFailure,
} from "@executor/sdk";

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
} from "./invoke";
import {
  makeDefaultRawStore,
  rawSchema,
  type RawStore,
  type StoredRawSource,
} from "./store";
import { type HeaderValue as HeaderValueValue } from "./types";

export type HeaderValue = HeaderValueValue;

export interface RawSourceConfig {
  readonly baseUrl: string;
  readonly scope: string;
  readonly name?: string;
  readonly namespace?: string;
  readonly headers?: Record<string, HeaderValue>;
}

export interface RawUpdateSourceInput {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, HeaderValue>;
}

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
}

export interface RawPluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
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

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

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
            const namespace =
              config.namespace ?? namespaceFromBaseUrl(config.baseUrl);
            const source: StoredRawSource = {
              namespace,
              scope: config.scope,
              name: toSourceName(config, namespace),
              baseUrl: config.baseUrl,
              headers: config.headers ?? {},
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
                  description:
                    "Make an HTTP request relative to this source's base URL",
                  inputSchema: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      method: {
                        type: "string",
                        enum: [
                          "GET",
                          "POST",
                          "PUT",
                          "PATCH",
                          "DELETE",
                          "HEAD",
                          "OPTIONS",
                        ],
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
                ? configFile.upsertSource(
                    toRawConfigEntry(result.sourceId, config),
                  )
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

        getSource: (namespace, scope) =>
          ctx.storage.getSource(namespace, scope),

        updateSource: (namespace, scope, input) =>
          Effect.gen(function* () {
            yield* ctx.storage.updateSourceMeta(namespace, scope, {
              name: input.name?.trim() || undefined,
              baseUrl: input.baseUrl,
              headers: input.headers,
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
            description:
              "Add a raw HTTP source with a base URL and optional headers",
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
        const source = yield* ctx.storage.getSource(
          toolRow.source_id,
          toolScope,
        );
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

        const resolvedHeaders = yield* resolveHeaders(source.headers, {
          get: (id) =>
            ctx.secrets.get(id).pipe(
              Effect.catchIf(
                (err) => err instanceof SecretOwnedByConnectionError,
                () => Effect.succeed(null),
              ),
            ),
        });

        return yield* invokeWithLayer(
          source.baseUrl,
          input,
          resolvedHeaders,
          httpClientLayer,
        );
      }),
  };
});

import { randomUUID } from "node:crypto";

import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import type { Layer } from "effect";

import {
  OAuth2Error,
  buildAuthorizationUrl,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  exchangeClientCredentials,
  refreshAccessToken,
  type OAuth2TokenResponse,
} from "@executor/plugin-oauth2";

import {
  ConnectionId,
  ConnectionRefreshError,
  CreateConnectionInput,
  ScopeId,
  SecretId,
  SourceDetectionResult,
  TokenMaterial,
  definePlugin,
  type ConnectionProvider,
  type ConnectionRefreshInput,
  type ConnectionRefreshResult,
  type PluginCtx,
  type StorageFailure,
  type ToolAnnotations,
  type ToolRow,
} from "@executor/sdk";

import {
  headersToConfigValues,
  type ConfigFileSink,
  type OpenApiSourceConfig,
} from "@executor/config";

import {
  ensureComposioManagedAuthConfig,
  createComposioConnectLink,
  deleteComposioConnectedAccount,
  executeComposioProxy,
  getComposioConnectedAccount,
  ComposioClientError,
} from "../composio/client";

import {
  OpenApiComposioError,
  OpenApiExtractionError,
  OpenApiOAuthError,
  OpenApiParseError,
} from "./errors";
import { parse, resolveSpecText } from "./parse";
import { extract } from "./extract";
import { compileToolDefinitions, type ToolDefinition } from "./definitions";
import {
  annotationsForOperation,
  buildInvocationEndpoint,
  prepareInvocationRequest,
  invokeWithLayer,
  resolveHeaders,
} from "./invoke";
import { resolveBaseUrl } from "./openapi-utils";
import { previewSpec, SpecPreview } from "./preview";
import {
  makeDefaultOpenapiStore,
  openapiSchema,
  type OpenapiStore,
  type SourceConfig,
  type StoredOperation,
  type StoredSource,
} from "./store";
import {
  ComposioSourceConfig,
  HeaderValue as HeaderValueSchema,
  InvocationConfig,
  InvocationResult,
  OAuth2Auth,
  type OpenApiInvocationAuth,
  OpenApiComposioSession,
  OpenApiOAuthSession,
  OperationBinding,
  type HeaderValue as HeaderValueValue,
} from "./types";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export type HeaderValue = HeaderValueValue;

export interface OpenApiSpecConfig {
  readonly spec: string;
  /**
   * Executor scope id that owns this source row. Must be one of the
   * executor's configured scopes. Typical shape: an admin adds the
   * source at the outermost (organization) scope so it's visible to
   * every inner (per-user) scope via fall-through reads.
   */
  readonly scope: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly namespace?: string;
  readonly headers?: Record<string, HeaderValue>;
  readonly oauth2?: OAuth2Auth;
  readonly composio?: ComposioSourceConfig;
  readonly auth?: OpenApiInvocationAuth;
}

export interface OpenApiUpdateSourceInput {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, HeaderValue>;
  /** Rewrite the source's OAuth2Auth — typically after a successful
   *  re-authenticate, to point at a freshly minted connection. */
  readonly oauth2?: OAuth2Auth;
  readonly auth?: OpenApiInvocationAuth | null;
}

// ---------------------------------------------------------------------------
// OAuth2 onboarding inputs / outputs — callers pre-decide identity knobs
// (display name, scheme name, scopes, target scope) and the SDK mints a
// Connection when the flow completes. The caller receives an OAuth2Auth
// carrying just the resulting connection id.
// ---------------------------------------------------------------------------

interface StartOAuthIdentity {
  readonly displayName: string;
  readonly securitySchemeName: string;
  readonly clientIdSecretId: string;
  readonly scopes: readonly string[];
  /** Executor scope that will own the resulting Connection (and its
   *  backing token secrets). Defaults to `ctx.scopes[0].id`. */
  readonly tokenScope?: string;
}

export interface StartAuthorizationCodeOAuthInput extends StartOAuthIdentity {
  readonly flow: "authorizationCode";
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly redirectUrl: string;
  readonly clientSecretSecretId?: string | null;
}

/**
 * RFC 6749 §4.4 has no user-interactive step. `startOAuth` exchanges
 * tokens inline, creates the Connection, and returns a completed
 * `OAuth2Auth` pointing at it. No `authorizationUrl`, no session row,
 * no `completeOAuth`.
 */
export interface StartClientCredentialsOAuthInput extends StartOAuthIdentity {
  readonly flow: "clientCredentials";
  readonly tokenUrl: string;
  /** RFC 6749 §2.3.1 — client_credentials is unusable without the secret. */
  readonly clientSecretSecretId: string;
}

export type OpenApiStartOAuthInput =
  | StartAuthorizationCodeOAuthInput
  | StartClientCredentialsOAuthInput;

export interface StartAuthorizationCodeOAuthResponse {
  readonly flow: "authorizationCode";
  readonly sessionId: string;
  readonly authorizationUrl: string;
  readonly scopes: readonly string[];
}

export interface StartClientCredentialsOAuthResponse {
  readonly flow: "clientCredentials";
  /** Completed auth ready to attach to the source's `OAuth2Auth`. */
  readonly auth: OAuth2Auth;
  readonly scopes: readonly string[];
}

export type OpenApiStartOAuthResponse =
  | StartAuthorizationCodeOAuthResponse
  | StartClientCredentialsOAuthResponse;

export interface OpenApiCompleteOAuthInput {
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
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
 * Errors any OpenAPI extension method may surface. The first three are
 * plugin-domain tagged errors that flow directly to clients (4xx, each
 * carrying its own `HttpApiSchema` status). `StorageFailure` covers
 * raw backend failures (`StorageError`) plus `UniqueViolationError`;
 * the HTTP edge (`@executor/api`'s `withCapture`) translates
 * `StorageError` to the opaque `InternalError({ traceId })` at Layer
 * composition. `UniqueViolationError` passes through — plugins can
 * `Effect.catchTag` it if they want a friendlier user-facing error.
 */
export type OpenApiExtensionFailure =
  | OpenApiParseError
  | OpenApiExtractionError
  | OpenApiOAuthError
  | OpenApiComposioError
  | StorageFailure;

export interface OpenApiPluginExtension {
  readonly previewSpec: (
    specText: string,
  ) => Effect.Effect<SpecPreview, OpenApiParseError | OpenApiExtractionError>;
  readonly addSpec: (
    config: OpenApiSpecConfig,
  ) => Effect.Effect<
    { readonly sourceId: string; readonly toolCount: number },
    OpenApiParseError | OpenApiExtractionError | StorageFailure
  >;
  readonly removeSpec: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<StoredSource | null, StorageFailure>;
  readonly updateSource: (
    namespace: string,
    scope: string,
    input: OpenApiUpdateSourceInput,
  ) => Effect.Effect<void, StorageFailure>;
  readonly startOAuth: (
    input: OpenApiStartOAuthInput,
  ) => Effect.Effect<OpenApiStartOAuthResponse, OpenApiOAuthError>;
  readonly completeOAuth: (
    input: OpenApiCompleteOAuthInput,
  ) => Effect.Effect<OAuth2Auth, OpenApiOAuthError>;
  readonly startComposioConnect: (
    input: StartComposioConnectInput,
  ) => Effect.Effect<StartComposioConnectResponse, OpenApiComposioError>;
  readonly completeComposioConnect: (
    input: CompleteComposioConnectInput,
  ) => Effect.Effect<CompleteComposioConnectResponse, OpenApiComposioError>;
}

// ---------------------------------------------------------------------------
// Control-tool input/output schemas
// ---------------------------------------------------------------------------

const PreviewSpecInputSchema = Schema.Struct({
  spec: Schema.String,
});
type PreviewSpecInput = typeof PreviewSpecInputSchema.Type;

const AddSourceInputSchema = Schema.Struct({
  spec: Schema.String,
  baseUrl: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: HeaderValueSchema })),
});
type AddSourceInput = typeof AddSourceInputSchema.Type;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rewrite OpenAPI `#/components/schemas/X` refs to standard `#/$defs/X`. */
const normalizeOpenApiRefs = (node: unknown): unknown => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const n = normalizeOpenApiRefs(item);
      if (n !== item) changed = true;
      return n;
    });
    return changed ? out : node;
  }

  const obj = node as Record<string, unknown>;

  if (typeof obj.$ref === "string") {
    const match = obj.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (match) return { ...obj, $ref: `#/$defs/${match[1]}` };
    return obj;
  }

  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = normalizeOpenApiRefs(v);
    if (n !== v) changed = true;
    result[k] = n;
  }
  return changed ? result : obj;
};

const toBinding = (def: ToolDefinition): OperationBinding =>
  new OperationBinding({
    method: def.operation.method,
    pathTemplate: def.operation.pathTemplate,
    parameters: [...def.operation.parameters],
    requestBody: def.operation.requestBody,
  });

const descriptionFor = (def: ToolDefinition): string => {
  const op = def.operation;
  return Option.getOrElse(op.description, () =>
    Option.getOrElse(op.summary, () => `${op.method.toUpperCase()} ${op.pathTemplate}`),
  );
};

// ---------------------------------------------------------------------------
// Connection `provider_state` shape for openapi-oauth2.
//
// Every field needed to re-hit the token endpoint on refresh lives here,
// so the SDK's `ctx.connections.accessToken(id)` can drive both grant
// types without the plugin keeping its own refresh state. The flow
// literal chooses between `refresh_token` (authorizationCode) and
// re-`exchange client_credentials` at refresh time. NONE of this is
// sensitive — client credentials themselves still live in secrets and
// are resolved via `ctx.secrets.get` inside the refresh handler.
// ---------------------------------------------------------------------------

const OPENAPI_OAUTH2_PROVIDER_KEY = "openapi:oauth2" as const;

const OAuth2ProviderState = Schema.Struct({
  flow: Schema.Literal("authorizationCode", "clientCredentials"),
  tokenUrl: Schema.String,
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
});
type OAuth2ProviderState = typeof OAuth2ProviderState.Type;

const encodeProviderState = Schema.encodeSync(OAuth2ProviderState);
const decodeProviderState = Schema.decodeUnknownSync(OAuth2ProviderState);

const toProviderStateRecord = (
  state: OAuth2ProviderState,
): Record<string, unknown> =>
  encodeProviderState(state) as unknown as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface OpenApiPluginOptions {
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  /** If provided, source add/remove is mirrored to executor.jsonc
   *  (best-effort — file errors are logged, not raised). */
  readonly configFile?: ConfigFileSink;
  /** Composio API key. Required for sources with Composio managed auth. */
  readonly composioApiKey?: string;
}

const toOpenApiSourceConfig = (
  namespace: string,
  config: OpenApiSpecConfig,
): OpenApiSourceConfig => ({
  kind: "openapi",
  spec: config.spec,
  baseUrl: config.baseUrl,
  namespace,
  headers: headersToConfigValues(config.headers),
});

const isHttpUrl = (s: string): boolean =>
  s.startsWith("http://") || s.startsWith("https://");

const withQueryParam = (url: string, key: string, value: string): string => {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
};

export const openApiPlugin = definePlugin(
  (options?: OpenApiPluginOptions) => {
    const httpClientLayer = options?.httpClientLayer ?? FetchHttpClient.layer;
    const composioApiKey = options?.composioApiKey;

    const COMPOSIO_PROVIDER_KEY = "composio" as const;

    type RebuildInput = {
      readonly specText: string;
      readonly scope: string;
      readonly sourceUrl?: string;
      readonly name?: string;
      readonly baseUrl?: string;
      readonly namespace?: string;
      readonly headers?: Record<string, HeaderValue>;
      readonly oauth2?: OAuth2Auth;
      readonly composio?: ComposioSourceConfig;
      readonly auth?: OpenApiInvocationAuth;
    };

    // ctx comes from the plugin runtime — the same instance is passed to
    // `extension(ctx)` and to every lifecycle hook (`refreshSource`, etc.),
    // so helpers parameterised on ctx can be called from either surface.
    const rebuildSource = (
      ctx: PluginCtx<OpenapiStore>,
      input: RebuildInput,
    ) =>
      Effect.gen(function* () {
        const doc = yield* parse(input.specText);
        const result = yield* extract(doc);

        const namespace =
          input.namespace ??
          Option.getOrElse(result.title, () => "api")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_");

        const hoistedDefs: Record<string, unknown> = {};
        if (doc.components?.schemas) {
          for (const [k, v] of Object.entries(doc.components.schemas)) {
            hoistedDefs[k] = normalizeOpenApiRefs(v);
          }
        }

        const baseUrl = input.baseUrl ?? resolveBaseUrl(result.servers);
        const oauth2 = input.oauth2 ?? undefined;
        const auth = input.auth ?? oauth2;
        const invocationConfig = new InvocationConfig({
          baseUrl,
          headers: input.headers ?? {},
          auth: auth ? Option.some(auth) : Option.none(),
        });

        const definitions = compileToolDefinitions(result.operations);
        const sourceName =
          input.name ?? Option.getOrElse(result.title, () => namespace);

        const sourceConfig: SourceConfig = {
          spec: input.specText,
          sourceUrl: input.sourceUrl,
          baseUrl: input.baseUrl,
          namespace: input.namespace,
          headers: input.headers,
          oauth2,
          composio: input.composio,
        };

        const storedSource: StoredSource = {
          namespace,
          scope: input.scope,
          name: sourceName,
          config: sourceConfig,
          invocationConfig,
        };

        const storedOps: StoredOperation[] = definitions.map((def) => ({
          toolId: `${namespace}.${def.toolPath}`,
          sourceId: namespace,
          binding: toBinding(def),
        }));

        yield* ctx.transaction(
          Effect.gen(function* () {
            yield* ctx.storage.upsertSource(storedSource, storedOps);

            yield* ctx.core.sources.register({
              id: namespace,
              scope: input.scope,
              kind: "openapi",
              name: sourceName,
              url: baseUrl || undefined,
              canRemove: true,
              // `canRefresh` reflects whether we still know the
              // origin URL — sources added from raw spec text have
              // nothing to re-fetch, so refresh stays disabled.
              canRefresh: input.sourceUrl != null,
              canEdit: true,
              tools: definitions.map((def) => ({
                name: def.toolPath,
                description: descriptionFor(def),
                inputSchema: normalizeOpenApiRefs(
                  Option.getOrUndefined(def.operation.inputSchema),
                ),
                outputSchema: normalizeOpenApiRefs(
                  Option.getOrUndefined(def.operation.outputSchema),
                ),
              })),
            });

            if (Object.keys(hoistedDefs).length > 0) {
              yield* ctx.core.definitions.register({
                sourceId: namespace,
                scope: input.scope,
                definitions: hoistedDefs,
              });
            }
          }),
        );

        return { sourceId: namespace, toolCount: definitions.length };
      });

    // No-op for missing sources and for sources added from raw spec
    // text (no URL to re-fetch from). UIs gate the action via
    // `canRefresh` on the source row; reaching here without a URL
    // means the caller bypassed that gate, so we stay quiet rather
    // than surface a 500 through the unwhitelisted error channel.
    const refreshSourceInternal = (
      ctx: PluginCtx<OpenapiStore>,
      sourceId: string,
      scope: string,
    ) =>
      Effect.gen(function* () {
        const existing = yield* ctx.storage.getSource(sourceId, scope);
        if (!existing) return;
        const sourceUrl = existing.config.sourceUrl;
        if (!sourceUrl) return;
        const specText = yield* resolveSpecText(sourceUrl).pipe(
          Effect.provide(httpClientLayer),
        );
        yield* rebuildSource(ctx, {
          specText,
          scope,
          sourceUrl,
          name: existing.name,
          baseUrl: existing.config.baseUrl,
          namespace: existing.namespace,
          headers: existing.config.headers,
          oauth2: existing.config.oauth2,
          composio: existing.config.composio,
          auth: Option.getOrUndefined(existing.invocationConfig.auth),
        });
      });

    return {
      id: "openapi" as const,
      schema: openapiSchema,
      storage: (deps): OpenapiStore => makeDefaultOpenapiStore(deps),

      extension: (ctx) => {
        const addSpecInternal = (config: OpenApiSpecConfig) =>
          Effect.gen(function* () {
            // Resolve URL → text and parse BEFORE opening a transaction.
            // Holding `BEGIN` on the pool=1 Postgres connection across a
            // network fetch is the Hyperdrive deadlock path in production.
            const specText = yield* resolveSpecText(config.spec).pipe(
              Effect.provide(httpClientLayer),
            );
            return yield* rebuildSource(ctx, {
              specText,
              scope: config.scope,
              sourceUrl: isHttpUrl(config.spec) ? config.spec : undefined,
              name: config.name,
              baseUrl: config.baseUrl,
              namespace: config.namespace,
              headers: config.headers,
              oauth2: config.oauth2,
              composio: config.composio,
              auth: config.auth,
            });
          });

        const configFile = options?.configFile;

        return {
          previewSpec: (specText) =>
            previewSpec(specText).pipe(Effect.provide(httpClientLayer)),

          addSpec: (config) =>
            Effect.gen(function* () {
              const result = yield* addSpecInternal(config);
              if (configFile) {
                yield* configFile.upsertSource(
                  toOpenApiSourceConfig(result.sourceId, config),
                );
              }
              return result;
            }),

          removeSpec: (namespace, scope) =>
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
            ctx.storage.updateSourceMeta(namespace, scope, {
              name: input.name?.trim() || undefined,
              baseUrl: input.baseUrl,
              headers: input.headers,
              oauth2: input.oauth2,
              auth: input.auth,
            }),

          startOAuth: (input) =>
            Effect.gen(function* () {
              const scopesArray = [...input.scopes];
              const tokenScope = input.tokenScope ?? (ctx.scopes[0]!.id as string);

              const clientId = yield* ctx.secrets.get(input.clientIdSecretId).pipe(
                Effect.mapError((err) => new OpenApiOAuthError({ message: err.message })),
              );
              if (clientId === null) {
                return yield* new OpenApiOAuthError({
                  message: `Missing client ID secret: ${input.clientIdSecretId}`,
                });
              }

              if (input.flow === "clientCredentials") {
                // RFC 6749 §4.4: no user consent, no session, no PKCE. The
                // client_secret is mandatory — the spec defines the grant
                // as client authentication + a token request.
                const clientSecret = yield* ctx.secrets
                  .get(input.clientSecretSecretId)
                  .pipe(
                    Effect.mapError(
                      (err) => new OpenApiOAuthError({ message: err.message }),
                    ),
                  );
                if (clientSecret === null) {
                  return yield* new OpenApiOAuthError({
                    message: `Missing client secret: ${input.clientSecretSecretId}`,
                  });
                }

                const tokenResponse = yield* exchangeClientCredentials({
                  tokenUrl: input.tokenUrl,
                  clientId,
                  clientSecret,
                  scopes: scopesArray,
                }).pipe(
                  Effect.mapError(
                    (err) => new OpenApiOAuthError({ message: err.message }),
                  ),
                );

                const connectionId = `openapi-oauth2-${randomUUID()}`;
                const expiresAt =
                  typeof tokenResponse.expires_in === "number"
                    ? Date.now() + tokenResponse.expires_in * 1000
                    : null;

                const providerState: OAuth2ProviderState = {
                  flow: "clientCredentials",
                  tokenUrl: input.tokenUrl,
                  clientIdSecretId: input.clientIdSecretId,
                  clientSecretSecretId: input.clientSecretSecretId,
                  scopes: scopesArray,
                };

                yield* ctx.connections
                  .create(
                    new CreateConnectionInput({
                      id: ConnectionId.make(connectionId),
                      scope: ScopeId.make(tokenScope),
                      provider: OPENAPI_OAUTH2_PROVIDER_KEY,
                      kind: "app",
                      identityLabel: input.displayName,
                      accessToken: new TokenMaterial({
                        secretId: SecretId.make(`${connectionId}.access_token`),
                        name: `${input.displayName} Access Token`,
                        value: tokenResponse.access_token,
                      }),
                      // RFC 6749 §4.4.3: no refresh tokens for this grant.
                      refreshToken: null,
                      expiresAt,
                      oauthScope: tokenResponse.scope ?? null,
                      providerState: toProviderStateRecord(providerState),
                    }),
                  )
                  .pipe(
                    Effect.mapError(
                      (err) =>
                        new OpenApiOAuthError({
                          message:
                            "message" in err
                              ? (err as { message: string }).message
                              : String(err),
                        }),
                    ),
                  );

                const auth = new OAuth2Auth({
                  kind: "oauth2",
                  connectionId,
                  securitySchemeName: input.securitySchemeName,
                  flow: "clientCredentials",
                  tokenUrl: input.tokenUrl,
                  authorizationUrl: null,
                  clientIdSecretId: input.clientIdSecretId,
                  clientSecretSecretId: input.clientSecretSecretId ?? null,
                  scopes: scopesArray,
                });

                return {
                  flow: "clientCredentials" as const,
                  auth,
                  scopes: scopesArray,
                };
              }

              // authorizationCode path.
              const sessionId = randomUUID();
              const codeVerifier = createPkceCodeVerifier();
              const connectionId = `openapi-oauth2-${randomUUID()}`;

              yield* ctx.storage
                .putOAuthSession(
                  sessionId,
                  new OpenApiOAuthSession({
                    displayName: input.displayName,
                    securitySchemeName: input.securitySchemeName,
                    flow: input.flow,
                    tokenUrl: input.tokenUrl,
                    authorizationUrl: input.authorizationUrl,
                    redirectUrl: input.redirectUrl,
                    clientIdSecretId: input.clientIdSecretId,
                    clientSecretSecretId: input.clientSecretSecretId ?? null,
                    tokenScope,
                    connectionId,
                    accessTokenSecretId: `${connectionId}.access_token`,
                    refreshTokenSecretId: `${connectionId}.refresh_token`,
                    scopes: scopesArray,
                    codeVerifier,
                  }),
                )
                .pipe(
                  Effect.mapError((err) => new OpenApiOAuthError({ message: err.message })),
                );

              const authorizationUrl = buildAuthorizationUrl({
                authorizationUrl: input.authorizationUrl,
                clientId,
                redirectUrl: input.redirectUrl,
                scopes: scopesArray,
                state: sessionId,
                codeVerifier,
              });

              return {
                flow: "authorizationCode" as const,
                sessionId,
                authorizationUrl,
                scopes: scopesArray,
              };
            }),

          completeOAuth: (input) =>
            ctx.transaction(
              Effect.gen(function* () {
                const session = yield* ctx.storage.getOAuthSession(input.state).pipe(
                  Effect.mapError((err) => new OpenApiOAuthError({ message: err.message })),
                );
                if (!session) {
                  return yield* new OpenApiOAuthError({
                    message: "OAuth session not found or has expired",
                  });
                }
                yield* ctx.storage.deleteOAuthSession(input.state).pipe(
                  Effect.mapError((err) => new OpenApiOAuthError({ message: err.message })),
                );

                if (input.error) {
                  return yield* new OpenApiOAuthError({ message: input.error });
                }
                if (!input.code) {
                  return yield* new OpenApiOAuthError({
                    message: "OAuth callback did not include an authorization code",
                  });
                }

                const clientId = yield* ctx.secrets.get(session.clientIdSecretId).pipe(
                  Effect.mapError((err) => new OpenApiOAuthError({ message: err.message })),
                );
                if (clientId === null) {
                  return yield* new OpenApiOAuthError({
                    message: `Missing client ID secret: ${session.clientIdSecretId}`,
                  });
                }

                const clientSecret = session.clientSecretSecretId
                  ? yield* ctx.secrets.get(session.clientSecretSecretId).pipe(
                      Effect.mapError(
                        (err) => new OpenApiOAuthError({ message: err.message }),
                      ),
                    )
                  : null;

                const tokenResponse: OAuth2TokenResponse =
                  yield* exchangeAuthorizationCode({
                    tokenUrl: session.tokenUrl,
                    clientId,
                    clientSecret,
                    redirectUrl: session.redirectUrl,
                    codeVerifier: session.codeVerifier,
                    code: input.code,
                  }).pipe(
                    Effect.mapError(
                      (err) => new OpenApiOAuthError({ message: err.message }),
                    ),
                  );

                const expiresAt =
                  typeof tokenResponse.expires_in === "number"
                    ? Date.now() + tokenResponse.expires_in * 1000
                    : null;

                const providerState: OAuth2ProviderState = {
                  flow: "authorizationCode",
                  tokenUrl: session.tokenUrl,
                  clientIdSecretId: session.clientIdSecretId,
                  clientSecretSecretId: session.clientSecretSecretId,
                  scopes: [...session.scopes],
                };

                yield* ctx.connections
                  .create(
                    new CreateConnectionInput({
                      id: ConnectionId.make(session.connectionId),
                      scope: ScopeId.make(session.tokenScope),
                      provider: OPENAPI_OAUTH2_PROVIDER_KEY,
                      kind: "user",
                      identityLabel: session.displayName,
                      accessToken: new TokenMaterial({
                        secretId: SecretId.make(session.accessTokenSecretId),
                        name: `${session.displayName} Access Token`,
                        value: tokenResponse.access_token,
                      }),
                      refreshToken: tokenResponse.refresh_token
                        ? new TokenMaterial({
                            secretId: SecretId.make(session.refreshTokenSecretId),
                            name: `${session.displayName} Refresh Token`,
                            value: tokenResponse.refresh_token,
                          })
                        : null,
                      expiresAt,
                      oauthScope: tokenResponse.scope ?? null,
                      providerState: toProviderStateRecord(providerState),
                    }),
                  )
                  .pipe(
                    Effect.mapError(
                      (err) =>
                        new OpenApiOAuthError({
                          message:
                            "message" in err
                              ? (err as { message: string }).message
                              : String(err),
                        }),
                    ),
                  );

                return new OAuth2Auth({
                  kind: "oauth2",
                  connectionId: session.connectionId,
                  securitySchemeName: session.securitySchemeName,
                  flow: "authorizationCode",
                  tokenUrl: session.tokenUrl,
                  authorizationUrl: session.authorizationUrl,
                  clientIdSecretId: session.clientIdSecretId,
                  clientSecretSecretId: session.clientSecretSecretId,
                  scopes: [...session.scopes],
                });
              }),
            ).pipe(
              Effect.mapError((err) =>
                err instanceof OpenApiOAuthError
                  ? err
                  : new OpenApiOAuthError({ message: err.message }),
              ),
            ),

          startComposioConnect: (input) =>
            Effect.gen(function* () {
              if (!composioApiKey) {
                return yield* new OpenApiComposioError({
                  message: "Composio API key is not configured",
                });
              }

              const tokenScope = input.scopeId;
              const connectConfig =
                "sourceId" in input
                  ? yield* Effect.gen(function* () {
                      const source = yield* ctx.storage
                        .getSource(input.sourceId, tokenScope)
                        .pipe(
                          Effect.mapError(
                            (err) => new OpenApiComposioError({ message: err.message }),
                          ),
                        );
                      if (!source) {
                        return yield* new OpenApiComposioError({
                          message: `Source "${input.sourceId}" not found`,
                        });
                      }
                      if (!source.config.composio) {
                        return yield* new OpenApiComposioError({
                          message:
                            `Source "${input.sourceId}" does not have Composio auth configured`,
                        });
                      }
                      return {
                        sourceId: input.sourceId,
                        app: source.config.composio.app,
                        authConfigId: source.config.composio.authConfigId,
                        connectionId: source.config.composio.connectionId,
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
                    new OpenApiComposioError({
                      message:
                        err instanceof ComposioClientError
                          ? err.message
                          : "Failed to resolve Composio auth config",
                    }),
                }));

              const sessionId = randomUUID();

              const session = new OpenApiComposioSession({
                tokenScope,
                sourceId: connectConfig.sourceId,
                connectionId: connectConfig.connectionId,
                app: connectConfig.app,
                authConfigId,
              });

              yield* ctx.storage
                .putComposioSession(sessionId, session)
                .pipe(
                  Effect.mapError((err) => new OpenApiComposioError({ message: err.message })),
                );

              const link = yield* Effect.tryPromise({
                try: () =>
                  createComposioConnectLink({
                    apiKey: composioApiKey,
                    app: connectConfig.app,
                    authConfigId,
                    userId: tokenScope,
                    callbackUrl: withQueryParam(input.callbackUrl, "state", sessionId),
                    alias: connectConfig.displayName,
                  }),
                catch: (err) =>
                  new OpenApiComposioError({
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
                const session = yield* ctx.storage
                  .getComposioSession(input.state)
                  .pipe(
                    Effect.mapError((err) => new OpenApiComposioError({ message: err.message })),
                  );
                if (!session) {
                  return yield* new OpenApiComposioError({
                    message: "Composio session not found or has expired",
                  });
                }

                yield* ctx.storage
                  .deleteComposioSession(input.state)
                  .pipe(
                    Effect.mapError((err) => new OpenApiComposioError({ message: err.message })),
                  );

                if (!composioApiKey) {
                  return yield* new OpenApiComposioError({
                    message: "Composio API key is not configured",
                  });
                }

                const account = yield* Effect.tryPromise({
                  try: () =>
                    getComposioConnectedAccount(composioApiKey, input.connectedAccountId),
                  catch: (err) =>
                    new OpenApiComposioError({
                      message:
                        err instanceof ComposioClientError
                          ? err.message
                          : "Failed to verify Composio connected account",
                    }),
                });

                if (account.status !== "ACTIVE") {
                  return yield* new OpenApiComposioError({
                    message: `Composio connected account is not active yet (status: ${account.status})`,
                  });
                }
                if (account.appName && account.appName !== session.app) {
                  return yield* new OpenApiComposioError({
                    message: `Connected account app mismatch: expected ${session.app}, got ${account.appName}`,
                  });
                }
                if (
                  session.authConfigId !== null &&
                  account.authConfigId !== null &&
                  account.authConfigId !== session.authConfigId
                ) {
                  return yield* new OpenApiComposioError({
                    message:
                      `Connected account auth config mismatch: expected ${session.authConfigId}, got ${account.authConfigId}`,
                  });
                }

                yield* ctx.connections
                  .create(
                    new CreateConnectionInput({
                      id: ConnectionId.make(session.connectionId),
                      scope: ScopeId.make(session.tokenScope),
                      provider: COMPOSIO_PROVIDER_KEY,
                      kind: "user",
                      identityLabel: account.displayName ?? account.appName,
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
                  )
                  .pipe(
                    Effect.mapError(
                      (err) =>
                        new OpenApiComposioError({
                          message:
                            "message" in err
                              ? (err as { message: string }).message
                              : String(err),
                        }),
                    ),
                  );

                return { connectionId: session.connectionId };
              }),
            ).pipe(
              Effect.mapError((err) =>
                err instanceof OpenApiComposioError
                  ? err
                  : new OpenApiComposioError({ message: err.message }),
              ),
            ),
        } satisfies OpenApiPluginExtension;
      },

      staticSources: (self) => [
        {
          id: "openapi",
          kind: "control",
          name: "OpenAPI",
          tools: [
            {
              name: "previewSpec",
              description:
                "Preview an OpenAPI document before adding it as a source",
              inputSchema: {
                type: "object",
                properties: { spec: { type: "string" } },
                required: ["spec"],
              },
              handler: ({ args }) =>
                self.previewSpec((args as PreviewSpecInput).spec),
            },
            {
              name: "addSource",
              description:
                "Add an OpenAPI source and register its operations as tools",
              inputSchema: {
                type: "object",
                properties: {
                  spec: { type: "string" },
                  baseUrl: { type: "string" },
                  namespace: { type: "string" },
                  headers: { type: "object" },
                },
                required: ["spec"],
              },
              outputSchema: {
                type: "object",
                properties: {
                  sourceId: { type: "string" },
                  toolCount: { type: "number" },
                },
                required: ["sourceId", "toolCount"],
              },
              // Static-tool callers don't name a scope. Default to the
              // outermost scope in the executor's stack — for a single-
              // scope executor that's the only scope; for a per-user
              // stack `[user, org]` it writes at `org` so the source is
              // visible across every user.
              handler: ({ ctx, args }) =>
                self.addSpec({
                  ...(args as AddSourceInput),
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
          // openapi_operation + openapi_source rows live at the same
          // scope, so pin every store lookup to it instead of relying
          // on the scoped adapter's stack-wide fall-through.
          const toolScope = toolRow.scope_id as string;
          const op = yield* ctx.storage.getOperationByToolId(toolRow.id, toolScope);
          if (!op) {
            return yield* Effect.fail(
              new Error(`No OpenAPI operation found for tool "${toolRow.id}"`),
            );
          }
          const source = yield* ctx.storage.getSource(op.sourceId, toolScope);
          if (!source) {
            return yield* Effect.fail(
              new Error(`No OpenAPI source found for "${op.sourceId}"`),
            );
          }

          const config = source.invocationConfig;
          const resolvedHeaders = yield* resolveHeaders(
            config.headers,
            { get: ctx.secrets.get },
          );

          if (Option.isSome(config.auth)) {
            const auth = config.auth.value;
            if (auth.kind === "oauth2") {
              const accessToken = yield* ctx.connections
                .accessToken(auth.connectionId)
                .pipe(
                  Effect.mapError(
                    (err) =>
                      new Error(
                        `OAuth connection resolution failed: ${
                          "message" in err
                            ? (err as { message: string }).message
                            : String(err)
                        }`,
                      ),
                  ),
                );
              resolvedHeaders["Authorization"] = `Bearer ${accessToken}`;
            } else {
              if (!composioApiKey) {
                return yield* Effect.fail(
                  new Error(
                    `Composio-backed auth is configured for source "${source.namespace}", but COMPOSIO_API_KEY is not configured.`,
                  ),
                );
              }

              const connection = yield* ctx.connections.get(auth.connectionId).pipe(
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
                    `Composio connection "${auth.connectionId}" was not found for source "${source.namespace}".`,
                  ),
                );
              }
              if (connection.provider !== COMPOSIO_PROVIDER_KEY) {
                return yield* Effect.fail(
                  new Error(
                    `Connection "${auth.connectionId}" is provider "${connection.provider}", expected "${COMPOSIO_PROVIDER_KEY}".`,
                  ),
                );
              }

              const connectedAccountId = connection.providerState?.connectedAccountId;
              if (typeof connectedAccountId !== "string" || connectedAccountId.length === 0) {
                return yield* Effect.fail(
                  new Error(
                    `Composio connection "${auth.connectionId}" is missing connectedAccountId.`,
                  ),
                );
              }

              const providerApp = connection.providerState?.app;
              if (typeof providerApp === "string" && providerApp !== auth.app) {
                return yield* Effect.fail(
                  new Error(
                    `Composio connection app mismatch: source expects "${auth.app}" but connection is "${providerApp}".`,
                  ),
                );
              }

              const prepared = yield* prepareInvocationRequest(
                op.binding,
                (args ?? {}) as Record<string, unknown>,
                resolvedHeaders,
              );
              if (prepared.bodyKind === "multipart") {
                return yield* Effect.fail(
                  new Error(
                    `Multipart form-data requests are not implemented for Composio-backed source "${source.namespace}" yet.`,
                  ),
                );
              }

              const endpoint = buildInvocationEndpoint(config.baseUrl, prepared);
              const proxyHeaders = { ...prepared.headers };
              if (
                prepared.bodyKind !== "none" &&
                prepared.bodyContentType &&
                !Object.keys(proxyHeaders).some(
                  (name) => name.toLowerCase() === "content-type",
                )
              ) {
                proxyHeaders["content-type"] = prepared.bodyContentType;
              }

              const proxyResponse = yield* Effect.tryPromise({
                try: () =>
                  executeComposioProxy({
                    apiKey: composioApiKey,
                    connectedAccountId,
                    endpoint,
                    method: prepared.method,
                    body:
                      prepared.bodyKind === "none"
                        ? undefined
                        : prepared.bodyValue,
                    parameters: Object.entries(proxyHeaders).map(([name, value]) => ({
                      name,
                      value,
                      in: "header" as const,
                    })),
                  }),
                catch: (err) =>
                  new Error(
                    err instanceof ComposioClientError
                      ? `Composio proxy request failed: ${err.message}`
                      : "Composio proxy request failed",
                  ),
              });

              const ok = proxyResponse.status >= 200 && proxyResponse.status < 300;
              return new InvocationResult({
                status: proxyResponse.status,
                headers: proxyResponse.headers,
                data: ok
                  ? (proxyResponse.data ?? proxyResponse.binaryData)
                  : null,
                error: ok
                  ? null
                  : (proxyResponse.error ?? proxyResponse.data ?? proxyResponse.binaryData),
              });
            }
          }

          const result = yield* invokeWithLayer(
            op.binding,
            (args ?? {}) as Record<string, unknown>,
            config.baseUrl,
            resolvedHeaders,
            httpClientLayer,
          );

          return result;
        }),

      resolveAnnotations: ({ ctx, sourceId, toolRows }) =>
        Effect.gen(function* () {
          // toolRows for a single (plugin_id, source_id) group can still
          // straddle multiple scopes when the source is shadowed (e.g. an
          // org-level openapi source plus a per-user override that
          // re-registers the same tool ids). Run one listOperationsBySource
          // per distinct scope so each lookup pins {source_id, scope_id}
          // and we don't fall through to the wrong scope's bindings.
          const scopes = new Set<string>();
          for (const row of toolRows as readonly ToolRow[]) {
            scopes.add(row.scope_id as string);
          }
          const byScope = new Map<string, Map<string, OperationBinding>>();
          for (const scope of scopes) {
            const ops = yield* ctx.storage.listOperationsBySource(sourceId, scope);
            const byId = new Map<string, OperationBinding>();
            for (const op of ops) byId.set(op.toolId, op.binding);
            byScope.set(scope, byId);
          }

          const out: Record<string, ToolAnnotations> = {};
          for (const row of toolRows as readonly ToolRow[]) {
            const binding = byScope.get(row.scope_id as string)?.get(row.id);
            if (binding) {
              out[row.id] = annotationsForOperation(binding.method, binding.pathTemplate);
            }
          }
          return out;
        }),

      removeSource: ({ ctx, sourceId, scope }) =>
        ctx.storage.removeSource(sourceId, scope),

      // Re-fetch the spec from its origin URL (captured at addSpec time)
      // and replay the same parse → extract → upsertSource → register
      // path used by addSpec. Sources without a stored URL surface a
      // typed `OpenApiParseError` — the executor only dispatches refresh
      // when `canRefresh: true`, so a raw-text source reaching here
      // means stale UI state, which is worth surfacing to the caller.
      refreshSource: ({ ctx, sourceId, scope }) =>
        refreshSourceInternal(ctx, sourceId, scope),

      detect: ({ url }) =>
        Effect.gen(function* () {
          const trimmed = url.trim();
          if (!trimmed) return null;
          const parsed = yield* Effect.try(() => new URL(trimmed)).pipe(
            Effect.option,
          );
          if (parsed._tag === "None") return null;
          const specText = yield* resolveSpecText(trimmed).pipe(
            Effect.provide(httpClientLayer),
            Effect.catchAll(() => Effect.succeed(null)),
          );
          if (specText === null) return null;
          const doc = yield* parse(specText).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          );
          if (!doc) return null;
          const result = yield* extract(doc).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          );
          if (!result) return null;
          const namespace = Option.getOrElse(result.title, () => "api")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_");
          const name = Option.getOrElse(result.title, () => namespace);
          return new SourceDetectionResult({
            kind: "openapi",
            confidence: "high",
            endpoint: trimmed,
            name,
            namespace,
          });
        }),

      // The SDK's `ctx.connections.accessToken(id)` dispatches here when a
      // token is near expiry. Both flows share one provider key — the
      // concrete refresh strategy is selected from `providerState.flow`
      // because the caller already persisted all the knobs we need.
      connectionProviders: (ctx): readonly ConnectionProvider[] => [
        {
          // Composio-managed connections never refresh locally — Composio
          // handles token refresh server-side. The connection row exists
          // only so the Connections tab can show it and the UI can check
          // connect state. Removal mirrors the remote disconnect.
          key: COMPOSIO_PROVIDER_KEY,
          remove: (input) =>
            Effect.gen(function* () {
              if (!composioApiKey) return;
              const connectedAccountId = input.providerState?.connectedAccountId;
              if (typeof connectedAccountId !== "string" || connectedAccountId.length === 0) {
                return;
              }
              yield* Effect.tryPromise({
                try: () =>
                  deleteComposioConnectedAccount(
                    composioApiKey,
                    connectedAccountId,
                  ),
                catch: (cause) => cause,
              }).pipe(
                Effect.catchAll((cause) =>
                  cause instanceof ComposioClientError && cause.status === 404
                    ? Effect.void
                    : Effect.fail(
                        new ConnectionRefreshError({
                          connectionId: input.connectionId,
                          message:
                            cause instanceof Error
                              ? cause.message
                              : "Failed to delete Composio connected account",
                          cause,
                        }),
                      ),
                ),
              );
            }),
        },
        {
          key: OPENAPI_OAUTH2_PROVIDER_KEY,
          refresh: (input: ConnectionRefreshInput) =>
            Effect.gen(function* () {
              if (!input.providerState) {
                return yield* new ConnectionRefreshError({
                  connectionId: input.connectionId,
                  message:
                    "openapi:oauth2 connection is missing providerState",
                });
              }
              const state = yield* Effect.try({
                try: () => decodeProviderState(input.providerState),
                catch: (cause) =>
                  new ConnectionRefreshError({
                    connectionId: input.connectionId,
                    message: `openapi:oauth2 providerState is malformed: ${
                      cause instanceof Error ? cause.message : String(cause)
                    }`,
                    cause,
                  }),
              });

              const clientId = yield* ctx.secrets.get(state.clientIdSecretId).pipe(
                Effect.mapError(
                  (err) =>
                    new ConnectionRefreshError({
                      connectionId: input.connectionId,
                      message: `Failed to resolve client id secret: ${err.message}`,
                      cause: err,
                    }),
                ),
              );
              if (clientId === null) {
                return yield* new ConnectionRefreshError({
                  connectionId: input.connectionId,
                  message: `Missing client id secret: ${state.clientIdSecretId}`,
                });
              }

              const clientSecret = state.clientSecretSecretId
                ? yield* ctx.secrets.get(state.clientSecretSecretId).pipe(
                    Effect.mapError(
                      (err) =>
                        new ConnectionRefreshError({
                          connectionId: input.connectionId,
                          message: `Failed to resolve client secret: ${err.message}`,
                          cause: err,
                        }),
                    ),
                  )
                : null;

              const toRefreshError = (err: OAuth2Error) =>
                new ConnectionRefreshError({
                  connectionId: input.connectionId,
                  message: err.message,
                  cause: err,
                });

              const tokenResponse = yield* (state.flow === "clientCredentials"
                ? exchangeClientCredentials({
                    tokenUrl: state.tokenUrl,
                    clientId,
                    clientSecret: clientSecret ?? "",
                    scopes: state.scopes,
                  })
                : (() => {
                    if (input.refreshToken === null) {
                      return Effect.fail(
                        new OAuth2Error({
                          message:
                            "authorizationCode connection has no refresh token",
                        }),
                      );
                    }
                    return refreshAccessToken({
                      tokenUrl: state.tokenUrl,
                      clientId,
                      clientSecret,
                      refreshToken: input.refreshToken,
                      scopes: state.scopes,
                    });
                  })()
              ).pipe(Effect.mapError(toRefreshError));

              const expiresAt =
                typeof tokenResponse.expires_in === "number"
                  ? Date.now() + tokenResponse.expires_in * 1000
                  : null;

              const result: ConnectionRefreshResult = {
                accessToken: tokenResponse.access_token,
                // Rotated refresh token (RFC 6749 §6) — undefined means
                // "keep the stored one"; null means "AS didn't issue one".
                refreshToken: tokenResponse.refresh_token ?? undefined,
                expiresAt,
                oauthScope: tokenResponse.scope ?? input.oauthScope,
              };
              return result;
            }),
        },
      ],
    };
  },
);

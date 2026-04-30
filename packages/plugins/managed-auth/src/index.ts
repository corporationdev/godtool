import { Context, Data, Effect, Layer, Schema } from "effect";

const COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3.1";
const COMPOSIO_PROXY_BASE_URL = "https://backend.composio.dev/api/v3";

export const MANAGED_AUTH_KIND = "composio" as const;

export class ManagedAuthBillingService extends Context.Tag("ManagedAuthBillingService")<
  ManagedAuthBillingService,
  {
    readonly canUseManagedAuth: (scopeId: string) => Effect.Effect<boolean, never, never>;
  }
>() {
  static AllowAll = Layer.succeed(this, {
    canUseManagedAuth: () => Effect.succeed(true),
  });
}

export class ComposioManagedAuthConfig extends Schema.Class<ComposioManagedAuthConfig>(
  "ComposioManagedAuthConfig",
)({
  kind: Schema.Literal(MANAGED_AUTH_KIND),
  app: Schema.String,
  authConfigId: Schema.NullOr(Schema.String),
  connectionId: Schema.String,
}) {}
export type ManagedAuthConfig = typeof ComposioManagedAuthConfig.Type;
export const ManagedAuthConfig = ComposioManagedAuthConfig;

export class ManagedAuthConnectionMaterial extends Schema.Class<ManagedAuthConnectionMaterial>(
  "ManagedAuthConnectionMaterial",
)({
  connectionId: Schema.String,
  provider: Schema.String,
  identityLabel: Schema.NullOr(Schema.String),
  connectedAccountId: Schema.String,
}) {}

export interface ComposioConnectLinkInput {
  readonly apiKey: string;
  readonly app: string;
  readonly authConfigId: string | null;
  readonly userId: string;
  readonly callbackUrl: string;
  readonly alias?: string;
}

export interface ComposioConnectLinkResult {
  readonly redirectUrl: string;
  readonly connectedAccountId: string;
}

interface ComposioAuthConfig {
  readonly id: string;
  readonly toolkitSlug: string;
  readonly isComposioManaged: boolean;
}

export interface ComposioConnectedAccount {
  readonly id: string;
  readonly status: string;
  readonly appName: string;
  readonly authConfigId: string | null;
  readonly displayName: string | null;
  readonly userId: string | null;
}

export interface ManagedHttpParameter {
  readonly name: string;
  readonly value: string;
  readonly type: "header" | "query";
}

export interface ManagedHttpRequest {
  readonly endpoint: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
  readonly body?: unknown;
  readonly parameters?: ReadonlyArray<ManagedHttpParameter>;
}

export interface ManagedHttpResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly data: unknown | null;
  readonly error: unknown | null;
  readonly binaryData: unknown | null;
}

export type ManagedAuthProxy = (input: {
  readonly config: ManagedAuthConfig;
  readonly connectedAccountId: string;
  readonly request: ManagedHttpRequest;
}) => Promise<ManagedHttpResult>;

export class ComposioClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ComposioClientError";
  }
}

export class ManagedAuthInvocationError extends Data.TaggedError("ManagedAuthInvocationError")<{
  readonly message: string;
}> {}

const summarizeComposioError = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  return (
    summarizeComposioError(record.message) ??
    summarizeComposioError(record.error) ??
    (() => {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })()
  );
};

async function composioFetchWithBase<T>(
  url: string,
  apiKey: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `Composio API error ${res.status}`;
    try {
      message = summarizeComposioError(await res.json()) ?? message;
    } catch {}
    throw new ComposioClientError(message, res.status);
  }

  return res.json() as Promise<T>;
}

const composioFetch = <T>(apiKey: string, path: string, options?: RequestInit) =>
  composioFetchWithBase<T>(`${COMPOSIO_BASE_URL}${path}`, apiKey, options);

export async function createComposioConnectLink(
  input: ComposioConnectLinkInput,
): Promise<ComposioConnectLinkResult> {
  const body: Record<string, unknown> = {
    user_id: input.userId,
    callback_url: input.callbackUrl,
    alias: input.alias ?? input.app,
  };
  if (input.authConfigId) body.auth_config_id = input.authConfigId;
  else body.app_name = input.app;

  const data = await composioFetch<{
    redirectUrl?: string;
    redirect_url?: string;
    connectedAccountId?: string;
    connected_account_id?: string;
  }>(input.apiKey, "/connected_accounts/link", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const redirectUrl = data.redirectUrl ?? data.redirect_url;
  const connectedAccountId = data.connectedAccountId ?? data.connected_account_id;
  if (!redirectUrl || !connectedAccountId) {
    throw new ComposioClientError(
      "Composio link response missing redirectUrl or connectedAccountId",
    );
  }
  return { redirectUrl, connectedAccountId };
}

export async function listComposioAuthConfigs(
  apiKey: string,
  toolkitSlug: string,
): Promise<readonly ComposioAuthConfig[]> {
  const params = new URLSearchParams({
    toolkit_slug: toolkitSlug,
    is_composio_managed: "true",
  });
  const data = await composioFetch<{
    items?: Array<{ id?: string; is_composio_managed?: boolean; toolkit?: { slug?: string } }>;
  }>(apiKey, `/auth_configs?${params.toString()}`);

  return (data.items ?? [])
    .map((item) => ({
      id: item.id ?? "",
      toolkitSlug: item.toolkit?.slug ?? "",
      isComposioManaged: item.is_composio_managed ?? false,
    }))
    .filter((item) => item.id.length > 0);
}

export async function createComposioManagedAuthConfig(
  apiKey: string,
  toolkitSlug: string,
): Promise<ComposioAuthConfig> {
  const data = await composioFetch<{
    id?: string;
    is_composio_managed?: boolean;
    auth_config?: { id?: string; is_composio_managed?: boolean };
    toolkit?: { slug?: string };
  }>(apiKey, "/auth_configs", {
    method: "POST",
    body: JSON.stringify({
      toolkit: { slug: toolkitSlug },
      auth_config: {
        type: "use_composio_managed_auth",
        credentials: {},
      },
    }),
  });

  const id = data.auth_config?.id ?? data.id ?? "";
  if (!id) throw new ComposioClientError("Composio auth config response missing id");
  return {
    id,
    toolkitSlug: data.toolkit?.slug ?? toolkitSlug,
    isComposioManaged: data.auth_config?.is_composio_managed ?? data.is_composio_managed ?? true,
  };
}

export async function ensureComposioManagedAuthConfig(
  apiKey: string,
  toolkitSlug: string,
): Promise<string> {
  const existing = await listComposioAuthConfigs(apiKey, toolkitSlug);
  const reusable = existing.find((config) => config.isComposioManaged);
  if (reusable) return reusable.id;
  return (await createComposioManagedAuthConfig(apiKey, toolkitSlug)).id;
}

export async function getComposioConnectedAccount(
  apiKey: string,
  connectedAccountId: string,
): Promise<ComposioConnectedAccount> {
  const data = await composioFetch<{
    toolkit?: { slug?: string };
    auth_config?: { id?: string };
    id?: string;
    status?: string;
    appName?: string;
    app_name?: string;
    alias?: string;
    displayName?: string;
    display_name?: string;
    userId?: string;
    user_id?: string;
    entityId?: string;
    entity_id?: string;
  }>(apiKey, `/connected_accounts/${connectedAccountId}`);

  return {
    id: data.id ?? connectedAccountId,
    status: data.status ?? "UNKNOWN",
    appName: data.toolkit?.slug ?? data.appName ?? data.app_name ?? "",
    authConfigId: data.auth_config?.id ?? null,
    displayName: data.alias ?? data.displayName ?? data.display_name ?? null,
    userId: data.userId ?? data.user_id ?? data.entityId ?? data.entity_id ?? null,
  };
}

export async function executeComposioProxy(input: {
  readonly apiKey: string;
  readonly connectedAccountId: string;
  readonly request: ManagedHttpRequest;
}): Promise<ManagedHttpResult> {
  const body: Record<string, unknown> = {
    connected_account_id: input.connectedAccountId,
    endpoint: input.request.endpoint,
    method: input.request.method,
    parameters: input.request.parameters ?? [],
  };
  if (input.request.body !== undefined) body.body = input.request.body;

  return composioFetchWithBase<ManagedHttpResult>(
    `${COMPOSIO_PROXY_BASE_URL}/tools/execute/proxy`,
    input.apiKey,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export const invokeManagedHttp = (input: {
  readonly config: ManagedAuthConfig;
  readonly request: ManagedHttpRequest;
  readonly composioApiKey?: string;
  readonly proxy?: ManagedAuthProxy;
  readonly connections: {
    readonly get: (connectionId: string) => Effect.Effect<
      {
        readonly providerState: Record<string, unknown> | null;
      } | null,
      unknown
    >;
    readonly accessToken: (connectionId: string) => Effect.Effect<string, unknown>;
  };
}): Effect.Effect<ManagedHttpResult, ManagedAuthInvocationError> =>
  Effect.gen(function* () {
    const connection = yield* input.connections
      .get(input.config.connectionId)
      .pipe(
        Effect.mapError(
          () =>
            new ManagedAuthInvocationError({ message: "Managed auth connection lookup failed" }),
        ),
      );
    if (!connection) {
      return yield* new ManagedAuthInvocationError({
        message: "Managed auth connection is missing",
      });
    }

    const providerState = connection.providerState ?? {};
    const connectedAccountId = providerState.connectedAccountId;
    if (typeof connectedAccountId !== "string" || connectedAccountId.length === 0) {
      return yield* new ManagedAuthInvocationError({
        message: "Managed auth connection is missing its account id",
      });
    }

    if (input.proxy) {
      return yield* Effect.tryPromise({
        try: () =>
          input.proxy!({ config: input.config, connectedAccountId, request: input.request }),
        catch: (cause) =>
          cause instanceof ManagedAuthInvocationError
            ? cause
            : new ManagedAuthInvocationError({
                message: cause instanceof Error ? cause.message : String(cause),
              }),
      });
    }

    if (!input.composioApiKey) {
      return yield* new ManagedAuthInvocationError({ message: "Managed auth is not configured" });
    }

    return yield* Effect.tryPromise({
      try: () =>
        executeComposioProxy({
          apiKey: input.composioApiKey!,
          connectedAccountId,
          request: input.request,
        }),
      catch: (cause) =>
        new ManagedAuthInvocationError({
          message: cause instanceof Error ? cause.message : "Managed auth request failed",
        }),
    });
  });

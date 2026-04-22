const COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3.1";

export interface ComposioConnectLinkInput {
  readonly apiKey: string;
  readonly app: string;
  readonly authConfigId: string | null;
  /** Stable Composio user id — we use the executor scope id. */
  readonly userId: string;
  readonly callbackUrl: string;
  /** Human-readable label shown in the Composio dashboard. */
  readonly alias?: string;
}

export interface ComposioConnectLinkResult {
  readonly redirectUrl: string;
  /** Composio's id for the in-flight connected account. */
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
}

export class ComposioClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ComposioClientError";
  }
}

const summarizeComposioError = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const directMessage = summarizeComposioError(record.message);
  if (directMessage) return directMessage;
  const nestedError = summarizeComposioError(record.error);
  if (nestedError) return nestedError;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

async function composioFetch<T>(
  apiKey: string,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(`${COMPOSIO_BASE_URL}${path}`, {
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
      const body = (await res.json()) as unknown;
      message = summarizeComposioError(body) ?? message;
    } catch {
      // ignore parse failure
    }
    throw new ComposioClientError(message, res.status);
  }

  return res.json() as Promise<T>;
}

export async function createComposioConnectLink(
  input: ComposioConnectLinkInput,
): Promise<ComposioConnectLinkResult> {
  const body: Record<string, unknown> = {
    user_id: input.userId,
    callback_url: input.callbackUrl,
    alias: input.alias ?? input.app,
  };
  if (input.authConfigId) {
    body.auth_config_id = input.authConfigId;
  } else {
    body.app_name = input.app;
  }

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
    throw new ComposioClientError("Composio link response missing redirectUrl or connectedAccountId");
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
    items?: Array<{
      id?: string;
      is_composio_managed?: boolean;
      toolkit?: {
        slug?: string;
      };
    }>;
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
    toolkit?: {
      slug?: string;
    };
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

  const id = data.id ?? "";
  if (!id) {
    throw new ComposioClientError("Composio auth config response missing id");
  }

  return {
    id,
    toolkitSlug: data.toolkit?.slug ?? toolkitSlug,
    isComposioManaged: data.is_composio_managed ?? true,
  };
}

export async function ensureComposioManagedAuthConfig(
  apiKey: string,
  toolkitSlug: string,
): Promise<string> {
  const existing = await listComposioAuthConfigs(apiKey, toolkitSlug);
  const reusable = existing.find((config) => config.isComposioManaged);
  if (reusable) return reusable.id;

  const created = await createComposioManagedAuthConfig(apiKey, toolkitSlug);
  return created.id;
}

export async function getComposioConnectedAccount(
  apiKey: string,
  connectedAccountId: string,
): Promise<ComposioConnectedAccount> {
  const data = await composioFetch<{
    toolkit?: {
      slug?: string;
    };
    auth_config?: {
      id?: string;
    };
    id?: string;
    status?: string;
    appName?: string;
    app_name?: string;
    alias?: string;
    displayName?: string;
    display_name?: string;
  }>(apiKey, `/connected_accounts/${connectedAccountId}`);

  return {
    id: data.id ?? connectedAccountId,
    status: data.status ?? "UNKNOWN",
    appName: data.toolkit?.slug ?? data.appName ?? data.app_name ?? "",
    authConfigId: data.auth_config?.id ?? null,
    displayName: data.alias ?? data.displayName ?? data.display_name ?? null,
  };
}

export async function deleteComposioConnectedAccount(
  apiKey: string,
  connectedAccountId: string,
): Promise<void> {
  await composioFetch(apiKey, `/connected_accounts/${connectedAccountId}`, {
    method: "DELETE",
  });
}

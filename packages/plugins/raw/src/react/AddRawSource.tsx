import { useRef, useState, type ReactNode } from "react";
import { useAtomSet } from "@effect-atom/atom-react";

import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { usePendingSources } from "@executor/react/api/optimistic";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import { FieldLabel } from "@executor/react/components/field";
import { FloatActions } from "@executor/react/components/float-actions";
import { Input } from "@executor/react/components/input";
import { Spinner } from "@executor/react/components/spinner";
import { HeadersList } from "@executor/react/plugins/headers-list";
import {
  displayNameFromUrl,
  slugifyNamespace,
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor/react/plugins/source-identity";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
import { type HeaderState, headersFromState } from "@executor/react/plugins/secret-header-auth";
import type { ManagedAuthAccess } from "@executor/react/plugins/source-plugin";

import { rawPresets } from "../sdk/presets";
import { ComposioSourceConfig } from "../sdk/types";
import { addRawSource, startRawComposioConnect } from "./atoms";

const RAW_COMPOSIO_CHANNEL = "executor:raw-composio-result";
const RAW_COMPOSIO_POPUP_NAME = "raw-composio";
const RAW_COMPOSIO_CALLBACK_PATH = "/api/raw/composio/callback";

const composioConnectionIdForNamespace = (namespace: string): string =>
  `raw-composio-${namespace || "default"}`;

const rawComposioCallbackUrl = (path: string): string => {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
};

type ComposioPopupResult =
  | { readonly ok: true; readonly connectionId?: string }
  | { readonly ok: false; readonly error?: string };

const openComposioPopup = (input: {
  readonly url: string;
  readonly allowedOrigins?: readonly string[];
  readonly onResult: (result: ComposioPopupResult) => void;
  readonly onOpenFailed: () => void;
  readonly onClosed: () => void;
}): (() => void) => {
  const width = 640;
  const height = 760;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;
  let settled = false;
  let poll: ReturnType<typeof setInterval> | null = null;
  const channel =
    typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(RAW_COMPOSIO_CHANNEL) : null;

  const finish = () => {
    if (settled) return true;
    settled = true;
    window.removeEventListener("message", onMessage);
    channel?.close();
    if (poll) clearInterval(poll);
    return false;
  };
  const handle = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    const payload =
      "payload" in value && typeof (value as { payload?: unknown }).payload === "object"
        ? (value as { payload?: unknown }).payload
        : value;
    if (typeof payload !== "object" || payload === null || !("ok" in payload)) return;
    if (finish()) return;
    input.onResult(payload as ComposioPopupResult);
  };
  function onMessage(event: MessageEvent) {
    const allowedOrigins = input.allowedOrigins ?? [window.location.origin];
    if (!allowedOrigins.includes(event.origin)) return;
    handle(event.data);
  }

  window.addEventListener("message", onMessage);
  if (channel) channel.onmessage = (event) => handle(event.data);

  const popup = window.open(
    input.url,
    RAW_COMPOSIO_POPUP_NAME,
    `width=${width},height=${height},left=${left},top=${top},popup=1`,
  );
  if (!popup) {
    finish();
    queueMicrotask(input.onOpenFailed);
    return () => {};
  }
  poll = setInterval(() => {
    if (!popup.closed) return;
    if (finish()) return;
    input.onClosed();
  }, 500);
  return () => {
    finish();
    try {
      popup.close();
    } catch {}
  };
};

export default function AddRawSource(props: {
  onComplete: (sourceId?: string) => void;
  onCancel: () => void;
  initialUrl?: string;
  initialPreset?: string;
  initialNamespace?: string;
  placement?: ReactNode;
  managedAuthAccess?: ManagedAuthAccess;
}) {
  const resolvedPreset = props.initialPreset
    ? (rawPresets.find((preset) => preset.id === props.initialPreset) ?? null)
    : null;

  const [baseUrl, setBaseUrl] = useState(props.initialUrl ?? resolvedPreset?.baseUrl ?? "");
  const identity = useSourceIdentity({
    fallbackName: resolvedPreset?.name ?? displayNameFromUrl(baseUrl) ?? "",
    fallbackNamespace: props.initialNamespace,
  });
  const [headers, setHeaders] = useState<HeaderState[]>([]);
  const [useManagedAuth, setUseManagedAuth] = useState(() => resolvedPreset?.composio != null);
  const [startingComposio, setStartingComposio] = useState(false);
  const [composioError, setComposioError] = useState<string | null>(null);
  const [composioConnectionId, setComposioConnectionId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const composioCleanup = useRef<(() => void) | null>(null);

  const scopeId = useScope();
  const doAdd = useAtomSet(addRawSource, { mode: "promise" });
  const doStartComposioConnect = useAtomSet(startRawComposioConnect, { mode: "promise" });
  const { beginAdd } = usePendingSources();
  const secretList = useSecretPickerSecrets();

  const namespaceSlug =
    slugifyNamespace(identity.namespace) ||
    slugifyNamespace(resolvedPreset?.name ?? displayNameFromUrl(baseUrl.trim()) ?? "") ||
    "raw";
  const displayName =
    identity.name.trim() ||
    resolvedPreset?.name ||
    displayNameFromUrl(baseUrl.trim()) ||
    namespaceSlug;
  const configuredHeaders = {
    ...(resolvedPreset?.defaultHeaders ?? {}),
    ...headersFromState(headers),
  };
  const presetHeaderEntries = Object.entries(resolvedPreset?.defaultHeaders ?? {});
  const headersValid = headers.every((header) => header.name.trim() && header.secretId);
  const isManagedPreset = resolvedPreset?.composio != null;
  const managedAuthAccess = props.managedAuthAccess ?? { state: "allowed" as const };
  const managedAuthAllowed = managedAuthAccess.state === "allowed";
  const derivedComposioConnectionId =
    composioConnectionId ?? composioConnectionIdForNamespace(namespaceSlug);
  const canAdd =
    baseUrl.trim().length > 0 &&
    (headers.length === 0 || headersValid) &&
    (!useManagedAuth || !isManagedPreset || composioConnectionId !== null);

  const handleConnectComposio = async () => {
    if (!resolvedPreset?.composio) return;
    if (managedAuthAccess.state === "sign-in") {
      await managedAuthAccess.onSignIn?.();
      return;
    }
    if (managedAuthAccess.state === "upgrade") {
      if (managedAuthAccess.onUpgrade) {
        await managedAuthAccess.onUpgrade();
      } else if (managedAuthAccess.href) {
        window.location.href = managedAuthAccess.href;
      }
      return;
    }
    if (!managedAuthAllowed) return;
    composioCleanup.current?.();
    composioCleanup.current = null;
    setStartingComposio(true);
    setComposioError(null);

    try {
      const payload = {
        callbackBaseUrl: rawComposioCallbackUrl(RAW_COMPOSIO_CALLBACK_PATH),
        app: resolvedPreset.composio.app,
        authConfigId: resolvedPreset.composio.authConfigId ?? null,
        connectionId: derivedComposioConnectionId,
        displayName,
      };
      const desktopCloudAuth = (
        window as Window & {
          readonly electronAPI?: {
            readonly cloudAuth?: {
              readonly startRawComposioConnect?: (
                input: typeof payload,
              ) => Promise<{ redirectUrl: string }>;
            };
          };
        }
      ).electronAPI?.cloudAuth;
      const response = desktopCloudAuth?.startRawComposioConnect
        ? await desktopCloudAuth.startRawComposioConnect(payload)
        : await doStartComposioConnect({
            path: { scopeId },
            payload,
          });
      const callbackOrigin = new URL(response.redirectUrl, window.location.href).origin;

      const cleanup = openComposioPopup({
        url: response.redirectUrl,
        allowedOrigins: Array.from(new Set([window.location.origin, callbackOrigin])),
        onOpenFailed: () => {
          setStartingComposio(false);
          setComposioError("Sign-in popup was blocked by the browser");
        },
        onClosed: () => {
          setStartingComposio(false);
          setComposioError("Connect cancelled before the managed auth flow completed.");
        },
        onResult: (result) => {
          setStartingComposio(false);
          if (result.ok) {
            setComposioConnectionId(result.connectionId ?? derivedComposioConnectionId);
            setComposioError(null);
          } else {
            setComposioError(result.error ?? "Managed auth failed");
          }
        },
      });
      composioCleanup.current = cleanup;
    } catch (e) {
      setStartingComposio(false);
      setComposioError(e instanceof Error ? e.message : "Failed to start managed auth");
    }
  };

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);

    const placeholder = beginAdd({
      id: namespaceSlug,
      name: displayName,
      kind: "raw",
      url: baseUrl.trim() || undefined,
    });

    try {
      const composioConfig =
        useManagedAuth && resolvedPreset?.composio
          ? new ComposioSourceConfig({
              kind: "composio",
              app: resolvedPreset.composio.app,
              authConfigId: resolvedPreset.composio.authConfigId ?? null,
              connectionId: derivedComposioConnectionId,
            })
          : null;
      const result = await doAdd({
        path: { scopeId },
        payload: {
          baseUrl: baseUrl.trim(),
          name: identity.name.trim() || undefined,
          namespace: slugifyNamespace(identity.namespace) || undefined,
          ...(Object.keys(configuredHeaders).length > 0 ? { headers: configuredHeaders } : {}),
          ...(composioConfig ? { composio: composioConfig, auth: composioConfig } : {}),
        },
        reactivityKeys: sourceWriteKeys,
      });
      props.onComplete(result.sourceId);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add source");
      setAdding(false);
    } finally {
      placeholder.done();
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <h1 className="text-xl font-semibold text-foreground">
        {resolvedPreset ? `Connect ${resolvedPreset.name}` : "Connect Raw HTTP"}
      </h1>
      {props.placement}

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField
            label="Base URL"
            hint="The model gets one fetch tool scoped to this base URL."
          >
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
              placeholder="https://api.example.com/v1"
              className="font-mono text-sm"
            />
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      <SourceIdentityFields identity={identity} />

      {isManagedPreset && (
        <section className="space-y-2.5">
          <FieldLabel>Auth</FieldLabel>
          <CardStack>
            <CardStackContent className="border-t-0">
              <CardStackEntry className="items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">Managed OAuth</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Pro. Stored in cloud and exposed to both local and cloud execution.
                  </div>
                </div>
                <Button
                  variant={composioConnectionId ? "outline" : "secondary"}
                  onClick={() => {
                    setUseManagedAuth(true);
                    void handleConnectComposio();
                  }}
                  disabled={startingComposio || managedAuthAccess.state === "loading"}
                >
                  {managedAuthAccess.state === "loading" ? (
                    "Checking..."
                  ) : managedAuthAccess.state === "sign-in" ? (
                    "Sign in"
                  ) : managedAuthAccess.state === "upgrade" ? (
                    "Upgrade to Pro"
                  ) : startingComposio ? (
                    <>
                      <Spinner className="mr-2 size-4" /> Connecting...
                    </>
                  ) : composioConnectionId ? (
                    "Reconnect"
                  ) : (
                    "Connect"
                  )}
                </Button>
              </CardStackEntry>
              <CardStackEntry className="items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">Manual headers</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Local credentials only. Add secrets below.
                  </div>
                </div>
                <Button
                  variant={!useManagedAuth ? "secondary" : "outline"}
                  onClick={() => setUseManagedAuth(false)}
                  disabled={startingComposio}
                >
                  Use manual
                </Button>
              </CardStackEntry>
            </CardStackContent>
          </CardStack>
          {composioError && <p className="text-sm text-destructive">{composioError}</p>}
        </section>
      )}

      <section className="space-y-2.5">
        <FieldLabel>Headers</FieldLabel>
        {presetHeaderEntries.length > 0 && (
          <CardStack>
            <CardStackContent className="[&>*+*]:before:inset-x-0">
              {presetHeaderEntries.map(([name, value]) => (
                <CardStackEntry key={name} className="items-center justify-between gap-4">
                  <span className="min-w-0 font-mono text-sm text-muted-foreground">{name}</span>
                  <span className="min-w-0 truncate font-mono text-sm text-foreground">
                    {value}
                  </span>
                </CardStackEntry>
              ))}
            </CardStackContent>
          </CardStack>
        )}
        <HeadersList
          headers={headers}
          onHeadersChange={setHeaders}
          existingSecrets={secretList}
          sourceName={displayName}
          emptyLabel={presetHeaderEntries.length > 0 ? "No additional headers" : "No headers"}
          initiallyPicking={headers.length === 0}
        />
      </section>

      {addError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{addError}</p>
        </div>
      )}

      <FloatActions>
        <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
          Cancel
        </Button>
        <Button onClick={handleAdd} disabled={!canAdd || adding || startingComposio}>
          {adding ? (
            <>
              <Spinner className="mr-2 size-4" /> Adding…
            </>
          ) : (
            "Add source"
          )}
        </Button>
      </FloatActions>
    </div>
  );
}

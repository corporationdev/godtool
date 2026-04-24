import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";

import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { usePendingSources } from "@executor/react/api/optimistic";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import { FieldLabel } from "@executor/react/components/field";
import { FloatActions } from "@executor/react/components/float-actions";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { RadioGroup, RadioGroupItem } from "@executor/react/components/radio-group";
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

import { rawPresets } from "../sdk/presets";
import { ComposioSourceConfig } from "../sdk/types";
import {
  addRawSource,
  startRawComposioConnect,
} from "./atoms";
import { rawComposioCallbackUrl } from "./composio-callback";

export const RAW_COMPOSIO_CHANNEL = "executor:raw-composio-result";
export const RAW_COMPOSIO_POPUP_NAME = "raw-composio";
export const RAW_COMPOSIO_CALLBACK_PATH = "/api/raw/composio/callback";

type StrategySelection = "composio" | "custom";

const composioConnectionIdForNamespace = (namespace: string): string =>
  `raw-composio-${namespace || "default"}`;

export default function AddRawSource(props: {
  onComplete: (sourceId?: string) => void;
  onCancel: () => void;
  initialUrl?: string;
  initialPreset?: string;
  initialNamespace?: string;
}) {
  const resolvedPreset = props.initialPreset
    ? (rawPresets.find((preset) => preset.id === props.initialPreset) ?? null)
    : null;

  const [baseUrl, setBaseUrl] = useState(
    props.initialUrl ?? resolvedPreset?.baseUrl ?? "",
  );
  const identity = useSourceIdentity({
    fallbackName: resolvedPreset?.name ?? displayNameFromUrl(baseUrl) ?? "",
    fallbackNamespace: props.initialNamespace,
  });
  const [headers, setHeaders] = useState<HeaderState[]>([]);
  const [strategy, setStrategy] = useState<StrategySelection>(
    resolvedPreset?.composio ? "composio" : "custom",
  );
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [startingComposio, setStartingComposio] = useState(false);
  const [composioError, setComposioError] = useState<string | null>(null);
  const [composioConnectionId, setComposioConnectionId] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const scopeId = useScope();
  const doAdd = useAtomSet(addRawSource, { mode: "promise" });
  const doStartComposioConnect = useAtomSet(startRawComposioConnect, {
    mode: "promise",
  });
  const { beginAdd } = usePendingSources();
  const secretList = useSecretPickerSecrets();

  useEffect(() => () => cleanupRef.current?.(), []);

  const namespaceSlug =
    slugifyNamespace(identity.namespace) ||
    slugifyNamespace(resolvedPreset?.name ?? displayNameFromUrl(baseUrl.trim()) ?? "") ||
    "raw";
  const displayName =
    identity.name.trim() || resolvedPreset?.name || displayNameFromUrl(baseUrl.trim()) || namespaceSlug;
  const derivedConnectionId =
    composioConnectionId ?? composioConnectionIdForNamespace(namespaceSlug);

  const headersValid = headers.every((header) => header.name.trim() && header.secretId);
  const canAdd =
    baseUrl.trim().length > 0 &&
    (strategy === "composio"
      ? composioConnectionId !== null
      : headers.length === 0 || headersValid);

  const handleConnectComposio = useCallback(async () => {
    if (!resolvedPreset?.composio) return;
    cleanupRef.current?.();
    cleanupRef.current = null;
    setStartingComposio(true);
    setComposioError(null);

    try {
      const response = await doStartComposioConnect({
        path: { scopeId },
        payload: {
          callbackBaseUrl: rawComposioCallbackUrl(RAW_COMPOSIO_CALLBACK_PATH),
          app: resolvedPreset.composio.app,
          authConfigId: resolvedPreset.composio.authConfigId ?? null,
          connectionId: derivedConnectionId,
          displayName,
        },
      });

      const popup = window.open(
        response.redirectUrl,
        RAW_COMPOSIO_POPUP_NAME,
        "width=600,height=700,scrollbars=yes",
      );
      if (!popup) {
        setStartingComposio(false);
        setComposioError("Sign-in popup was blocked by the browser");
        return;
      }

      const channel = new BroadcastChannel(RAW_COMPOSIO_CHANNEL);
      const onMessage = (event: MessageEvent) => {
        cleanup();
        const data = event.data as { ok: boolean; connectionId?: string; error?: string };
        setStartingComposio(false);
        if (data.ok) {
          setComposioConnectionId(data.connectionId ?? derivedConnectionId);
          setComposioError(null);
        } else {
          setComposioError(data.error ?? "Managed auth failed");
        }
      };
      channel.addEventListener("message", onMessage);

      const popupTimer = setInterval(() => {
        if (popup.closed) {
          cleanup();
          setStartingComposio(false);
          setComposioError("Connect cancelled — popup was closed before completing the flow.");
        }
      }, 500);

      const cleanup = () => {
        clearInterval(popupTimer);
        channel.removeEventListener("message", onMessage);
        channel.close();
        cleanupRef.current = null;
      };
      cleanupRef.current = cleanup;
    } catch (e) {
      setStartingComposio(false);
      setComposioError(e instanceof Error ? e.message : "Failed to start managed auth");
    }
  }, [
    derivedConnectionId,
    displayName,
    doStartComposioConnect,
    resolvedPreset?.composio,
    scopeId,
  ]);

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);

    const configuredHeaders = {
      ...(resolvedPreset?.defaultHeaders ?? {}),
      ...(strategy === "custom" ? headersFromState(headers) : {}),
    };

    const composioConfig =
      strategy === "composio" && resolvedPreset?.composio
        ? new ComposioSourceConfig({
            kind: "composio",
            app: resolvedPreset.composio.app,
            authConfigId: resolvedPreset.composio.authConfigId ?? null,
            connectionId: derivedConnectionId,
          })
        : null;

    const placeholder = beginAdd({
      id: namespaceSlug,
      name: displayName,
      kind: "raw",
      url: baseUrl.trim() || undefined,
    });

    try {
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
      <h1 className="text-xl font-semibold text-foreground">Add Raw Source</h1>

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

      {resolvedPreset?.composio ? (
        <section className="space-y-3">
          <FieldLabel>Auth Strategy</FieldLabel>
          <RadioGroup
            value={strategy}
            onValueChange={(value) => setStrategy(value as StrategySelection)}
            className="space-y-2"
          >
            <Label className="flex items-start gap-3 rounded-lg border border-border px-4 py-3">
              <RadioGroupItem value="composio" className="mt-0.5" />
              <div className="space-y-1">
                <span className="text-sm font-medium text-foreground">Managed auth</span>
                <p className="text-sm text-muted-foreground">
                  Connect through the managed provider and proxy requests using the managed account.
                </p>
              </div>
            </Label>
            <Label className="flex items-start gap-3 rounded-lg border border-border px-4 py-3">
              <RadioGroupItem value="custom" className="mt-0.5" />
              <div className="space-y-1">
                <span className="text-sm font-medium text-foreground">Custom headers</span>
                <p className="text-sm text-muted-foreground">
                  Send requests directly using headers you configure on this source.
                </p>
              </div>
            </Label>
          </RadioGroup>
        </section>
      ) : null}

      {strategy === "composio" ? (
        <section className="space-y-2">
          <FieldLabel>Managed Auth</FieldLabel>
          <div className="rounded-lg border border-border bg-background/40 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-foreground">
                    {resolvedPreset?.name ?? "Managed account"}
                  </p>
                  {composioConnectionId ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-600 dark:text-green-400">
                      <span className="size-2 rounded-full bg-green-500" />
                      Connected
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  {startingComposio
                    ? "Waiting for connection… finish the flow in the popup."
                    : composioConnectionId
                      ? "Connected. Requests will run through the managed account."
                      : "Sign in to route requests through the managed account."}
                </p>
              </div>
              {startingComposio ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      cleanupRef.current?.();
                      cleanupRef.current = null;
                      setStartingComposio(false);
                      setComposioError(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleConnectComposio()}
                  >
                    <Spinner className="mr-2 size-4" />
                    Connecting…
                  </Button>
                </div>
              ) : (
                <Button
                  variant={composioConnectionId ? "outline" : "secondary"}
                  onClick={() => void handleConnectComposio()}
                >
                  {composioConnectionId ? "Reconnect" : "Sign in"}
                </Button>
              )}
            </div>
          </div>
          {composioError && <p className="text-sm text-destructive">{composioError}</p>}
        </section>
      ) : (
        <section className="space-y-2">
          <FieldLabel>Headers</FieldLabel>
          <HeadersList
            headers={headers}
            onHeadersChange={setHeaders}
            existingSecrets={secretList}
            sourceName={displayName}
            emptyLabel="No headers"
          />
        </section>
      )}

      {addError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{addError}</p>
        </div>
      )}

      <FloatActions>
        <Button variant="ghost" onClick={props.onCancel} disabled={adding || startingComposio}>
          Cancel
        </Button>
        <Button onClick={() => void handleAdd()} disabled={!canAdd || adding || startingComposio}>
          {adding ? "Adding…" : "Add source"}
        </Button>
      </FloatActions>
    </div>
  );
}

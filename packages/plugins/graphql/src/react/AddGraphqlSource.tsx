import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";

import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { usePendingSources } from "@executor/react/api/optimistic";
import { HeadersList } from "@executor/react/plugins/headers-list";
import { type HeaderState } from "@executor/react/plugins/secret-header-auth";
import {
  displayNameFromUrl,
  slugifyNamespace,
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor/react/plugins/source-identity";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
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
import {
  addGraphqlSource,
  startGraphqlComposioConnect,
} from "./atoms";
import { graphqlComposioCallbackUrl } from "./composio-callback";
import { graphqlPresets } from "../sdk/presets";
import {
  ComposioSourceConfig,
  type HeaderValue,
} from "../sdk/types";

export const GRAPHQL_COMPOSIO_CHANNEL = "executor:graphql-composio-result";
export const GRAPHQL_COMPOSIO_POPUP_NAME = "graphql-composio";
export const GRAPHQL_COMPOSIO_CALLBACK_PATH = "/api/graphql/composio/callback";

const initialHeader = (): HeaderState => ({
  name: "Authorization",
  prefix: "Bearer ",
  presetKey: "bearer",
  secretId: null,
});

type StrategySelection = "composio" | "custom" | "none";

const composioConnectionIdForNamespace = (namespace: string): string =>
  `graphql-composio-${namespace || "default"}`;

export default function AddGraphqlSource(props: {
  onComplete: (sourceId?: string) => void;
  onCancel: () => void;
  initialUrl?: string;
  initialPreset?: string;
  initialNamespace?: string;
}) {
  const resolvedPreset = props.initialPreset
    ? (graphqlPresets.find((preset) => preset.id === props.initialPreset) ?? null)
    : null;

  const [endpoint, setEndpoint] = useState(props.initialUrl ?? resolvedPreset?.url ?? "");
  const identity = useSourceIdentity({
    fallbackName: displayNameFromUrl(endpoint) ?? "",
    fallbackNamespace: props.initialNamespace,
  });
  const [customHeaders, setCustomHeaders] = useState<HeaderState[]>([initialHeader()]);
  const [strategy, setStrategy] = useState<StrategySelection>(
    resolvedPreset?.composio ? "composio" : "custom",
  );
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [startingComposio, setStartingComposio] = useState(false);
  const [composioError, setComposioError] = useState<string | null>(null);
  const [composioConnectionId, setComposioConnectionId] = useState<string | null>(null);
  const composioCleanup = useRef<(() => void) | null>(null);

  const scopeId = useScope();
  const doAdd = useAtomSet(addGraphqlSource, { mode: "promise" });
  const doStartComposioConnect = useAtomSet(startGraphqlComposioConnect, {
    mode: "promise",
  });
  const { beginAdd } = usePendingSources();
  const secretList = useSecretPickerSecrets();

  useEffect(() => () => composioCleanup.current?.(), []);

  const namespaceSlug =
    slugifyNamespace(identity.namespace) ||
    slugifyNamespace(displayNameFromUrl(endpoint.trim()) ?? "") ||
    "graphql";
  const displayName = identity.name.trim() || displayNameFromUrl(endpoint.trim()) || namespaceSlug;
  const derivedComposioConnectionId =
    composioConnectionId ?? composioConnectionIdForNamespace(namespaceSlug);

  const headersValid = customHeaders.every((header) => header.name.trim() && header.secretId);
  const canAdd =
    endpoint.trim().length > 0 &&
    (strategy === "composio"
      ? composioConnectionId !== null
      : strategy === "custom"
        ? customHeaders.length === 0 || headersValid
        : true);

  const handleConnectComposio = useCallback(async () => {
    if (!resolvedPreset?.composio) return;
    composioCleanup.current?.();
    composioCleanup.current = null;
    setStartingComposio(true);
    setComposioError(null);

    const callbackBaseUrl = graphqlComposioCallbackUrl(
      GRAPHQL_COMPOSIO_CALLBACK_PATH,
    );

    try {
      const response = await doStartComposioConnect({
        path: { scopeId },
        payload: {
          callbackBaseUrl,
          app: resolvedPreset.composio.app,
          authConfigId: resolvedPreset.composio.authConfigId ?? null,
          connectionId: derivedComposioConnectionId,
          displayName,
        },
      });

      const popup = window.open(
        response.redirectUrl,
        GRAPHQL_COMPOSIO_POPUP_NAME,
        "width=600,height=700,scrollbars=yes",
      );
      if (!popup) {
        setStartingComposio(false);
        setComposioError("Sign-in popup was blocked by the browser");
        return;
      }

      const channel = new BroadcastChannel(GRAPHQL_COMPOSIO_CHANNEL);
      const onMessage = (event: MessageEvent) => {
        cleanup();
        const data = event.data as { ok: boolean; connectionId?: string; error?: string };
        setStartingComposio(false);
        if (data.ok) {
          setComposioConnectionId(data.connectionId ?? derivedComposioConnectionId);
          setComposioError(null);
        } else {
          setComposioError(data.error ?? "Managed OAuth failed");
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
        composioCleanup.current = null;
      };
      composioCleanup.current = cleanup;
    } catch (e) {
      setStartingComposio(false);
      setComposioError(e instanceof Error ? e.message : "Failed to start managed auth");
    }
  }, [
    derivedComposioConnectionId,
    displayName,
    doStartComposioConnect,
    resolvedPreset?.composio,
    scopeId,
  ]);

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);

    const headerMap: Record<string, HeaderValue> = {};
    if (strategy === "custom") {
      for (const header of customHeaders) {
        const name = header.name.trim();
        if (name && header.secretId) {
          headerMap[name] = {
            secretId: header.secretId,
            ...(header.prefix ? { prefix: header.prefix } : {}),
          };
        }
      }
    }

    const composioConfig =
      strategy === "composio" && resolvedPreset?.composio
        ? new ComposioSourceConfig({
            kind: "composio",
            app: resolvedPreset.composio.app,
            authConfigId: resolvedPreset.composio.authConfigId ?? null,
            connectionId: derivedComposioConnectionId,
          })
        : null;

    const trimmedEndpoint = endpoint.trim();
    const placeholder = beginAdd({
      id: namespaceSlug,
      name: displayName,
      kind: "graphql",
      url: trimmedEndpoint || undefined,
    });

    try {
      const result = await doAdd({
        path: { scopeId },
        payload: {
          endpoint: trimmedEndpoint,
          name: identity.name.trim() || undefined,
          namespace: slugifyNamespace(identity.namespace) || undefined,
          ...(Object.keys(headerMap).length > 0 ? { headers: headerMap } : {}),
          ...(composioConfig ? { composio: composioConfig, auth: composioConfig } : {}),
        },
        reactivityKeys: sourceWriteKeys,
      });
      props.onComplete(result.namespace);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add source");
      setAdding(false);
    } finally {
      placeholder.done();
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <h1 className="text-xl font-semibold text-foreground">Add GraphQL Source</h1>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField
            label="Endpoint"
            hint="The endpoint will be introspected to discover available queries and mutations."
          >
            <Input
              value={endpoint}
              onChange={(e) => setEndpoint((e.target as HTMLInputElement).value)}
              placeholder="https://api.example.com/graphql"
              className="font-mono text-sm"
            />
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      <SourceIdentityFields
        identity={identity}
        namePlaceholder="e.g. Linear API"
      />

      {resolvedPreset?.composio ? (
        <section className="space-y-2.5">
          <FieldLabel>Authentication</FieldLabel>
          <RadioGroup
            value={strategy}
            onValueChange={(value) => setStrategy(value as StrategySelection)}
            className="gap-1.5"
          >
            <Label
              className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                strategy === "composio"
                  ? "border-primary/50 bg-primary/[0.03]"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              <RadioGroupItem value="composio" className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-foreground">Managed OAuth</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  Connect your account with Composio
                </div>
              </div>
            </Label>
            <Label
              className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                strategy === "custom"
                  ? "border-primary/50 bg-primary/[0.03]"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              <RadioGroupItem value="custom" className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-foreground">Custom headers</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  Bring your own API key or bearer token
                </div>
              </div>
            </Label>
            <Label
              className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                strategy === "none"
                  ? "border-primary/50 bg-primary/[0.03]"
                  : "border-border hover:bg-accent/50"
              }`}
            >
              <RadioGroupItem value="none" className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-foreground">None</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  Use the endpoint without auth
                </div>
              </div>
            </Label>
          </RadioGroup>

          {strategy === "custom" && (
            <HeadersList
              headers={customHeaders}
              onHeadersChange={setCustomHeaders}
              existingSecrets={secretList}
              sourceName={identity.name}
            />
          )}

          {strategy === "composio" && (
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3">
              {composioConnectionId ? (
                <div className="flex items-center justify-between rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2">
                  <div className="text-[11px] text-green-700 dark:text-green-400">
                    Connected
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setComposioConnectionId(null)}
                  >
                    Disconnect
                  </Button>
                </div>
              ) : startingComposio ? (
                <div className="flex items-center gap-2">
                  <div className="flex flex-1 items-center gap-2 rounded-md border border-border/60 bg-background/50 px-3 py-2 text-[11px] text-muted-foreground">
                    <Spinner className="size-3.5" />
                    Waiting for connection… complete the flow in the popup, or cancel to retry.
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      composioCleanup.current?.();
                      composioCleanup.current = null;
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
                    Retry
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => void handleConnectComposio()}
                  className="w-full"
                >
                  Connect
                </Button>
              )}

              {composioError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                  <p className="text-[11px] text-destructive">{composioError}</p>
                </div>
              )}
            </div>
          )}
        </section>
      ) : (
        <section className="space-y-2.5">
          <FieldLabel>Headers</FieldLabel>
          <HeadersList
            headers={customHeaders}
            onHeadersChange={setCustomHeaders}
            existingSecrets={secretList}
            sourceName={identity.name}
          />
        </section>
      )}

      {addError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{addError}</p>
        </div>
      )}

      <FloatActions>
        <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
          Cancel
        </Button>
        <Button onClick={handleAdd} disabled={!canAdd || adding}>
          {adding && <Spinner className="size-3.5" />}
          {adding ? "Adding..." : "Add source"}
        </Button>
      </FloatActions>
    </div>
  );
}

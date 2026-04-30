import { useState } from "react";
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
import { SourceAdvancedSettings } from "@executor/react/plugins/source-advanced-settings";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
import {
  startManagedAuthConnect,
  isDesktopManagedAuth,
  useManagedAuthAccess,
  type ManagedAuthConnectResult,
} from "@executor/react/plugins/managed-auth";
import { type HeaderState, headersFromState } from "@executor/react/plugins/secret-header-auth";

import { rawPresets } from "../sdk/presets";
import { addRawSource } from "./atoms";

const goToBilling = () => {
  window.location.href = "/settings/billing";
};

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

  const [baseUrl, setBaseUrl] = useState(props.initialUrl ?? resolvedPreset?.baseUrl ?? "");
  const identity = useSourceIdentity({
    fallbackName: resolvedPreset?.name ?? displayNameFromUrl(baseUrl) ?? "",
    fallbackNamespace: props.initialNamespace,
  });
  const [headers, setHeaders] = useState<HeaderState[]>([]);
  const [managedAuth, setManagedAuth] = useState<ManagedAuthConnectResult | null>(null);
  const [connectingManagedAuth, setConnectingManagedAuth] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const scopeId = useScope();
  const doAdd = useAtomSet(addRawSource, { mode: "promise" });
  const { beginAdd } = usePendingSources();
  const secretList = useSecretPickerSecrets();
  const managedAuthAccess = useManagedAuthAccess();

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
  const managedAuthApp = resolvedPreset?.composio?.app ?? null;
  const supportsManagedAuth = managedAuthApp !== null;
  const canAdd =
    baseUrl.trim().length > 0 && (managedAuth !== null || headers.length === 0 || headersValid);

  const handleManagedAuth = async () => {
    if (!managedAuthApp) return;
    setConnectingManagedAuth(true);
    setAddError(null);
    try {
      const result = await startManagedAuthConnect({
        app: managedAuthApp,
        provider: "raw-composio",
        placement: isDesktopManagedAuth() ? "local" : "cloud",
      });
      setManagedAuth(result);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "Failed to connect managed auth");
    } finally {
      setConnectingManagedAuth(false);
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
      const result = await doAdd({
        path: { scopeId },
        payload: {
          baseUrl: baseUrl.trim(),
          name: identity.name.trim() || undefined,
          namespace: slugifyNamespace(identity.namespace) || undefined,
          ...(Object.keys(configuredHeaders).length > 0 ? { headers: configuredHeaders } : {}),
          ...(managedAuth
            ? {
                managedAuth: managedAuth.managedAuth,
                managedConnection: managedAuth.managedConnection,
              }
            : {}),
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

      {supportsManagedAuth && (
        <section className="space-y-2.5">
          <FieldLabel>Managed OAuth</FieldLabel>
          <CardStack>
            <CardStackContent className="border-t-0">
              <CardStackEntry className="items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {managedAuth ? "Connected with managed auth" : "Let GOD TOOL manage OAuth"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {isDesktopManagedAuth()
                      ? "This source stays local. Requests use your cloud sign-in without storing OAuth secrets on this Mac."
                      : "Credentials are stored in Composio for this cloud source."}
                  </p>
                </div>
                <Button
                  type="button"
                  variant={managedAuth ? "outline" : "default"}
                  onClick={
                    managedAuth || managedAuthAccess.allowed ? handleManagedAuth : goToBilling
                  }
                  disabled={managedAuthAccess.loading || connectingManagedAuth || adding}
                >
                  {managedAuthAccess.loading
                    ? "Checking..."
                    : connectingManagedAuth
                      ? "Connecting..."
                      : managedAuth
                        ? "Reconnect"
                        : managedAuthAccess.allowed
                          ? "Connect"
                          : "Upgrade to Pro"}
                </Button>
              </CardStackEntry>
            </CardStackContent>
          </CardStack>
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

      <SourceAdvancedSettings>
        <SourceIdentityFields identity={identity} asEntries />
      </SourceAdvancedSettings>

      {addError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{addError}</p>
        </div>
      )}

      <FloatActions>
        <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
          Cancel
        </Button>
        <Button onClick={handleAdd} disabled={!canAdd || adding}>
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

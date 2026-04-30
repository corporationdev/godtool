import { useState } from "react";
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
import { SourceAdvancedSettings } from "@executor/react/plugins/source-advanced-settings";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
import {
  startManagedAuthConnect,
  isDesktopManagedAuth,
  useManagedAuthAccess,
  managedAuthCtaLabel,
  type ManagedAuthConnectResult,
} from "@executor/react/plugins/managed-auth";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import { FieldLabel } from "@executor/react/components/field";
import { FloatActions } from "@executor/react/components/float-actions";
import { Input } from "@executor/react/components/input";
import { Spinner } from "@executor/react/components/spinner";
import { addGraphqlSource } from "./atoms";
import type { HeaderValue } from "../sdk/types";

const goToBilling = () => {
  window.location.href = "/settings/billing";
};

const initialHeader = (): HeaderState => ({
  name: "Authorization",
  prefix: "Bearer ",
  presetKey: "bearer",
  secretId: null,
});

export default function AddGraphqlSource(props: {
  onComplete: (sourceId?: string) => void;
  onCancel: () => void;
  initialUrl?: string;
}) {
  const [endpoint, setEndpoint] = useState(props.initialUrl ?? "");
  const identity = useSourceIdentity({
    fallbackName: displayNameFromUrl(endpoint) ?? "",
  });
  const [headers, setHeaders] = useState<HeaderState[]>([initialHeader()]);
  const [managedAuth, setManagedAuth] = useState<ManagedAuthConnectResult | null>(null);
  const [connectingManagedAuth, setConnectingManagedAuth] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const scopeId = useScope();
  const doAdd = useAtomSet(addGraphqlSource, { mode: "promise" });
  const { beginAdd } = usePendingSources();
  const secretList = useSecretPickerSecrets();
  const managedAuthAccess = useManagedAuthAccess();

  const headersValid = headers.every((header) => header.name.trim() && header.secretId);
  const managedAuthApp = endpoint.includes("github.com")
    ? "github"
    : endpoint.includes("linear.app")
      ? "linear"
      : endpoint.includes("gitlab.com")
        ? "gitlab"
        : endpoint.includes("monday.com")
          ? "monday"
          : null;
  const canAdd =
    endpoint.trim().length > 0 && (managedAuth !== null || headers.length === 0 || headersValid);

  const handleManagedAuth = async () => {
    if (!managedAuthApp) return;
    setConnectingManagedAuth(true);
    setAddError(null);
    try {
      const result = await startManagedAuthConnect({
        app: managedAuthApp,
        provider: "graphql-composio",
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
    const headerMap: Record<string, HeaderValue> = {};
    for (const header of headers) {
      const name = header.name.trim();
      if (name && header.secretId) {
        headerMap[name] = {
          secretId: header.secretId,
          ...(header.prefix ? { prefix: header.prefix } : {}),
        };
      }
    }

    const trimmedEndpoint = endpoint.trim();
    const namespace =
      slugifyNamespace(identity.namespace) ||
      slugifyNamespace(displayNameFromUrl(trimmedEndpoint) ?? "") ||
      "graphql";
    const displayName = identity.name.trim() || displayNameFromUrl(trimmedEndpoint) || namespace;
    const placeholder = beginAdd({
      id: namespace,
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
          ...(managedAuth
            ? {
                managedAuth: managedAuth.managedAuth,
                managedConnection: managedAuth.managedConnection,
              }
            : {}),
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

      {managedAuthApp && (
        <section className="space-y-2.5">
          <FieldLabel>Managed OAuth</FieldLabel>
          <CardStack>
            <CardStackContent className="border-t-0">
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {managedAuth ? "Connected with managed auth" : "Let GOD TOOL manage OAuth"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {isDesktopManagedAuth()
                      ? "This local source uses your cloud sign-in without storing OAuth secrets on this Mac."
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
                        : managedAuthCtaLabel(managedAuthAccess)}
                </Button>
              </div>
            </CardStackContent>
          </CardStack>
        </section>
      )}

      <section className="space-y-2.5">
        <FieldLabel>Headers</FieldLabel>
        <HeadersList
          headers={headers}
          onHeadersChange={setHeaders}
          existingSecrets={secretList}
          sourceName={identity.name}
        />
      </section>

      <SourceAdvancedSettings>
        <SourceIdentityFields identity={identity} namePlaceholder="e.g. Shopify API" asEntries />
      </SourceAdvancedSettings>

      {/* Error */}
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

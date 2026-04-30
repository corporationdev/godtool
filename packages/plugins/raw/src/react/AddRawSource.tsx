import { useState, type ReactNode } from "react";
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

import { rawPresets } from "../sdk/presets";
import { addRawSource } from "./atoms";

export default function AddRawSource(props: {
  onComplete: (sourceId?: string) => void;
  onCancel: () => void;
  initialUrl?: string;
  initialPreset?: string;
  initialNamespace?: string;
  placement?: ReactNode;
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
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const scopeId = useScope();
  const doAdd = useAtomSet(addRawSource, { mode: "promise" });
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
  const canAdd = baseUrl.trim().length > 0 && (headers.length === 0 || headersValid);

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

import { useState } from "react";
import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react";

import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { Badge } from "@executor/react/components/badge";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import { FieldLabel } from "@executor/react/components/field";
import { Input } from "@executor/react/components/input";
import { HeadersList } from "@executor/react/plugins/headers-list";
import {
  type HeaderState,
  headerValueToState,
  headersFromState,
} from "@executor/react/plugins/secret-header-auth";
import {
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor/react/plugins/source-identity";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";

import type { StoredRawSource } from "../sdk/store";
import { rawSourceAtom, updateRawSource } from "./atoms";

type EditableSource = Omit<StoredRawSource, "scope">;

function EditForm(props: {
  sourceId: string;
  initial: EditableSource;
  onSave: () => void;
}) {
  const scopeId = useScope();
  const doUpdate = useAtomSet(updateRawSource, { mode: "promise" });
  const secretList = useSecretPickerSecrets();

  const identity = useSourceIdentity({
    fallbackName: props.initial.name,
    fallbackNamespace: props.initial.namespace,
  });
  const [baseUrl, setBaseUrl] = useState(props.initial.baseUrl);
  const [headers, setHeaders] = useState<HeaderState[]>(() =>
    Object.entries(props.initial.headers ?? {}).map(([name, value]) =>
      headerValueToState(name, value),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const identityDirty = identity.name.trim() !== props.initial.name.trim();

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await doUpdate({
        path: { scopeId, namespace: props.sourceId },
        payload: {
          name: identity.name.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          headers: headersFromState(headers),
        },
        reactivityKeys: sourceWriteKeys,
      });
      setDirty(false);
      props.onSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update source");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Edit Raw Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Update the base URL and request headers for this source.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.sourceId}</p>
        </div>
        <Badge variant="secondary" className="text-xs">
          Raw
        </Badge>
      </div>

      <SourceIdentityFields identity={identity} namespaceReadOnly />

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField label="Base URL">
            <Input
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl((e.target as HTMLInputElement).value);
                setDirty(true);
              }}
              placeholder="https://api.example.com/v1"
              className="font-mono text-sm"
            />
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      <section className="space-y-2.5">
        <FieldLabel>Headers</FieldLabel>
        <HeadersList
          headers={headers}
          onHeadersChange={(next) => {
            setHeaders(next);
            setDirty(true);
          }}
          existingSecrets={secretList}
          sourceName={identity.name}
          emptyLabel="No headers"
        />
      </section>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onClick={props.onSave}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={(!dirty && !identityDirty) || saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

export default function EditRawSource(props: { sourceId: string; onSave: () => void }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(rawSourceAtom(scopeId, props.sourceId));

  if (!Result.isSuccess(sourceResult) || !sourceResult.value) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Edit Raw Source</h1>
          <p className="mt-1 text-sm text-muted-foreground">Loading configuration…</p>
        </div>
      </div>
    );
  }

  return <EditForm sourceId={props.sourceId} initial={sourceResult.value} onSave={props.onSave} />;
}

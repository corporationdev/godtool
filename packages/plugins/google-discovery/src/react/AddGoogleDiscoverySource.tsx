import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet, useAtomValue, Result } from "@effect-atom/atom-react";

import {
  openOAuthPopup,
  type OAuthPopupResult,
} from "@executor/plugin-oauth2/react";

import { secretsAtom, setSecret } from "@executor/react/api/atoms";
import { usePendingSources } from "@executor/react/api/optimistic";
import { secretWriteKeys, sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { useScope } from "@executor/react/api/scope-context";
import { SecretPicker, type SecretPickerSecret } from "@executor/react/plugins/secret-picker";
import { SecretId } from "@executor/sdk";
import { Badge } from "@executor/react/components/badge";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor/react/components/card-stack";
import {
  SourceIdentityFields,
  slugifyNamespace,
  useSourceIdentity,
} from "@executor/react/plugins/source-identity";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@executor/react/components/collapsible";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@executor/react/components/field";
import { FilterTabs } from "@executor/react/components/filter-tabs";
import { FloatActions } from "@executor/react/components/float-actions";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { RadioGroup, RadioGroupItem } from "@executor/react/components/radio-group";
import { IOSSpinner, Spinner } from "@executor/react/components/spinner";
import {
  GOOGLE_DISCOVERY_FALLBACK_ICON,
  googleDiscoveryPresets,
  type GoogleDiscoveryPreset,
} from "../sdk/presets";
import {
  addGoogleDiscoverySource,
  probeGoogleDiscovery,
  startGoogleDiscoveryComposioConnect,
  startGoogleDiscoveryOAuth,
} from "./atoms";
import { googleDiscoveryComposioCallbackUrl } from "./composio-callback";

type GoogleAuthKind = "none" | "oauth2" | "composio";

export const GOOGLE_DISCOVERY_COMPOSIO_CHANNEL =
  "executor:google-discovery-composio-result";
export const GOOGLE_DISCOVERY_COMPOSIO_POPUP_NAME = "google-discovery-composio";
export const GOOGLE_DISCOVERY_COMPOSIO_CALLBACK_PATH =
  "/api/google-discovery/composio/callback";

// ---------------------------------------------------------------------------
// Inline secret creation
// ---------------------------------------------------------------------------

function InlineCreateSecret(props: {
  headerName: string;
  suggestedId: string;
  onCreated: (secretId: string) => void;
  onCancel: () => void;
}) {
  const [secretId, setSecretIdValue] = useState(props.suggestedId);
  const [secretName, setSecretName] = useState(props.headerName);
  const [secretValue, setSecretValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeId = useScope();
  const doSet = useAtomSet(setSecret, { mode: "promise" });

  const handleSave = async () => {
    if (!secretId.trim() || !secretValue.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await doSet({
        path: { scopeId },
        payload: {
          id: SecretId.make(secretId.trim()),
          name: secretName.trim() || secretId.trim(),
          value: secretValue.trim(),
        },
        reactivityKeys: [...secretWriteKeys],
      });
      props.onCreated(secretId.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save secret");
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/[0.02] p-3 space-y-2.5">
      <p className="text-[11px] font-semibold text-primary tracking-wide uppercase">New secret</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">ID</Label>
          <Input
            value={secretId}
            onChange={(e) => setSecretIdValue((e.target as HTMLInputElement).value)}
            placeholder="google-client-secret"
            className="h-8 text-xs font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Label
          </Label>
          <Input
            value={secretName}
            onChange={(e) => setSecretName((e.target as HTMLInputElement).value)}
            placeholder="Client Secret"
            className="h-8 text-xs"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Value</Label>
        <Input
          type="password"
          value={secretValue}
          onChange={(e) => setSecretValue((e.target as HTMLInputElement).value)}
          placeholder="paste your client secret…"
          className="h-8 text-xs font-mono"
        />
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <div className="flex justify-end gap-1.5 pt-0.5">
        <Button variant="outline" size="xs" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={handleSave}
          disabled={!secretId.trim() || !secretValue.trim() || saving}
        >
          {saving ? "Saving…" : "Create and use"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Client secret field with inline creation
// ---------------------------------------------------------------------------

function SecretBackedField(props: {
  label: string;
  suggestedSecretId: string;
  headerName: string;
  secretId: string | null;
  onSelect: (secretId: string | null) => void;
  secretList: readonly SecretPickerSecret[];
  placeholder: string;
  clearable?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const { label, secretId, onSelect, secretList, placeholder, clearable = true } = props;

  if (creating) {
    return (
      <div className="space-y-2">
        <Label>{label}</Label>
        <InlineCreateSecret
          headerName={props.headerName}
          suggestedId={props.suggestedSecretId}
          onCreated={(id) => {
            onSelect(id);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <SecretPicker
            value={secretId}
            onSelect={onSelect}
            secrets={secretList}
            placeholder={placeholder}
          />
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setCreating(true)}>
          + New
        </Button>
        {clearable && secretId && (
          <Button variant="outline" onClick={() => onSelect(null)}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

function GoogleServiceIcon(props: { readonly icon?: string; readonly className?: string }) {
  const { icon, className = "size-11" } = props;
  const src = icon ?? GOOGLE_DISCOVERY_FALLBACK_ICON;

  return (
    <img
      alt=""
      aria-hidden="true"
      className={`${className} shrink-0 object-contain`}
      decoding="async"
      draggable={false}
      loading="lazy"
      src={src}
    />
  );
}

type ProbeOperation = {
  toolPath: string;
  method: string;
  pathTemplate: string;
  description: string | null;
};

type ProbeResult = {
  name: string;
  title: string | null;
  service: string;
  version: string;
  toolCount: number;
  scopes: readonly string[];
  operations: readonly ProbeOperation[];
};

type OAuthAuth = {
  kind: "oauth2";
  connectionId: string;
  clientIdSecretId: string;
  clientSecretSecretId: string | null;
  scopes: string[];
};

type ComposioAuth = {
  kind: "composio";
  app: string;
  authConfigId: string | null;
  connectionId: string;
};

type GoogleOAuthPopupResult = OAuthPopupResult<OAuthAuth>;

const OAUTH_RESULT_CHANNEL = "executor:google-discovery-oauth-result";
const OAUTH_POPUP_NAME = "google-discovery-oauth";
const composioConnectionIdForNamespace = (namespace: string): string =>
  `google-discovery-composio-${namespace || "default"}`;

export default function AddGoogleDiscoverySource(props: {
  readonly onComplete: (sourceId?: string) => void;
  readonly onCancel: () => void;
  readonly initialUrl?: string;
  readonly initialPreset?: string;
}) {
  const fallbackTemplate =
    googleDiscoveryPresets.find((preset) => preset.id === "google-sheets") ??
    googleDiscoveryPresets[0]!;
  const initialTemplate =
    (props.initialPreset
      ? googleDiscoveryPresets.find((preset) => preset.id === props.initialPreset)
      : null) ??
    (props.initialUrl
      ? googleDiscoveryPresets.find((preset) => preset.url === props.initialUrl)
      : null);
  const lockedPreset = props.initialPreset ? initialTemplate : null;
  const [discoveryUrl, setDiscoveryUrl] = useState(
    props.initialUrl ?? initialTemplate?.url ?? fallbackTemplate.url,
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    initialTemplate?.id ?? (props.initialUrl ? "" : fallbackTemplate.id),
  );
  const selectedTemplate =
    googleDiscoveryPresets.find((preset) => preset.id === selectedTemplateId) ?? null;
  const matchedTemplate = useMemo(
    () =>
      googleDiscoveryPresets.find((preset) => preset.url === discoveryUrl.trim()) ?? null,
    [discoveryUrl],
  );
  const activeTemplate = selectedTemplate ?? matchedTemplate;
  const [authKind, setAuthKind] = useState<GoogleAuthKind>(
    activeTemplate?.composio ? "composio" : "oauth2",
  );
  const [clientIdSecretId, setClientIdSecretId] = useState<string | null>(null);
  const [clientSecretSecretId, setClientSecretSecretId] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const identity = useSourceIdentity({
    fallbackName: probe?.name ?? activeTemplate?.name ?? "",
  });
  const [oauthAuth, setOauthAuth] = useState<OAuthAuth | null>(null);
  const [composioAuth, setComposioAuth] = useState<ComposioAuth | null>(null);
  const [loadingProbe, setLoadingProbe] = useState(false);
  const [startingOAuth, setStartingOAuth] = useState(false);
  const [startingComposio, setStartingComposio] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScopes, setShowScopes] = useState(false);

  const scopeId = useScope();
  const doProbe = useAtomSet(probeGoogleDiscovery, { mode: "promise" });
  const doAdd = useAtomSet(addGoogleDiscoverySource, { mode: "promise" });
  const doStartComposioConnect = useAtomSet(startGoogleDiscoveryComposioConnect, {
    mode: "promise",
  });
  const doStartOAuth = useAtomSet(startGoogleDiscoveryOAuth, { mode: "promise" });
  const secrets = useAtomValue(secretsAtom(scopeId));
  const { beginAdd } = usePendingSources();

  const canUseOAuth = useMemo(() => (probe?.scopes.length ?? 0) > 0, [probe]);
  const namespaceSlug =
    slugifyNamespace(identity.namespace) ||
    slugifyNamespace(probe?.name ?? activeTemplate?.name ?? "") ||
    "google_discovery";
  const composioCallbackBaseUrl = googleDiscoveryComposioCallbackUrl(
    GOOGLE_DISCOVERY_COMPOSIO_CALLBACK_PATH,
  );
  const derivedComposioAuth =
    activeTemplate?.composio != null
      ? ({
          kind: "composio",
          app: activeTemplate.composio.app,
          authConfigId: activeTemplate.composio.authConfigId ?? null,
          connectionId:
            composioAuth?.connectionId ?? composioConnectionIdForNamespace(namespaceSlug),
        } satisfies ComposioAuth)
      : null;
  const secretList: readonly SecretPickerSecret[] = Result.match(secrets, {
    onInitial: () => [] as SecretPickerSecret[],
    onFailure: () => [] as SecretPickerSecret[],
    onSuccess: ({ value }) =>
      value.map((secret) => ({
        id: secret.id,
        name: secret.name,
        provider: secret.provider ? String(secret.provider) : undefined,
      })),
  });

  const applyTemplate = useCallback(
    (template: GoogleDiscoveryPreset) => {
      setSelectedTemplateId(template.id);
      setDiscoveryUrl(template.url);
      identity.reset();
      setClientSecretSecretId(null);
      setProbe(null);
      setOauthAuth(null);
      setComposioAuth(null);
      setError(null);
      setShowScopes(false);
      setAuthKind(template.composio ? "composio" : "oauth2");
    },
    [identity],
  );

  const handleProbe = useCallback(async () => {
    setLoadingProbe(true);
    setError(null);
    setOauthAuth(null);
    setComposioAuth(null);
    setShowScopes(false);
    try {
      const result = await doProbe({
        path: { scopeId },
        payload: { discoveryUrl: discoveryUrl.trim() },
      });
      setProbe({
        ...result,
        scopes: [...result.scopes],
        operations: [...result.operations],
      });
      if (result.scopes.length === 0 && authKind === "oauth2") {
        setAuthKind(activeTemplate?.composio ? "composio" : "none");
      }
    } catch (e) {
      setProbe(null);
      setError(e instanceof Error ? e.message : "Failed to inspect discovery document");
    } finally {
      setLoadingProbe(false);
    }
  }, [activeTemplate?.composio, authKind, discoveryUrl, doProbe, scopeId]);

  // Keep the latest handleProbe in a ref so the debounced effect can call it
  // without depending on its identity (which changes every render).
  const handleProbeRef = useRef(handleProbe);
  handleProbeRef.current = handleProbe;

  // Auto-probe whenever the discovery URL changes (debounced). Clearing the
  // previous probe in the onChange handler resets the preview so a new run
  // will be triggered.
  useEffect(() => {
    const trimmed = discoveryUrl.trim();
    if (!trimmed) return;
    if (probe) return;
    const handle = setTimeout(() => {
      handleProbeRef.current();
    }, 400);
    return () => clearTimeout(handle);
  }, [discoveryUrl, probe]);

  const oauthCleanup = useRef<(() => void) | null>(null);
  const composioCleanup = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      oauthCleanup.current?.();
      composioCleanup.current?.();
    },
    [],
  );

  useEffect(() => {
    if (authKind === "composio" && !activeTemplate?.composio) {
      setAuthKind(canUseOAuth ? "oauth2" : "none");
    }
  }, [activeTemplate?.composio, authKind, canUseOAuth]);

  const handleStartOAuth = useCallback(async () => {
    if (!probe || !clientIdSecretId) return;
    oauthCleanup.current?.();
    oauthCleanup.current = null;
    setStartingOAuth(true);
    setError(null);
    try {
      const response = await doStartOAuth({
        path: { scopeId },
        payload: {
          name: identity.name.trim() || probe.name,
          discoveryUrl: discoveryUrl.trim(),
          clientIdSecretId,
          clientSecretSecretId,
          redirectUrl: `${window.location.origin}/api/google-discovery/oauth/callback`,
          scopes: probe.scopes,
        },
      });

      oauthCleanup.current = openOAuthPopup<OAuthAuth>({
        url: response.authorizationUrl,
        popupName: OAUTH_POPUP_NAME,
        channelName: OAUTH_RESULT_CHANNEL,
        onResult: (result: GoogleOAuthPopupResult) => {
          oauthCleanup.current = null;
          setStartingOAuth(false);
          if (result.ok) {
            setOauthAuth({
              kind: "oauth2",
              connectionId: result.connectionId,
              clientIdSecretId: result.clientIdSecretId,
              clientSecretSecretId: result.clientSecretSecretId,
              scopes: [...result.scopes],
            });
            setError(null);
          } else {
            setError(result.error);
          }
        },
        onOpenFailed: () => {
          oauthCleanup.current = null;
          setStartingOAuth(false);
          setError("OAuth popup was blocked");
        },
      });
    } catch (e) {
      setStartingOAuth(false);
      setError(e instanceof Error ? e.message : "Failed to start OAuth");
    }
  }, [probe, doStartOAuth, scopeId, identity, discoveryUrl, clientIdSecretId, clientSecretSecretId]);

  const handleCancelOAuth = useCallback(() => {
    oauthCleanup.current?.();
    oauthCleanup.current = null;
    setStartingOAuth(false);
  }, []);

  const handleStartComposio = useCallback(async () => {
    if (!derivedComposioAuth) return;
    composioCleanup.current?.();
    composioCleanup.current = null;
    setStartingComposio(true);
    setError(null);

    try {
      const response = await doStartComposioConnect({
        path: { scopeId },
        payload: {
          callbackBaseUrl: composioCallbackBaseUrl,
          app: derivedComposioAuth.app,
          authConfigId: derivedComposioAuth.authConfigId,
          connectionId: derivedComposioAuth.connectionId,
          displayName:
            identity.name.trim() || probe?.name || activeTemplate?.name || "Google API",
        },
      });

      const popup = window.open(
        response.redirectUrl,
        GOOGLE_DISCOVERY_COMPOSIO_POPUP_NAME,
        "width=600,height=700,scrollbars=yes",
      );
      if (!popup) {
        setStartingComposio(false);
        setError("Sign-in popup was blocked by the browser");
        return;
      }

      const channel = new BroadcastChannel(GOOGLE_DISCOVERY_COMPOSIO_CHANNEL);
      const onMessage = (event: MessageEvent) => {
        cleanup();
        const data = event.data as { ok: boolean; connectionId?: string; error?: string };
        setStartingComposio(false);
        if (data.ok) {
          setComposioAuth({
            ...derivedComposioAuth,
            connectionId: data.connectionId ?? derivedComposioAuth.connectionId,
          });
          setError(null);
        } else {
          setError(data.error ?? "Managed OAuth failed");
        }
      };
      channel.addEventListener("message", onMessage);

      const popupTimer = setInterval(() => {
        if (popup.closed) {
          cleanup();
          setStartingComposio(false);
          setError("Connect cancelled — popup was closed before completing the flow.");
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
      setError(e instanceof Error ? e.message : "Failed to start managed auth");
    }
  }, [
    activeTemplate?.name,
    composioCallbackBaseUrl,
    derivedComposioAuth,
    doStartComposioConnect,
    identity.name,
    probe?.name,
    scopeId,
  ]);

  const handleAdd = useCallback(async () => {
    if (!probe) return;
    setAdding(true);
    setError(null);
    const displayName = identity.name.trim() || probe.name;
    const namespace = slugifyNamespace(identity.namespace) || probe.name;
    const placeholder = beginAdd({
      id: namespace,
      name: displayName,
      kind: "google-discovery",
    });
    try {
      await doAdd({
        path: { scopeId },
        payload: {
          name: displayName,
          discoveryUrl: discoveryUrl.trim(),
          namespace: slugifyNamespace(identity.namespace) || undefined,
          auth:
            authKind === "oauth2" && oauthAuth
              ? {
                  kind: "oauth2" as const,
                  connectionId: oauthAuth.connectionId,
                  clientIdSecretId: oauthAuth.clientIdSecretId,
                  clientSecretSecretId: oauthAuth.clientSecretSecretId,
                  scopes: oauthAuth.scopes,
                }
              : authKind === "composio" && composioAuth
                ? {
                    kind: "composio" as const,
                    app: composioAuth.app,
                    authConfigId: composioAuth.authConfigId,
                    connectionId: composioAuth.connectionId,
                  }
              : { kind: "none" as const },
        },
        reactivityKeys: [...sourceWriteKeys],
      });
      props.onComplete(namespace);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add source");
      setAdding(false);
    } finally {
      placeholder.done();
    }
  }, [
    probe,
    doAdd,
    identity,
    discoveryUrl,
    authKind,
    oauthAuth,
    composioAuth,
    props,
    scopeId,
    beginAdd,
  ]);

  const addDisabled =
    !probe ||
    adding ||
    (authKind === "oauth2" && (!canUseOAuth || oauthAuth === null)) ||
    (authKind === "composio" && composioAuth === null);

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add Google Discovery Source</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Connect a Google API from its Discovery document and register its methods as tools.
        </p>
      </div>

      {lockedPreset ? (
        <section className="space-y-2.5">
          <FieldLabel>Preset</FieldLabel>
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-4">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background/80 shadow-xs">
              <GoogleServiceIcon icon={lockedPreset.icon} className="size-7" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">{lockedPreset.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{lockedPreset.summary}</p>
            </div>
          </div>
        </section>
      ) : (
        <FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">Presets</FieldLegend>
            <FieldDescription>Select a Google API to prefill the source.</FieldDescription>
            <RadioGroup
              value={selectedTemplateId}
              onValueChange={(value) => {
                const template = googleDiscoveryPresets.find((preset) => preset.id === value);
                if (template) applyTemplate(template);
              }}
              className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
            >
              {googleDiscoveryPresets.map((template) => {
                const inputId = `google-discovery-preset-${template.id}`;
                return (
                  <FieldLabel key={template.id} htmlFor={inputId}>
                    <Field orientation="horizontal">
                      <GoogleServiceIcon icon={template.icon} className="size-8" />
                      <FieldContent>
                        <FieldTitle>{template.name}</FieldTitle>
                        <FieldDescription className="line-clamp-2">
                          {template.summary}
                        </FieldDescription>
                      </FieldContent>
                      <RadioGroupItem id={inputId} value={template.id} />
                    </Field>
                  </FieldLabel>
                );
              })}
            </RadioGroup>
          </FieldSet>
        </FieldGroup>
      )}

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField label="Discovery URL">
            <div className="relative">
              <Input
                value={discoveryUrl}
                onChange={(e) => {
                  setSelectedTemplateId("");
                  setDiscoveryUrl((e.target as HTMLInputElement).value);
                  setProbe(null);
                  setOauthAuth(null);
                  setComposioAuth(null);
                  setError(null);
                }}
                placeholder="https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest"
                className="w-full pr-9 font-mono text-sm"
              />
              {loadingProbe && (
                <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                  <IOSSpinner className="size-4" />
                </div>
              )}
            </div>
          </CardStackEntryField>

        </CardStackContent>
      </CardStack>

      <SourceIdentityFields
        identity={identity}
        namePlaceholder="Google Sheets"
        namespacePlaceholder="google_sheets"
      />

      {probe && (
        <section className="space-y-3 rounded-xl border border-border bg-card px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background/80 shadow-xs">
                <GoogleServiceIcon icon={activeTemplate?.icon} className="size-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{probe.title ?? probe.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {probe.service} · {probe.version}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Badge variant="secondary">{probe.toolCount} tools</Badge>
              <Badge variant="outline">{probe.scopes.length} scopes</Badge>
            </div>
          </div>
        </section>
      )}

      <section className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>Authentication</FieldLabel>
          <FilterTabs<GoogleAuthKind>
            tabs={
              activeTemplate?.composio
                ? [
                    { value: "none", label: "None" },
                    { value: "oauth2", label: "Google OAuth" },
                    { value: "composio", label: "Managed OAuth" },
                  ]
                : [
                    { value: "none", label: "None" },
                    { value: "oauth2", label: "Google OAuth" },
                  ]
            }
            value={authKind}
            onChange={setAuthKind}
          />
        </div>

        {authKind === "oauth2" && (
          <div className="space-y-3 rounded-xl border border-border bg-card px-4 py-4">
            <SecretBackedField
              label="OAuth Client ID"
              headerName="Client ID"
              suggestedSecretId="google-oauth-client-id"
              secretId={clientIdSecretId}
              onSelect={setClientIdSecretId}
              secretList={secretList}
              placeholder="Pick or create a secret"
              clearable={false}
            />
            <SecretBackedField
              label="OAuth Client Secret"
              headerName="Client Secret"
              suggestedSecretId="google-oauth-client-secret"
              secretId={clientSecretSecretId}
              onSelect={setClientSecretSecretId}
              secretList={secretList}
              placeholder="Optional for confidential clients"
            />
            <Collapsible open={showScopes} onOpenChange={setShowScopes} className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-xs text-muted-foreground">
                    {canUseOAuth
                      ? `${probe?.scopes.length ?? 0} scopes will be requested from Google.`
                      : "This API does not advertise OAuth scopes."}
                  </p>
                  {canUseOAuth && (probe?.scopes.length ?? 0) > 0 && (
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="link"
                        type="button"
                        className="h-auto p-0 text-xs font-medium text-primary hover:underline"
                      >
                        {showScopes ? "Hide scopes" : "View scopes"}
                      </Button>
                    </CollapsibleTrigger>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={handleStartOAuth}
                    disabled={!probe || !clientIdSecretId || !canUseOAuth || startingOAuth}
                  >
                    {startingOAuth ? (
                      <>
                        <Spinner className="size-3.5" /> Waiting…
                      </>
                    ) : oauthAuth ? (
                      "Re-authenticate"
                    ) : (
                      "Connect Google"
                    )}
                  </Button>
                  {startingOAuth && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCancelOAuth}
                      className="h-8 px-2 text-xs"
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
              <CollapsibleContent>
                <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
                  <ul className="space-y-1">
                    {(probe?.scopes ?? []).map((scope) => (
                      <li
                        key={scope}
                        className="break-all font-mono text-[11px] text-muted-foreground"
                      >
                        {scope}
                      </li>
                    ))}
                  </ul>
                </div>
              </CollapsibleContent>
            </Collapsible>
            {oauthAuth && (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                Connected. Manage this connection from the Connections page.
              </div>
            )}
          </div>
        )}

        {authKind === "composio" && activeTemplate?.composio && (
          <div className="space-y-3 rounded-xl border border-border bg-card px-4 py-4">
            <p className="text-xs text-muted-foreground">
              Connect your Google account to authorize requests for this source.
            </p>
            {composioAuth ? (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                Connected. Manage this connection from the Connections page.
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
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="outline" onClick={() => void handleStartComposio()}>
                Connect
              </Button>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <FloatActions>
        <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
          Cancel
        </Button>
        <Button onClick={handleAdd} disabled={addDisabled}>
          {adding && <Spinner className="size-3.5" />}
          {adding ? "Adding…" : "Add Source"}
        </Button>
      </FloatActions>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet, useAtomValue, Result } from "@effect-atom/atom-react";

import { openOAuthPopup, type OAuthPopupResult } from "@executor/plugin-oauth2/react";
import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { connectionsAtom } from "@executor/react/api/atoms";
import { Button } from "@executor/react/components/button";

import {
  googleDiscoverySourceAtom,
  startGoogleDiscoveryComposioConnect,
  startGoogleDiscoveryOAuth,
  updateGoogleDiscoverySource,
} from "./atoms";
import {
  GOOGLE_DISCOVERY_COMPOSIO_CALLBACK_PATH,
  GOOGLE_DISCOVERY_COMPOSIO_CHANNEL,
  GOOGLE_DISCOVERY_COMPOSIO_POPUP_NAME,
} from "./AddGoogleDiscoverySource";
import { googleDiscoveryComposioCallbackUrl } from "./composio-callback";

// ---------------------------------------------------------------------------
// GoogleDiscoverySignInButton — top-bar action on the source detail page.
//
// Reads the source's stored `GoogleDiscoveryAuth`, re-runs the authorization
// code flow via popup using the same `clientIdSecretId` / `clientSecretSecretId`
// / `scopes` the source was originally configured with, and on success
// rewrites the source's auth pointer to the freshly minted connection id.
// Works whether or not the previous Connection still exists — source-owned
// OAuth config is the source of truth.
// ---------------------------------------------------------------------------

const CALLBACK_PATH = "/api/google-discovery/oauth/callback";
const POPUP_NAME = "google-discovery-oauth";
const CHANNEL_NAME = "executor:google-discovery-oauth-result";

type GoogleOAuthPopupPayload = {
  kind: "oauth2";
  connectionId: string;
  clientIdSecretId: string;
  clientSecretSecretId: string | null;
  scopes: readonly string[];
};

export default function GoogleDiscoverySignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(googleDiscoverySourceAtom(scopeId, props.sourceId));
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const doStartComposioConnect = useAtomSet(startGoogleDiscoveryComposioConnect, {
    mode: "promise",
  });
  const doStartOAuth = useAtomSet(startGoogleDiscoveryOAuth, { mode: "promise" });
  const doUpdate = useAtomSet(updateGoogleDiscoverySource, { mode: "promise" });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const source =
    Result.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const auth = source?.config.auth;
  const oauth2 = auth && auth.kind === "oauth2" ? auth : null;
  const composio = auth && auth.kind === "composio" ? auth : null;
  const connections = Result.isSuccess(connectionsResult)
    ? connectionsResult.value
    : null;
  const isOAuthConnected =
    oauth2 !== null &&
    connections !== null &&
    connections.some((c) => c.id === oauth2.connectionId);
  const isComposioConnected =
    composio !== null &&
    connections !== null &&
    connections.some((c) => c.id === composio.connectionId);

  const redirectUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${CALLBACK_PATH}`
      : CALLBACK_PATH;
  const composioCallbackBaseUrl = googleDiscoveryComposioCallbackUrl(
    GOOGLE_DISCOVERY_COMPOSIO_CALLBACK_PATH,
  );

  const handleComposioConnect = useCallback(async () => {
    if (!composio) return;
    cleanupRef.current?.();
    cleanupRef.current = null;
    setBusy(true);
    setError(null);

    try {
      const response = await doStartComposioConnect({
        path: { scopeId },
        payload: {
          sourceId: props.sourceId,
          callbackBaseUrl: composioCallbackBaseUrl,
        },
      });

      const popup = window.open(
        response.redirectUrl,
        GOOGLE_DISCOVERY_COMPOSIO_POPUP_NAME,
        "width=600,height=700,scrollbars=yes",
      );
      if (!popup) {
        setBusy(false);
        setError("Sign-in popup was blocked by the browser");
        return;
      }

      const channel = new BroadcastChannel(GOOGLE_DISCOVERY_COMPOSIO_CHANNEL);
      const onMessage = (event: MessageEvent) => {
        cleanup();
        const data = event.data as { ok: boolean; connectionId?: string; error?: string };
        if (!data.ok) {
          setBusy(false);
          setError(data.error ?? "Managed OAuth failed");
          return;
        }

        void doUpdate({
          path: { scopeId, namespace: props.sourceId },
          payload: { auth: composio },
          reactivityKeys: sourceWriteKeys,
        })
          .then(() => {
            setBusy(false);
          })
          .catch((e) => {
            setBusy(false);
            setError(e instanceof Error ? e.message : "Failed to activate managed auth");
          });
      };
      channel.addEventListener("message", onMessage);

      const popupTimer = setInterval(() => {
        if (popup.closed) {
          cleanup();
          setBusy(false);
          setError("Connect cancelled — popup was closed before completing the flow.");
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
      setBusy(false);
      setError(e instanceof Error ? e.message : "Failed to start managed auth");
    }
  }, [
    composio,
    composioCallbackBaseUrl,
    doStartComposioConnect,
    doUpdate,
    props.sourceId,
    scopeId,
  ]);

  const handleSignIn = useCallback(async () => {
    if (!oauth2 || !source) return;
    cleanupRef.current?.();
    cleanupRef.current = null;
    setBusy(true);
    setError(null);
    try {
      const response = await doStartOAuth({
        path: { scopeId },
        payload: {
          name: source.name,
          discoveryUrl: source.config.discoveryUrl,
          clientIdSecretId: oauth2.clientIdSecretId,
          clientSecretSecretId: oauth2.clientSecretSecretId,
          redirectUrl,
          scopes: [...oauth2.scopes],
        },
      });

      cleanupRef.current = openOAuthPopup<GoogleOAuthPopupPayload>({
        url: response.authorizationUrl,
        popupName: POPUP_NAME,
        channelName: CHANNEL_NAME,
        onResult: async (result: OAuthPopupResult<GoogleOAuthPopupPayload>) => {
          cleanupRef.current = null;
          if (!result.ok) {
            setBusy(false);
            setError(result.error);
            return;
          }
          try {
            await doUpdate({
              path: { scopeId, namespace: props.sourceId },
              payload: {
                auth: {
                  kind: "oauth2",
                  connectionId: result.connectionId,
                  clientIdSecretId: result.clientIdSecretId,
                  clientSecretSecretId: result.clientSecretSecretId,
                  scopes: result.scopes,
                },
              },
              reactivityKeys: sourceWriteKeys,
            });
            setBusy(false);
          } catch (e) {
            setBusy(false);
            setError(
              e instanceof Error ? e.message : "Failed to persist new connection",
            );
          }
        },
        onClosed: () => {
          cleanupRef.current = null;
          setBusy(false);
          setError("Sign-in cancelled — popup was closed before completing the flow.");
        },
        onOpenFailed: () => {
          cleanupRef.current = null;
          setBusy(false);
          setError("Sign-in popup was blocked by the browser");
        },
      });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Failed to start sign-in");
    }
  }, [oauth2, source, scopeId, props.sourceId, redirectUrl, doStartOAuth, doUpdate]);

  if (!oauth2 && !composio) return null;

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          void (oauth2 ? handleSignIn() : composio ? handleComposioConnect() : undefined)
        }
        disabled={busy}
      >
        {busy
          ? oauth2
            ? isOAuthConnected
              ? "Reconnecting…"
              : "Signing in…"
            : "Connecting…"
          : oauth2
            ? isOAuthConnected
              ? "Reconnect"
              : "Sign in"
            : isComposioConnected
              ? "Reconnect"
              : "Connect"}
      </Button>
    </div>
  );
}

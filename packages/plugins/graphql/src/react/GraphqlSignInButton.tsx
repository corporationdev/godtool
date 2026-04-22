import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet, useAtomValue, Result } from "@effect-atom/atom-react";

import { useScope } from "@executor/react/api/scope-context";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { connectionsAtom } from "@executor/react/api/atoms";
import { Button } from "@executor/react/components/button";

import {
  graphqlSourceAtom,
  startGraphqlComposioConnect,
  updateGraphqlSource,
} from "./atoms";
import {
  GRAPHQL_COMPOSIO_CALLBACK_PATH,
  GRAPHQL_COMPOSIO_CHANNEL,
  GRAPHQL_COMPOSIO_POPUP_NAME,
} from "./AddGraphqlSource";
import { graphqlComposioCallbackUrl } from "./composio-callback";

export default function GraphqlSignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(graphqlSourceAtom(scopeId, props.sourceId));
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const doStartComposioConnect = useAtomSet(startGraphqlComposioConnect, {
    mode: "promise",
  });
  const doUpdate = useAtomSet(updateGraphqlSource, { mode: "promise" });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const source =
    Result.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const composio = source?.composio ?? null;
  const connections = Result.isSuccess(connectionsResult) ? connectionsResult.value : null;
  const isConnected =
    composio !== null &&
    connections !== null &&
    connections.some((connection) => connection.id === composio.connectionId);

  const callbackBaseUrl = graphqlComposioCallbackUrl(
    GRAPHQL_COMPOSIO_CALLBACK_PATH,
  );

  const handleConnect = useCallback(async () => {
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
          callbackBaseUrl,
        },
      });

      const popup = window.open(
        response.redirectUrl,
        GRAPHQL_COMPOSIO_POPUP_NAME,
        "width=600,height=700,scrollbars=yes",
      );
      if (!popup) {
        setBusy(false);
        setError("Sign-in popup was blocked by the browser");
        return;
      }

      const channel = new BroadcastChannel(GRAPHQL_COMPOSIO_CHANNEL);
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
  }, [callbackBaseUrl, composio, doStartComposioConnect, doUpdate, props.sourceId, scopeId]);

  if (!composio) return null;

  return (
    <div className="flex items-center gap-2">
      {error && <span className="max-w-64 truncate text-xs text-destructive">{error}</span>}
      <Button variant="outline" onClick={() => void handleConnect()} disabled={busy}>
        {busy ? "Connecting…" : isConnected ? "Reconnect" : "Sign in"}
      </Button>
    </div>
  );
}

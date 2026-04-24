import { useCallback, useEffect, useRef, useState } from "react";
import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react";

import { connectionsAtom } from "@executor/react/api/atoms";
import { sourceWriteKeys } from "@executor/react/api/reactivity-keys";
import { useScope } from "@executor/react/api/scope-context";
import { Button } from "@executor/react/components/button";

import {
  rawSourceAtom,
  startRawComposioConnect,
  updateRawSource,
} from "./atoms";
import {
  RAW_COMPOSIO_CALLBACK_PATH,
  RAW_COMPOSIO_CHANNEL,
  RAW_COMPOSIO_POPUP_NAME,
} from "./AddRawSource";
import { rawComposioCallbackUrl } from "./composio-callback";

export default function RawSignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(rawSourceAtom(scopeId, props.sourceId));
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const doStartComposioConnect = useAtomSet(startRawComposioConnect, {
    mode: "promise",
  });
  const doUpdate = useAtomSet(updateRawSource, { mode: "promise" });

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
          callbackBaseUrl: rawComposioCallbackUrl(RAW_COMPOSIO_CALLBACK_PATH),
        },
      });

      const popup = window.open(
        response.redirectUrl,
        RAW_COMPOSIO_POPUP_NAME,
        "width=600,height=700,scrollbars=yes",
      );
      if (!popup) {
        setBusy(false);
        setError("Sign-in popup was blocked by the browser");
        return;
      }

      const channel = new BroadcastChannel(RAW_COMPOSIO_CHANNEL);
      const onMessage = (event: MessageEvent) => {
        cleanup();
        const data = event.data as { ok: boolean; error?: string };
        if (!data.ok) {
          setBusy(false);
          setError(data.error ?? "Managed auth failed");
          return;
        }

        void doUpdate({
          path: { scopeId, namespace: props.sourceId },
          payload: { auth: composio },
          reactivityKeys: sourceWriteKeys,
        })
          .then(() => setBusy(false))
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
  }, [composio, doStartComposioConnect, doUpdate, props.sourceId, scopeId]);

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

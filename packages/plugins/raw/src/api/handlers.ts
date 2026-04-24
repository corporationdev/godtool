import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor/api";

import type {
  HeaderValue,
  RawPluginExtension,
  RawUpdateSourceInput,
} from "../sdk/plugin";
import { RawGroup } from "./group";

export class RawExtensionService extends Context.Tag("RawExtensionService")<
  RawExtensionService,
  RawPluginExtension
>() {}

const ExecutorApiWithRaw = addGroup(RawGroup);
const RAW_COMPOSIO_CHANNEL = "executor:raw-composio-result";

const composioPopupHtml = (payload: unknown, channelName: string): string => {
  const json = JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connecting…</title></head><body><script>
(function(){
  var ch=new BroadcastChannel(${JSON.stringify(channelName)});
  ch.postMessage(${json});
  ch.close();
  if(window.opener){window.opener.postMessage({channel:${JSON.stringify(channelName)},payload:${json}},"*");}
  window.close();
})();
</script></body></html>`;
};

export const RawHandlers = HttpApiBuilder.group(ExecutorApiWithRaw, "raw", (handlers) =>
  handlers
    .handle("addSource", ({ path, payload }) =>
      capture(Effect.gen(function* () {
        const ext = yield* RawExtensionService;
        return yield* ext.addSource({
          baseUrl: payload.baseUrl,
          scope: path.scopeId,
          name: payload.name,
          namespace: payload.namespace,
          headers: payload.headers as Record<string, HeaderValue> | undefined,
          composio: payload.composio,
          auth: payload.auth,
        });
      })),
    )
    .handle("getSource", ({ path }) =>
      capture(Effect.gen(function* () {
        const ext = yield* RawExtensionService;
        return yield* ext.getSource(path.namespace, path.scopeId);
      })),
    )
    .handle("updateSource", ({ path, payload }) =>
      capture(Effect.gen(function* () {
        const ext = yield* RawExtensionService;
        yield* ext.updateSource(path.namespace, path.scopeId, {
          name: payload.name,
          baseUrl: payload.baseUrl,
          headers: payload.headers as Record<string, HeaderValue> | undefined,
          composio: payload.composio === undefined ? undefined : payload.composio,
          auth: payload.auth === undefined ? undefined : payload.auth,
        } as RawUpdateSourceInput);
        return { updated: true };
      })),
    )
    .handle("startComposioConnect", ({ path, payload }) =>
      capture(Effect.gen(function* () {
        const ext = yield* RawExtensionService;
        if ("sourceId" in payload) {
          return yield* ext.startComposioConnect({
            scopeId: path.scopeId,
            sourceId: payload.sourceId,
            callbackUrl: payload.callbackBaseUrl,
          });
        }
        return yield* ext.startComposioConnect({
          scopeId: path.scopeId,
          callbackUrl: payload.callbackBaseUrl,
          app: payload.app,
          authConfigId: payload.authConfigId ?? null,
          connectionId: payload.connectionId,
          displayName: payload.displayName,
        });
      })),
    )
    .handle("composioCallback", ({ urlParams }) =>
      capture(Effect.gen(function* () {
        const ext = yield* RawExtensionService;

        if (urlParams.error || !urlParams.connected_account_id) {
          const msg = urlParams.error ?? "Managed auth was cancelled or failed";
          return yield* HttpServerResponse.html(
            composioPopupHtml({ ok: false, error: msg }, RAW_COMPOSIO_CHANNEL),
          );
        }

        const result = yield* ext
          .completeComposioConnect({
            state: urlParams.state,
            connectedAccountId: urlParams.connected_account_id,
          })
          .pipe(
            Effect.match({
              onSuccess: (r) => ({ ok: true as const, connectionId: r.connectionId }),
              onFailure: (err) => ({
                ok: false as const,
                error: "message" in err ? String(err.message) : "Managed auth failed",
              }),
            }),
          );

        return yield* HttpServerResponse.html(
          composioPopupHtml(result, RAW_COMPOSIO_CHANNEL),
        );
      })),
    ),
);

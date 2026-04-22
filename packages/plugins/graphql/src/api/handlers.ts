import { HttpApiBuilder } from "@effect/platform";
import { HttpServerResponse } from "@effect/platform";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor/api";
import type {
  GraphqlPluginExtension,
  HeaderValue,
  GraphqlUpdateSourceInput,
} from "../sdk/plugin";
import { GraphqlGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag
//
// Holds the `Captured` shape — every method's `StorageError` channel has
// been swapped for `InternalError({ traceId })`. The host app provides an
// already-wrapped extension via
// `Layer.succeed(GraphqlExtensionService, withCapture(executor.graphql))`.
// Handlers see `InternalError` in the error union, which matches
// `.addError(InternalError)` on the group — no per-handler translation.
// ---------------------------------------------------------------------------

export class GraphqlExtensionService extends Context.Tag("GraphqlExtensionService")<
  GraphqlExtensionService,
  GraphqlPluginExtension
>() {}

// ---------------------------------------------------------------------------
// Composed API — core + graphql group
// ---------------------------------------------------------------------------

const ExecutorApiWithGraphql = addGroup(GraphqlGroup);
const GRAPHQL_COMPOSIO_CHANNEL = "executor:graphql-composio-result";

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

// ---------------------------------------------------------------------------
// Handlers
//
// Each handler is exactly: yield the extension service, call the method,
// return. Plugin SDK errors flow through the typed channel and are
// schema-encoded to 4xx by HttpApi (see group.ts `.addError(...)` calls).
// Defects bubble up and are captured + downgraded to `InternalError(traceId)`
// by the API-level observability middleware.
// ---------------------------------------------------------------------------

export const GraphqlHandlers = HttpApiBuilder.group(ExecutorApiWithGraphql, "graphql", (handlers) =>
  handlers
    .handle("addSource", ({ path, payload }) =>
      capture(Effect.gen(function* () {
        const ext = yield* GraphqlExtensionService;
        const result = yield* ext.addSource({
          endpoint: payload.endpoint,
          scope: path.scopeId,
          name: payload.name,
          introspectionJson: payload.introspectionJson,
          namespace: payload.namespace,
          headers: payload.headers as Record<string, HeaderValue> | undefined,
          composio: payload.composio,
          auth: payload.auth,
        });
        return {
          toolCount: result.toolCount,
          namespace: result.namespace,
        };
      })),
    )
    .handle("getSource", ({ path }) =>
      capture(Effect.gen(function* () {
        const ext = yield* GraphqlExtensionService;
        return yield* ext.getSource(path.namespace, path.scopeId);
      })),
    )
    .handle("updateSource", ({ path, payload }) =>
      capture(Effect.gen(function* () {
        const ext = yield* GraphqlExtensionService;
        yield* ext.updateSource(path.namespace, path.scopeId, {
          name: payload.name,
          endpoint: payload.endpoint,
          headers: payload.headers as Record<string, HeaderValue> | undefined,
          composio: payload.composio === undefined ? undefined : payload.composio,
          auth: payload.auth === undefined ? undefined : payload.auth,
        } as GraphqlUpdateSourceInput);
        return { updated: true };
      })),
    )
    .handle("startComposioConnect", ({ path, payload }) =>
      capture(Effect.gen(function* () {
        const ext = yield* GraphqlExtensionService;
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
        const ext = yield* GraphqlExtensionService;

        if (urlParams.error || !urlParams.connected_account_id) {
          const msg = urlParams.error ?? "Composio auth was cancelled or failed";
          return yield* HttpServerResponse.html(
            composioPopupHtml({ ok: false, error: msg }, GRAPHQL_COMPOSIO_CHANNEL),
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
                error: "message" in err ? String(err.message) : "Composio auth failed",
              }),
            }),
          );

        return yield* HttpServerResponse.html(
          composioPopupHtml(result, GRAPHQL_COMPOSIO_CHANNEL),
        );
      })),
    ),
);

import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Context, Effect, Layer } from "effect";

import { addGroup, capture } from "@executor/api";

import type {
  HeaderValue,
  RawPluginExtension,
  RawUpdateSourceInput,
} from "../sdk/plugin";
import { RawGroup } from "./group";
import { RawComposioError } from "../sdk/errors";

export class RawExtensionService extends Context.Tag("RawExtensionService")<
  RawExtensionService,
  RawPluginExtension
>() {}

export class RawBillingService extends Context.Tag("RawBillingService")<
  RawBillingService,
  {
    readonly canUseManagedAuth: (scopeId: string) => Effect.Effect<boolean, never, never>;
  }
>() {
  static AllowAll = Layer.succeed(this, {
    canUseManagedAuth: () => Effect.succeed(true),
  });
}

const ExecutorApiWithRaw = addGroup(RawGroup);
const RAW_COMPOSIO_CHANNEL = "executor:raw-composio-result";

const popupHtml = (payload: unknown, channelName: string): string => {
  const base = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  const message = {
    type: "executor:oauth-result",
    sessionId: base.ok === false ? null : "raw-composio",
    ...base,
  };
  const json = JSON.stringify(message)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connecting...</title></head><body><script>
(function(){
  var payload=${json};
  try {
    var ch = new BroadcastChannel(${JSON.stringify(channelName)});
    ch.postMessage(payload);
    ch.close();
  } catch {}
  try {
    if (window.opener) window.opener.postMessage({ channel: ${JSON.stringify(channelName)}, payload: payload }, "*");
  } catch {}
  window.close();
})();
</script></body></html>`;
};

const payloadUsesManagedAuth = (payload: { readonly composio?: unknown; readonly auth?: unknown }) =>
  payload.composio != null ||
  (typeof payload.auth === "object" &&
    payload.auth !== null &&
    "kind" in payload.auth &&
    payload.auth.kind === "composio");

const requireManagedAuth = (scopeId: string) =>
  Effect.gen(function* () {
    const billing = yield* RawBillingService;
    const allowed = yield* billing.canUseManagedAuth(scopeId);
    if (!allowed) {
      return yield* new RawComposioError({
        message: "Managed OAuth requires the Pro plan",
      });
    }
  });

export const RawHandlers = HttpApiBuilder.group(
  ExecutorApiWithRaw,
  "raw",
  (handlers) =>
    handlers
      .handle("addSource", ({ path, payload }) =>
        capture(
          Effect.gen(function* () {
            if (payloadUsesManagedAuth(payload)) {
              yield* requireManagedAuth(path.scopeId);
            }
            const ext = yield* RawExtensionService;
            return yield* ext.addSource({
              baseUrl: payload.baseUrl,
              scope: path.scopeId,
              name: payload.name,
              namespace: payload.namespace,
              headers: payload.headers as
                | Record<string, HeaderValue>
                | undefined,
              composio: payload.composio,
              auth: payload.auth,
            });
          }),
        ),
      )
      .handle("getSource", ({ path }) =>
        capture(
          Effect.gen(function* () {
            const ext = yield* RawExtensionService;
            return yield* ext.getSource(path.namespace, path.scopeId);
          }),
        ),
      )
      .handle("updateSource", ({ path, payload }) =>
        capture(
          Effect.gen(function* () {
            if (payloadUsesManagedAuth(payload)) {
              yield* requireManagedAuth(path.scopeId);
            }
            const ext = yield* RawExtensionService;
            yield* ext.updateSource(path.namespace, path.scopeId, {
              name: payload.name,
              baseUrl: payload.baseUrl,
              headers: payload.headers as
                | Record<string, HeaderValue>
                | undefined,
              composio: payload.composio === undefined ? undefined : payload.composio,
              auth: payload.auth === undefined ? undefined : payload.auth,
            } as RawUpdateSourceInput);
            return { updated: true };
          }),
        ),
      )
      .handle("startComposioConnect", ({ path, payload }) =>
        capture(
          Effect.gen(function* () {
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
          }),
        ),
      )
      .handle("composioCallback", ({ urlParams }) =>
        capture(
          Effect.gen(function* () {
            const ext = yield* RawExtensionService;
            if (urlParams.error || !urlParams.connected_account_id) {
              return yield* HttpServerResponse.html(
                popupHtml(
                  { ok: false, error: urlParams.error ?? "Managed auth was cancelled or failed" },
                  RAW_COMPOSIO_CHANNEL,
                ),
              );
            }

            const result = yield* ext
              .completeComposioConnect({
                state: urlParams.state,
                connectedAccountId: urlParams.connected_account_id,
              })
              .pipe(
                Effect.match({
                  onSuccess: (value) => ({
                    ok: true,
                    connectionId: value.connectionId,
                    authConfigId: value.authConfigId,
                  }),
                  onFailure: (err) => ({
                    ok: false,
                    error: "message" in err ? String(err.message) : "Managed auth failed",
                  }),
                }),
              );

            return yield* HttpServerResponse.html(popupHtml(result, RAW_COMPOSIO_CHANNEL));
          }),
        ),
      ),
);

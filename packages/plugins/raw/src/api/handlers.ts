import { HttpApiBuilder } from "@effect/platform";
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

export const RawHandlers = HttpApiBuilder.group(
  ExecutorApiWithRaw,
  "raw",
  (handlers) =>
    handlers
      .handle("addSource", ({ path, payload }) =>
        capture(
          Effect.gen(function* () {
            const ext = yield* RawExtensionService;
            return yield* ext.addSource({
              baseUrl: payload.baseUrl,
              scope: path.scopeId,
              name: payload.name,
              namespace: payload.namespace,
              headers: payload.headers as
                | Record<string, HeaderValue>
                | undefined,
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
            const ext = yield* RawExtensionService;
            yield* ext.updateSource(path.namespace, path.scopeId, {
              name: payload.name,
              baseUrl: payload.baseUrl,
              headers: payload.headers as
                | Record<string, HeaderValue>
                | undefined,
            } as RawUpdateSourceInput);
            return { updated: true };
          }),
        ),
      ),
);

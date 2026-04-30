// Protected-side API wiring. Kept separate from `./layers.ts` so tests
// can import the protected API + shared services without dragging in
// non-protected/org handlers (which transitively import
// `@tanstack/react-start`, unresolvable in the Workers test runtime).

import { HttpApiBuilder, HttpRouter, HttpServer } from "@effect/platform";
import { Effect, Layer } from "effect";

import { CoreExecutorApi, InternalError, observabilityMiddleware } from "@executor/api";
import { CoreHandlers } from "@executor/api/server";
import { OpenApiGroup, OpenApiHandlers } from "@executor/plugin-openapi/api";
import { McpGroup, McpHandlers } from "@executor/plugin-mcp/api";
import {
  GoogleDiscoveryGroup,
  GoogleDiscoveryHandlers,
} from "@executor/plugin-google-discovery/api";
import { GraphqlGroup, GraphqlHandlers } from "@executor/plugin-graphql/api";
import { RawBillingService, RawGroup, RawHandlers } from "@executor/plugin-raw/api";
import { ManagedAuthBillingService } from "@executor/plugin-managed-auth";

import { AuthContext, OrgAuth } from "../auth/middleware";
import { OrgAuthLive } from "../auth/middleware-live";
import { UserStoreService } from "../auth/context";
import { WorkOSAuth } from "../auth/workos";
import { AutumnService } from "../services/autumn";
import { DbService } from "../services/db";
import { ErrorCaptureLive } from "../observability";

export const ProtectedCloudApi = CoreExecutorApi.add(OpenApiGroup)
  .add(McpGroup)
  .add(GoogleDiscoveryGroup)
  .add(GraphqlGroup)
  .add(RawGroup)
  .addError(InternalError)
  .middleware(OrgAuth);

const ObservabilityLive = observabilityMiddleware(ProtectedCloudApi);

const DbLive = DbService.Live;
const UserStoreLive = UserStoreService.Live.pipe(Layer.provide(DbLive));

const CloudRawBillingLive = Layer.succeed(RawBillingService, {
  canUseManagedAuth: () =>
    Effect.gen(function* () {
      const auth = yield* AuthContext;
      const autumn = yield* AutumnService;
      return yield* autumn.isFeatureAllowed(auth.organizationId, "managed-auth");
    }) as Effect.Effect<boolean, never, never>,
});

const CloudManagedAuthBillingLive = Layer.succeed(ManagedAuthBillingService, {
  canUseManagedAuth: () =>
    Effect.gen(function* () {
      const auth = yield* AuthContext;
      const autumn = yield* AutumnService;
      return yield* autumn.isFeatureAllowed(auth.organizationId, "managed-auth");
    }) as Effect.Effect<boolean, never, never>,
});

export const SharedServices = Layer.mergeAll(
  DbLive,
  UserStoreLive,
  WorkOSAuth.Default,
  AutumnService.Default,
  HttpServer.layerContext,
);

export const RouterConfig = HttpRouter.setRouterConfig({ maxParamLength: 1000 });

// Every handler the ProtectedCloudApi routes to, minus auth. The test
// harness builds its own api-live by merging this with a fake OrgAuth
// layer; prod merges it with OrgAuthLive below.
export const ProtectedCloudApiHandlers = Layer.mergeAll(
  CoreHandlers,
  OpenApiHandlers.pipe(Layer.provide(CloudManagedAuthBillingLive)),
  McpHandlers,
  GoogleDiscoveryHandlers.pipe(Layer.provide(CloudManagedAuthBillingLive)),
  GraphqlHandlers.pipe(Layer.provide(CloudManagedAuthBillingLive)),
  RawHandlers.pipe(Layer.provide(CloudRawBillingLive)),
);

// `ErrorCaptureLive` is provided above the handler + middleware layers
// so the `withCapture` translation path (typed-channel `StorageError →
// InternalError(traceId)`) AND the observability middleware's defect
// catchall both see the same Sentry-backed implementation.
export const ProtectedCloudApiLive = HttpApiBuilder.api(ProtectedCloudApi).pipe(
  Layer.provide(Layer.mergeAll(ProtectedCloudApiHandlers, OrgAuthLive, ObservabilityLive)),
  Layer.provide(ErrorCaptureLive),
);

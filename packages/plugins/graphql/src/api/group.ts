import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { ScopeId } from "@executor/sdk";
import { InternalError } from "@executor/api";

import {
  GraphqlComposioError,
  GraphqlIntrospectionError,
  GraphqlExtractionError,
} from "../sdk/errors";
import {
  ComposioSourceConfig,
  GraphqlInvocationAuth,
} from "../sdk/types";
import { StoredGraphqlSourceSchema } from "../sdk/store";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const namespaceParam = HttpApiSchema.param("namespace", Schema.String);

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const AddSourcePayload = Schema.Struct({
  endpoint: Schema.String,
  name: Schema.optional(Schema.String),
  introspectionJson: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  composio: Schema.optional(ComposioSourceConfig),
  auth: Schema.optional(GraphqlInvocationAuth),
});

const UpdateSourcePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  composio: Schema.optional(Schema.NullOr(ComposioSourceConfig)),
  auth: Schema.optional(Schema.NullOr(GraphqlInvocationAuth)),
});

const UpdateSourceResponse = Schema.Struct({
  updated: Schema.Boolean,
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const AddSourceResponse = Schema.Struct({
  toolCount: Schema.Number,
  namespace: Schema.String,
});

const StartComposioConnectPayload = Schema.Union(
  Schema.Struct({
    sourceId: Schema.String,
    callbackBaseUrl: Schema.String,
  }),
  Schema.Struct({
    callbackBaseUrl: Schema.String,
    app: Schema.String,
    authConfigId: Schema.optional(Schema.NullOr(Schema.String)),
    connectionId: Schema.String,
    displayName: Schema.optional(Schema.String),
  }),
);

const StartComposioConnectResponse = Schema.Struct({
  redirectUrl: Schema.String,
});

const ComposioCallbackUrlParams = Schema.Struct({
  state: Schema.String,
  connected_account_id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

// ---------------------------------------------------------------------------
// Errors with HTTP status
// ---------------------------------------------------------------------------

const IntrospectionError = GraphqlIntrospectionError.annotations(
  HttpApiSchema.annotations({ status: 400 }),
);
const ExtractionError = GraphqlExtractionError.annotations(
  HttpApiSchema.annotations({ status: 400 }),
);
const ComposioError = GraphqlComposioError.annotations(
  HttpApiSchema.annotations({ status: 400 }),
);

// ---------------------------------------------------------------------------
// Group
//
// Plugin SDK errors (GraphqlIntrospectionError etc.) are declared once at
// the group level via `.addError(...)` — every endpoint inherits them. The
// errors themselves carry their HTTP status via `HttpApiSchema.annotations`
// above, so handlers just `return yield* ext.foo(...)` and the schema
// encodes whatever it gets.
//
// 5xx is handled at the API level: `.addError(InternalError)` adds a
// single shared opaque-by-schema 500 surface translated from `StorageError`
// by `withCapture` at the HTTP edge. No per-handler wrapping, no
// per-plugin InternalError.
// ---------------------------------------------------------------------------

export class GraphqlGroup extends HttpApiGroup.make("graphql")
  .add(
    HttpApiEndpoint.post("addSource")`/scopes/${scopeIdParam}/graphql/sources`
      .setPayload(AddSourcePayload)
      .addSuccess(AddSourceResponse),
  )
  .add(
    HttpApiEndpoint.get("getSource")`/scopes/${scopeIdParam}/graphql/sources/${namespaceParam}`
      .addSuccess(Schema.NullOr(StoredGraphqlSourceSchema)),
  )
  .add(
    HttpApiEndpoint.patch("updateSource")`/scopes/${scopeIdParam}/graphql/sources/${namespaceParam}`
      .setPayload(UpdateSourcePayload)
      .addSuccess(UpdateSourceResponse),
  )
  .add(
    HttpApiEndpoint.post("startComposioConnect")`/scopes/${scopeIdParam}/graphql/composio/start`
      .setPayload(StartComposioConnectPayload)
      .addSuccess(StartComposioConnectResponse),
  )
  .add(
    HttpApiEndpoint.get("composioCallback", "/graphql/composio/callback")
      .setUrlParams(ComposioCallbackUrlParams)
      .addSuccess(
        Schema.Unknown.annotations(
          HttpApiSchema.annotations({ contentType: "text/html" }),
        ),
      ),
  )
  // Errors declared once at the group level — every endpoint inherits.
  // Plugin domain errors carry their own HttpApiSchema status (4xx);
  // `InternalError` is the shared opaque 500 translated at the HTTP
  // edge by `withCapture`.
  .addError(InternalError)
  .addError(IntrospectionError)
  .addError(ExtractionError)
  .addError(ComposioError) {}

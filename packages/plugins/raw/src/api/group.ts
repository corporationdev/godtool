import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

import { InternalError } from "@executor/api";
import { ScopeId } from "@executor/sdk";

import { RawComposioError } from "../sdk/errors";
import { StoredRawSourceSchema } from "../sdk/store";
import { ComposioSourceConfig, RawInvocationAuth } from "../sdk/types";

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const namespaceParam = HttpApiSchema.param("namespace", Schema.String);

const AddSourcePayload = Schema.Struct({
  baseUrl: Schema.String,
  name: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  composio: Schema.optional(ComposioSourceConfig),
  auth: Schema.optional(RawInvocationAuth),
});

const UpdateSourcePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  composio: Schema.optional(Schema.NullOr(ComposioSourceConfig)),
  auth: Schema.optional(Schema.NullOr(RawInvocationAuth)),
});

const AddSourceResponse = Schema.Struct({
  sourceId: Schema.String,
  toolCount: Schema.Number,
});

const UpdateSourceResponse = Schema.Struct({
  updated: Schema.Boolean,
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

const ComposioError = RawComposioError.annotations(
  HttpApiSchema.annotations({ status: 400 }),
);

export class RawGroup extends HttpApiGroup.make("raw")
  .add(
    HttpApiEndpoint.post("addSource")`/scopes/${scopeIdParam}/raw/sources`
      .setPayload(AddSourcePayload)
      .addSuccess(AddSourceResponse),
  )
  .add(
    HttpApiEndpoint.get("getSource")`/scopes/${scopeIdParam}/raw/sources/${namespaceParam}`
      .addSuccess(Schema.NullOr(StoredRawSourceSchema)),
  )
  .add(
    HttpApiEndpoint.patch("updateSource")`/scopes/${scopeIdParam}/raw/sources/${namespaceParam}`
      .setPayload(UpdateSourcePayload)
      .addSuccess(UpdateSourceResponse),
  )
  .add(
    HttpApiEndpoint.post("startComposioConnect")`/scopes/${scopeIdParam}/raw/composio/start`
      .setPayload(StartComposioConnectPayload)
      .addSuccess(StartComposioConnectResponse),
  )
  .add(
    HttpApiEndpoint.get("composioCallback", "/raw/composio/callback")
      .setUrlParams(ComposioCallbackUrlParams)
      .addSuccess(
        Schema.Unknown.annotations(
          HttpApiSchema.annotations({ contentType: "text/html" }),
        ),
      ),
  )
  .addError(InternalError)
  .addError(ComposioError) {}

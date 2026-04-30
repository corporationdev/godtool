import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

import { InternalError } from "@executor/api";
import { ScopeId } from "@executor/sdk";

import { StoredRawSourceSchema } from "../sdk/store";
import { ManagedAuthConfig, ManagedAuthConnectionMaterial } from "../sdk/types";

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);
const namespaceParam = HttpApiSchema.param("namespace", Schema.String);

const AddSourcePayload = Schema.Struct({
  baseUrl: Schema.String,
  name: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  managedAuth: Schema.optional(ManagedAuthConfig),
  managedConnection: Schema.optional(ManagedAuthConnectionMaterial),
});

const UpdateSourcePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  baseUrl: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  managedAuth: Schema.optional(Schema.NullOr(ManagedAuthConfig)),
});

const AddSourceResponse = Schema.Struct({
  sourceId: Schema.String,
  toolCount: Schema.Number,
});

const UpdateSourceResponse = Schema.Struct({
  updated: Schema.Boolean,
});

export class RawGroup extends HttpApiGroup.make("raw")
  .add(
    HttpApiEndpoint.post("addSource")`/scopes/${scopeIdParam}/raw/sources`
      .setPayload(AddSourcePayload)
      .addSuccess(AddSourceResponse),
  )
  .add(
    HttpApiEndpoint.get(
      "getSource",
    )`/scopes/${scopeIdParam}/raw/sources/${namespaceParam}`.addSuccess(
      Schema.NullOr(StoredRawSourceSchema),
    ),
  )
  .add(
    HttpApiEndpoint.patch("updateSource")`/scopes/${scopeIdParam}/raw/sources/${namespaceParam}`
      .setPayload(UpdateSourcePayload)
      .addSuccess(UpdateSourceResponse),
  )
  .addError(InternalError) {}

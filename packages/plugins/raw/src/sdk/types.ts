import { Schema } from "effect";

export const HeaderValue = Schema.Union(
  Schema.String,
  Schema.Struct({
    secretId: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
);
export type HeaderValue = typeof HeaderValue.Type;

export class ComposioSourceConfig extends Schema.Class<ComposioSourceConfig>(
  "RawComposioSourceConfig",
)({
  kind: Schema.Literal("composio"),
  app: Schema.String,
  authConfigId: Schema.NullOr(Schema.String),
  connectionId: Schema.String,
}) {}

export const RawInvocationAuth = Schema.Union(ComposioSourceConfig);
export type RawInvocationAuth = typeof RawInvocationAuth.Type;

export class RawComposioSession extends Schema.Class<RawComposioSession>(
  "RawComposioSession",
)({
  tokenScope: Schema.String,
  sourceId: Schema.NullOr(Schema.String),
  connectionId: Schema.String,
  displayName: Schema.String,
  app: Schema.String,
  authConfigId: Schema.NullOr(Schema.String),
}) {}

export class RawFetchResult extends Schema.Class<RawFetchResult>(
  "RawFetchResult",
)({
  ok: Schema.Boolean,
  status: Schema.Number,
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
  body: Schema.Unknown,
}) {}

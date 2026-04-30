import { Schema } from "effect";
import { ManagedAuthConfig, ManagedAuthConnectionMaterial } from "@executor/plugin-managed-auth";

export const HeaderValue = Schema.Union(
  Schema.String,
  Schema.Struct({
    secretId: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
);
export type HeaderValue = typeof HeaderValue.Type;

export class RawFetchResult extends Schema.Class<RawFetchResult>("RawFetchResult")({
  ok: Schema.Boolean,
  status: Schema.Number,
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
  body: Schema.Unknown,
}) {}

export { ManagedAuthConfig, ManagedAuthConnectionMaterial };

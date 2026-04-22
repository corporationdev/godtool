import { Schema } from "effect";

// ---------------------------------------------------------------------------
// GraphQL operation kind
// ---------------------------------------------------------------------------

export const GraphqlOperationKind = Schema.Literal("query", "mutation");
export type GraphqlOperationKind = typeof GraphqlOperationKind.Type;

// ---------------------------------------------------------------------------
// Extracted field (becomes a tool)
// ---------------------------------------------------------------------------

export class GraphqlArgument extends Schema.Class<GraphqlArgument>("GraphqlArgument")({
  name: Schema.String,
  typeName: Schema.String,
  required: Schema.Boolean,
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
}) {}

export class ExtractedField extends Schema.Class<ExtractedField>("ExtractedField")({
  /** e.g. "user", "createUser" */
  fieldName: Schema.String,
  /** "query" or "mutation" */
  kind: GraphqlOperationKind,
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
  arguments: Schema.Array(GraphqlArgument),
  /** JSON Schema for the input (built from arguments) */
  inputSchema: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  /** The return type name for documentation */
  returnTypeName: Schema.String,
}) {}

export class ExtractionResult extends Schema.Class<ExtractionResult>("ExtractionResult")({
  /** Schema name from introspection */
  schemaName: Schema.optionalWith(Schema.String, { as: "Option" }),
  fields: Schema.Array(ExtractedField),
}) {}

// ---------------------------------------------------------------------------
// Operation binding — minimal data needed to invoke
// ---------------------------------------------------------------------------

export class OperationBinding extends Schema.Class<OperationBinding>("OperationBinding")({
  kind: GraphqlOperationKind,
  fieldName: Schema.String,
  /** The full GraphQL query/mutation string */
  operationString: Schema.String,
  /** Ordered variable names for mapping */
  variableNames: Schema.Array(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export const HeaderValue = Schema.Union(
  Schema.String,
  Schema.Struct({
    secretId: Schema.String,
    prefix: Schema.optional(Schema.String),
  }),
);
export type HeaderValue = typeof HeaderValue.Type;

export class ComposioSourceConfig extends Schema.Class<ComposioSourceConfig>(
  "GraphqlComposioSourceConfig",
)({
  kind: Schema.Literal("composio"),
  /** Composio toolkit slug (e.g. "linear", "github"). */
  app: Schema.String,
  /** Composio auth config id for BYO OAuth apps. Null = Composio-managed. */
  authConfigId: Schema.NullOr(Schema.String),
  /** Stable local Connection id. */
  connectionId: Schema.String,
}) {}

export const GraphqlInvocationAuth = Schema.Union(ComposioSourceConfig);
export type GraphqlInvocationAuth = typeof GraphqlInvocationAuth.Type;

export class InvocationConfig extends Schema.Class<InvocationConfig>("InvocationConfig")({
  /** The GraphQL endpoint URL */
  endpoint: Schema.String,
  /** Headers applied to every request. Values can reference secrets. */
  headers: Schema.optionalWith(Schema.Record({ key: Schema.String, value: HeaderValue }), {
    default: () => ({}),
  }),
  /** Active auth path for invocation. */
  auth: Schema.optionalWith(GraphqlInvocationAuth, { as: "Option" }),
}) {}

export class GraphqlComposioSession extends Schema.Class<GraphqlComposioSession>(
  "GraphqlComposioSession",
)({
  /** Executor scope that will own the resulting Connection. */
  tokenScope: Schema.String,
  /** Source namespace when reconnecting an existing source. */
  sourceId: Schema.NullOr(Schema.String),
  /** Pre-decided Connection id written to the connection row on success. */
  connectionId: Schema.String,
  /** Friendly local label for the resulting connection/source. */
  displayName: Schema.String,
  app: Schema.String,
  authConfigId: Schema.NullOr(Schema.String),
}) {}

export class InvocationResult extends Schema.Class<InvocationResult>("InvocationResult")({
  status: Schema.Number,
  data: Schema.NullOr(Schema.Unknown),
  errors: Schema.NullOr(Schema.Unknown),
}) {}

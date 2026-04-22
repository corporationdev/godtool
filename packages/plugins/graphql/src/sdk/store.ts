import { Effect, Schema } from "effect";

import { defineSchema, type StorageDeps, type StorageFailure } from "@executor/sdk";

import {
  ComposioSourceConfig,
  GraphqlComposioSession,
  GraphqlInvocationAuth,
  OperationBinding,
  type HeaderValue,
} from "./types";

// ---------------------------------------------------------------------------
// Schema — three tables:
//   - graphql_source: endpoint + headers + auth per source
//   - graphql_operation: per-tool OperationBinding blob keyed by tool id
//   - graphql_composio_session: transient session rows used during Composio onboarding
// ---------------------------------------------------------------------------

export const graphqlSchema = defineSchema({
  graphql_source: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      endpoint: { type: "string", required: true },
      headers: { type: "json", required: false },
      composio: { type: "json", required: false },
      auth: { type: "json", required: false },
    },
  },
  graphql_operation: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      source_id: { type: "string", required: true, index: true },
      binding: { type: "json", required: true },
    },
  },
  graphql_composio_session: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      session: { type: "json", required: true },
      created_at: { type: "date", required: true },
    },
  },
});

export type GraphqlSchema = typeof graphqlSchema;

// ---------------------------------------------------------------------------
// In-memory value shapes
// ---------------------------------------------------------------------------

export interface StoredGraphqlSource {
  readonly namespace: string;
  /** Executor scope id this source row lives in. Writes stamp this on
   *  `scope_id`; reads return whichever scope's row the adapter's
   *  fall-through walk surfaced first. */
  readonly scope: string;
  readonly name: string;
  readonly endpoint: string;
  readonly headers: Record<string, HeaderValue>;
  readonly composio?: ComposioSourceConfig;
  readonly auth?: GraphqlInvocationAuth;
}

export class StoredGraphqlSourceSchema extends Schema.Class<StoredGraphqlSourceSchema>(
  "StoredGraphqlSourceSchema",
)({
  namespace: Schema.String,
  name: Schema.String,
  endpoint: Schema.String,
  headers: Schema.Record({ key: Schema.String, value: Schema.Union(
    Schema.String,
    Schema.Struct({
      secretId: Schema.String,
      prefix: Schema.optional(Schema.String),
    }),
  ) }),
  composio: Schema.optional(ComposioSourceConfig),
  auth: Schema.optional(GraphqlInvocationAuth),
}) {}

export interface StoredOperation {
  readonly toolId: string;
  readonly sourceId: string;
  readonly binding: OperationBinding;
}

// Persisted JSON shape for an OperationBinding. Reconstructed into a
// Schema.Class instance on read.
interface BindingJson {
  readonly kind: "query" | "mutation";
  readonly fieldName: string;
  readonly operationString: string;
  readonly variableNames: readonly string[];
}

const decodeBinding = (value: unknown): OperationBinding => {
  const data = typeof value === "string" ? (JSON.parse(value) as BindingJson) : (value as BindingJson);
  return new OperationBinding({
    kind: data.kind,
    fieldName: data.fieldName,
    operationString: data.operationString,
    variableNames: [...data.variableNames],
  });
};

const encodeBinding = (binding: OperationBinding): BindingJson => ({
  kind: binding.kind,
  fieldName: binding.fieldName,
  operationString: binding.operationString,
  variableNames: [...binding.variableNames],
});

const encodeComposioSourceConfig = Schema.encodeSync(ComposioSourceConfig);
const decodeComposioSourceConfig = Schema.decodeUnknownSync(ComposioSourceConfig);

const encodeInvocationAuth = Schema.encodeSync(GraphqlInvocationAuth);
const decodeInvocationAuth = Schema.decodeUnknownSync(GraphqlInvocationAuth);

const encodeComposioSession = Schema.encodeSync(GraphqlComposioSession);
const decodeComposioSession = Schema.decodeUnknownSync(GraphqlComposioSession);

const decodeHeaders = (value: unknown): Record<string, HeaderValue> => {
  if (value == null) return {};
  if (typeof value === "string") return JSON.parse(value) as Record<string, HeaderValue>;
  return value as Record<string, HeaderValue>;
};

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

// Every read/write that targets a single row pins BOTH the natural id
// (namespace, toolId) AND the owning `scope_id`. The store runs behind
// the scoped adapter (which auto-injects `scope_id IN (stack)`), so a
// bare `{id}` filter resolves to any matching row in the stack in
// adapter-iteration order. For shadowed rows (same id at multiple
// scopes — e.g. an org-level GraphQL source with a per-user override),
// that's a scope-isolation bug: updates and deletes can land on the
// wrong scope's row. Callers thread the resolved scope in (typically
// `path.scopeId` for HTTP, `toolRow.scope_id` / `input.scope` for
// invokeTool/lifecycle) so every keyed mutation targets exactly one
// row.
export interface GraphqlStore {
  readonly upsertSource: (
    input: StoredGraphqlSource,
    operations: readonly StoredOperation[],
  ) => Effect.Effect<void, StorageFailure>;

  readonly updateSourceMeta: (
    namespace: string,
    scope: string,
    patch: {
      readonly name?: string;
      readonly endpoint?: string;
      readonly headers?: Record<string, HeaderValue>;
      readonly composio?: ComposioSourceConfig | null;
      readonly auth?: GraphqlInvocationAuth | null;
    },
  ) => Effect.Effect<void, StorageFailure>;

  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<StoredGraphqlSource | null, StorageFailure>;

  readonly listSources: () => Effect.Effect<readonly StoredGraphqlSource[], StorageFailure>;

  readonly getOperationByToolId: (
    toolId: string,
    scope: string,
  ) => Effect.Effect<StoredOperation | null, StorageFailure>;

  readonly listOperationsBySource: (
    sourceId: string,
    scope: string,
  ) => Effect.Effect<readonly StoredOperation[], StorageFailure>;

  readonly removeSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;

  readonly putComposioSession: (
    id: string,
    session: GraphqlComposioSession,
  ) => Effect.Effect<void, StorageFailure>;

  readonly getComposioSession: (
    id: string,
  ) => Effect.Effect<GraphqlComposioSession | null, StorageFailure>;

  readonly deleteComposioSession: (
    id: string,
  ) => Effect.Effect<void, StorageFailure>;
}

// ---------------------------------------------------------------------------
// Default store implementation
// ---------------------------------------------------------------------------

export const makeDefaultGraphqlStore = ({
  adapter: db,
}: StorageDeps<GraphqlSchema>): GraphqlStore => {
  const rowToSource = (row: Record<string, unknown>): StoredGraphqlSource => ({
    namespace: row.id as string,
    scope: row.scope_id as string,
    name: row.name as string,
    endpoint: row.endpoint as string,
    headers: decodeHeaders(row.headers),
    composio:
      row.composio == null
        ? undefined
        : decodeComposioSourceConfig(
            typeof row.composio === "string" ? JSON.parse(row.composio) : row.composio,
          ),
    auth:
      row.auth == null
        ? undefined
        : decodeInvocationAuth(
            typeof row.auth === "string" ? JSON.parse(row.auth) : row.auth,
          ),
  });

  const rowToOperation = (row: Record<string, unknown>): StoredOperation => ({
    toolId: row.id as string,
    sourceId: row.source_id as string,
    binding: decodeBinding(row.binding),
  });

  const deleteSource = (namespace: string, scope: string) =>
    Effect.gen(function* () {
      yield* db.deleteMany({
        model: "graphql_operation",
        where: [
          { field: "source_id", value: namespace },
          { field: "scope_id", value: scope },
        ],
      });
      yield* db.delete({
        model: "graphql_source",
        where: [
          { field: "id", value: namespace },
          { field: "scope_id", value: scope },
        ],
      });
    });

  return {
    upsertSource: (input, operations) =>
      Effect.gen(function* () {
        yield* deleteSource(input.namespace, input.scope);
        yield* db.create({
          model: "graphql_source",
          data: {
            id: input.namespace,
            scope_id: input.scope,
            name: input.name,
            endpoint: input.endpoint,
            headers: input.headers as unknown as Record<string, unknown>,
            composio: input.composio
              ? (encodeComposioSourceConfig(input.composio) as unknown as Record<string, unknown>)
              : undefined,
            auth: input.auth
              ? (encodeInvocationAuth(input.auth) as unknown as Record<string, unknown>)
              : undefined,
          },
          forceAllowId: true,
        });
        if (operations.length > 0) {
          yield* db.createMany({
            model: "graphql_operation",
            data: operations.map((op) => ({
              id: op.toolId,
              scope_id: input.scope,
              source_id: op.sourceId,
              binding: encodeBinding(op.binding) as unknown as Record<string, unknown>,
            })),
            forceAllowId: true,
          });
        }
      }),

    updateSourceMeta: (namespace, scope, patch) =>
      Effect.gen(function* () {
        const existing = yield* db.findOne({
          model: "graphql_source",
          where: [
            { field: "id", value: namespace },
            { field: "scope_id", value: scope },
          ],
        });
        if (!existing) return;
        const update: Record<string, unknown> = {};
        if (patch.name !== undefined) update.name = patch.name;
        if (patch.endpoint !== undefined) update.endpoint = patch.endpoint;
        if (patch.headers !== undefined) {
          update.headers = patch.headers as unknown as Record<string, unknown>;
        }
        if (patch.composio !== undefined) {
          update.composio =
            patch.composio === null
              ? null
              : (encodeComposioSourceConfig(patch.composio) as unknown as Record<string, unknown>);
        }
        if (patch.auth !== undefined) {
          update.auth =
            patch.auth === null
              ? null
              : (encodeInvocationAuth(patch.auth) as unknown as Record<string, unknown>);
        }
        if (Object.keys(update).length === 0) return;
        yield* db.update({
          model: "graphql_source",
          where: [
            { field: "id", value: namespace },
            { field: "scope_id", value: scope },
          ],
          update,
        });
      }),

    getSource: (namespace, scope) =>
      db
        .findOne({
          model: "graphql_source",
          where: [
            { field: "id", value: namespace },
            { field: "scope_id", value: scope },
          ],
        })
        .pipe(Effect.map((row) => (row ? rowToSource(row) : null))),

    listSources: () =>
      db
        .findMany({ model: "graphql_source" })
        .pipe(Effect.map((rows) => rows.map(rowToSource))),

    getOperationByToolId: (toolId, scope) =>
      db
        .findOne({
          model: "graphql_operation",
          where: [
            { field: "id", value: toolId },
            { field: "scope_id", value: scope },
          ],
        })
        .pipe(Effect.map((row) => (row ? rowToOperation(row) : null))),

    listOperationsBySource: (sourceId, scope) =>
      db
        .findMany({
          model: "graphql_operation",
          where: [
            { field: "source_id", value: sourceId },
            { field: "scope_id", value: scope },
          ],
        })
        .pipe(Effect.map((rows) => rows.map(rowToOperation))),

    removeSource: (namespace, scope) => deleteSource(namespace, scope),

    putComposioSession: (id, session) =>
      db.create({
        model: "graphql_composio_session",
        data: {
          id,
          scope_id: session.tokenScope,
          session: encodeComposioSession(session) as unknown as Record<string, unknown>,
          created_at: new Date(),
        },
        forceAllowId: true,
      }),

    getComposioSession: (id) =>
      db
        .findOne({
          model: "graphql_composio_session",
          where: [{ field: "id", value: id }],
        })
        .pipe(
          Effect.map((row) =>
            row
              ? decodeComposioSession(
                  typeof row.session === "string" ? JSON.parse(row.session) : row.session,
                )
              : null,
          ),
        ),

    deleteComposioSession: (id) =>
      db.delete({
        model: "graphql_composio_session",
        where: [{ field: "id", value: id }],
      }),
  };
};

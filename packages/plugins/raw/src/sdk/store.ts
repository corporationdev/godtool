import { Effect, Schema } from "effect";

import { defineSchema, type StorageDeps, type StorageFailure } from "@executor/sdk";

import {
  ComposioSourceConfig,
  HeaderValue,
  RawComposioSession,
  RawInvocationAuth,
} from "./types";

export const rawSchema = defineSchema({
  raw_source: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      name: { type: "string", required: true },
      base_url: { type: "string", required: true },
      headers: { type: "json", required: false },
      composio: { type: "json", required: false },
      auth: { type: "json", required: false },
      created_at: { type: "date", required: true },
      updated_at: { type: "date", required: true },
    },
  },
  raw_composio_session: {
    fields: {
      id: { type: "string", required: true },
      scope_id: { type: "string", required: true, index: true },
      session: { type: "json", required: true },
      created_at: { type: "date", required: true },
    },
  },
});

export type RawSchema = typeof rawSchema;

export interface StoredRawSource {
  readonly namespace: string;
  readonly scope: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly headers: Record<string, HeaderValue>;
  readonly composio?: ComposioSourceConfig;
  readonly auth?: RawInvocationAuth;
}

export class StoredRawSourceSchema extends Schema.Class<StoredRawSourceSchema>(
  "StoredRawSourceSchema",
)({
  namespace: Schema.String,
  name: Schema.String,
  baseUrl: Schema.String,
  headers: Schema.Record({ key: Schema.String, value: HeaderValue }),
  composio: Schema.optional(ComposioSourceConfig),
  auth: Schema.optional(RawInvocationAuth),
}) {}

const encodeComposioSourceConfig = Schema.encodeSync(ComposioSourceConfig);
const decodeComposioSourceConfig = Schema.decodeUnknownSync(ComposioSourceConfig);
const encodeInvocationAuth = Schema.encodeSync(RawInvocationAuth);
const decodeInvocationAuth = Schema.decodeUnknownSync(RawInvocationAuth);
const encodeComposioSession = Schema.encodeSync(RawComposioSession);
const decodeComposioSession = Schema.decodeUnknownSync(RawComposioSession);

const decodeHeaders = (value: unknown): Record<string, HeaderValue> => {
  if (value == null) return {};
  if (typeof value === "string") return JSON.parse(value) as Record<string, HeaderValue>;
  return value as Record<string, HeaderValue>;
};

export interface RawStore {
  readonly upsertSource: (
    input: StoredRawSource,
  ) => Effect.Effect<void, StorageFailure>;
  readonly updateSourceMeta: (
    namespace: string,
    scope: string,
    patch: {
      readonly name?: string;
      readonly baseUrl?: string;
      readonly headers?: Record<string, HeaderValue>;
      readonly composio?: ComposioSourceConfig | null;
      readonly auth?: RawInvocationAuth | null;
    },
  ) => Effect.Effect<void, StorageFailure>;
  readonly getSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<StoredRawSource | null, StorageFailure>;
  readonly listSources: () => Effect.Effect<readonly StoredRawSource[], StorageFailure>;
  readonly removeSource: (
    namespace: string,
    scope: string,
  ) => Effect.Effect<void, StorageFailure>;
  readonly putComposioSession: (
    id: string,
    session: RawComposioSession,
  ) => Effect.Effect<void, StorageFailure>;
  readonly getComposioSession: (
    id: string,
  ) => Effect.Effect<RawComposioSession | null, StorageFailure>;
  readonly deleteComposioSession: (id: string) => Effect.Effect<void, StorageFailure>;
}

export const makeDefaultRawStore = ({
  adapter: db,
}: StorageDeps<RawSchema>): RawStore => {
  const rowToSource = (row: Record<string, unknown>): StoredRawSource => ({
    namespace: row.id as string,
    scope: row.scope_id as string,
    name: row.name as string,
    baseUrl: row.base_url as string,
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
        : decodeInvocationAuth(typeof row.auth === "string" ? JSON.parse(row.auth) : row.auth),
  });

  return {
    upsertSource: (input) =>
      Effect.gen(function* () {
        yield* db.delete({
          model: "raw_source",
          where: [
            { field: "id", value: input.namespace },
            { field: "scope_id", value: input.scope },
          ],
        });
        yield* db.create({
          model: "raw_source",
          data: {
            id: input.namespace,
            scope_id: input.scope,
            name: input.name,
            base_url: input.baseUrl,
            headers: input.headers as unknown as Record<string, unknown>,
            composio: input.composio
              ? (encodeComposioSourceConfig(input.composio) as unknown as Record<string, unknown>)
              : null,
            auth: input.auth
              ? (encodeInvocationAuth(input.auth) as unknown as Record<string, unknown>)
              : null,
            created_at: new Date(),
            updated_at: new Date(),
          },
          forceAllowId: true,
        });
      }),

    updateSourceMeta: (namespace, scope, patch) =>
      Effect.gen(function* () {
        const update: Record<string, unknown> = {
          updated_at: new Date(),
        };
        if (patch.name !== undefined) update.name = patch.name;
        if (patch.baseUrl !== undefined) update.base_url = patch.baseUrl;
        if (patch.headers !== undefined) update.headers = patch.headers;
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
        yield* db.update({
          model: "raw_source",
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
          model: "raw_source",
          where: [
            { field: "id", value: namespace },
            { field: "scope_id", value: scope },
          ],
        })
        .pipe(Effect.map((row) => (row ? rowToSource(row) : null))),

    listSources: () =>
      db.findMany({ model: "raw_source", where: [] }).pipe(Effect.map((rows) => rows.map(rowToSource))),

    removeSource: (namespace, scope) =>
      db.delete({
        model: "raw_source",
        where: [
          { field: "id", value: namespace },
          { field: "scope_id", value: scope },
        ],
      }),

    putComposioSession: (id, session) =>
      Effect.gen(function* () {
        yield* db.delete({
          model: "raw_composio_session",
          where: [
            { field: "id", value: id },
            { field: "scope_id", value: session.tokenScope },
          ],
        });
        yield* db.create({
          model: "raw_composio_session",
          data: {
            id,
            scope_id: session.tokenScope,
            session: encodeComposioSession(session) as unknown as Record<string, unknown>,
            created_at: new Date(),
          },
          forceAllowId: true,
        });
      }),

    getComposioSession: (id) =>
      db
        .findOne({
          model: "raw_composio_session",
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
        model: "raw_composio_session",
        where: [{ field: "id", value: id }],
      }),
  };
};

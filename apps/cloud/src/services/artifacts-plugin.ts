import { Effect } from "effect";

import type {
  ExecuteArtifact,
  ExecuteContentBlock,
} from "@executor/codemode-core";
import { definePlugin } from "@executor/sdk";

import {
  getCurrentExecutionArtifactContext,
  makeArtifactEnvelope,
} from "./execution-artifacts";

export interface ArtifactsBackend {
  readonly attachFile: (input: {
    readonly mimeType?: string;
    readonly name?: string;
    readonly path: string;
    readonly returnDirectory?: string | null;
    readonly timeoutSeconds?: number;
  }) => Promise<{
    readonly artifact: ExecuteArtifact;
    readonly content: ExecuteContentBlock;
  }>;
}

export interface ArtifactsPluginOptions {
  readonly backend: ArtifactsBackend;
}

const objectSchema = {
  type: "object",
  additionalProperties: false,
} as const;

type JsonObject = Record<string, unknown>;

const record = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
};

const readTimeoutSeconds = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("timeoutSeconds must be a positive number when provided.");
  }
  return Math.min(Math.floor(value), 120);
};

export const artifactsPlugin = (options: ArtifactsPluginOptions) =>
  definePlugin(() => ({
    id: "artifacts" as const,
    storage: () => ({}),
    extension: () => ({}),
    staticSources: () => [
      {
        id: "artifacts",
        kind: "files",
        name: "Artifacts",
        tools: [
          {
            name: "attachFile",
            description:
              "Attach a file from the sandbox to the execution result so the model can inspect it. Use this for downloaded files, generated images, PDFs, spreadsheets, archives, or any file the agent needs returned.",
            inputSchema: {
              ...objectSchema,
              properties: {
                path: { type: "string" },
                name: { type: "string" },
                mimeType: { type: "string" },
                timeoutSeconds: { type: "number" },
              },
              required: ["path"],
            },
            outputSchema: {
              type: "object",
              properties: {
                artifact: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    path: { type: "string" },
                    uri: { type: "string" },
                    mimeType: { type: "string" },
                    size: { type: "number" },
                  },
                  required: ["name", "path", "uri", "mimeType", "size"],
                },
                attachment: {},
              },
              required: ["artifact", "attachment"],
            },
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const context = yield* getCurrentExecutionArtifactContext;
                const attached = yield* Effect.tryPromise({
                  try: () =>
                    options.backend.attachFile({
                      path: requireString(input.path, "path"),
                      name: optionalString(input.name),
                      mimeType: optionalString(input.mimeType),
                      returnDirectory: context?.returnDirectory ?? null,
                      timeoutSeconds: readTimeoutSeconds(input.timeoutSeconds),
                    }),
                  catch: (error) =>
                    error instanceof Error ? error : new Error(String(error)),
                });

                return {
                  artifact: attached.artifact,
                  attachment: makeArtifactEnvelope(attached),
                };
              }),
          },
        ],
      },
    ],
  }))();

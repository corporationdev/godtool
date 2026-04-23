import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

import { InternalError } from "@executor/api";

export const FilesSessionResponse = Schema.Struct({
  expiresAt: Schema.String,
  sandboxId: Schema.String,
  sandboxStatus: Schema.Literal("created", "reused"),
  url: Schema.String,
});

export const FilesSandboxProvisionResponse = Schema.Struct({
  sandboxId: Schema.String,
  sandboxStatus: Schema.Literal("created", "reused"),
});

export class FilesApi extends HttpApiGroup.make("files")
  .add(HttpApiEndpoint.post("createSession")`/files/session`.addSuccess(FilesSessionResponse))
  .add(
    HttpApiEndpoint.post("ensureSandbox")`/files/sandbox`.addSuccess(
      FilesSandboxProvisionResponse,
    ),
  )
  .addError(InternalError) {}

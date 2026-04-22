import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

import { InternalError } from "@executor/api";

export const FilesSessionResponse = Schema.Struct({
  expiresAt: Schema.String,
  sandboxId: Schema.String,
  sandboxStatus: Schema.Literal("created", "reused"),
  url: Schema.String,
});

export class FilesApi extends HttpApiGroup.make("files")
  .add(HttpApiEndpoint.post("createSession")`/files/session`.addSuccess(FilesSessionResponse))
  .addError(InternalError) {}

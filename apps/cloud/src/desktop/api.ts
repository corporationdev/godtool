import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

import { InternalError } from "@executor/api";

export const DesktopSessionResponse = Schema.Struct({
  expiresAt: Schema.String,
  sandboxId: Schema.String,
  sandboxStatus: Schema.Literal("created", "reused"),
  url: Schema.String,
});

export class DesktopApi extends HttpApiGroup.make("desktop")
  .add(HttpApiEndpoint.post("createSession")`/desktop/session`.addSuccess(DesktopSessionResponse))
  .addError(InternalError) {}

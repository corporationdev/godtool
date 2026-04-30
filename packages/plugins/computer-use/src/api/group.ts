import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { InternalError } from "@executor/api";
import { ScopeId } from "@executor/sdk";

import { ComputerUseHostError, ComputerUsePermissionError } from "../index";

const scopeIdParam = HttpApiSchema.param("scopeId", ScopeId);

const PermissionStatus = Schema.Struct({
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
});

const AddSourceResponse = Schema.Struct({
  namespace: Schema.String,
  toolCount: Schema.Number,
});

const ComputerUsePermissionHttpError = ComputerUsePermissionError.annotations(
  HttpApiSchema.annotations({ status: 400 }),
);

const ComputerUseHostHttpError = ComputerUseHostError.annotations(
  HttpApiSchema.annotations({ status: 503 }),
);

export class ComputerUseGroup extends HttpApiGroup.make("computerUse")
  .add(
    HttpApiEndpoint.get("status")`/scopes/${scopeIdParam}/computer-use/status`.addSuccess(
      PermissionStatus,
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "requestAccessibilityPermission",
    )`/scopes/${scopeIdParam}/computer-use/permissions/accessibility/request`.addSuccess(
      PermissionStatus,
    ),
  )
  .add(
    HttpApiEndpoint.post(
      "requestScreenRecordingPermission",
    )`/scopes/${scopeIdParam}/computer-use/permissions/screen-recording/request`.addSuccess(
      PermissionStatus,
    ),
  )
  .add(
    HttpApiEndpoint.post("addSource")`/scopes/${scopeIdParam}/computer-use/sources`.addSuccess(
      AddSourceResponse,
    ),
  )
  .addError(InternalError)
  .addError(ComputerUseHostHttpError)
  .addError(ComputerUsePermissionHttpError) {}

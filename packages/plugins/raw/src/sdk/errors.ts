import { Data, Schema } from "effect";
import type { Option } from "effect";

export class RawComposioError extends Schema.TaggedError<RawComposioError>()(
  "RawComposioError",
  {
    message: Schema.String,
  },
) {}

export class RawInvocationError extends Data.TaggedError("RawInvocationError")<{
  readonly message: string;
  readonly statusCode: Option.Option<number>;
  readonly cause?: unknown;
}> {}

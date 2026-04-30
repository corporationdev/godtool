import { Data } from "effect";
import type { Option } from "effect";

export class RawInvocationError extends Data.TaggedError("RawInvocationError")<{
  readonly message: string;
  readonly statusCode: Option.Option<number>;
  readonly cause?: unknown;
}> {}

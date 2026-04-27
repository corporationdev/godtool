import { FiberRef, Effect } from "effect";

import type {
  ExecuteArtifact,
  ExecuteContentBlock,
} from "@executor/codemode-core";

export const EXECUTOR_ARTIFACT_MARKER = "__executorArtifact";
export const EXECUTOR_CONTENT_MARKER = "__executorContent";

export interface ExecutionArtifactContext {
  readonly returnDirectory: string;
  readonly runId: string;
}

export const currentExecutionArtifactContext =
  FiberRef.unsafeMake<ExecutionArtifactContext | null>(null);

export const getCurrentExecutionArtifactContext = Effect.flatMap(
  FiberRef.get(currentExecutionArtifactContext),
  (context) => Effect.succeed(context),
);

export const makeArtifactEnvelope = (input: {
  readonly artifact: ExecuteArtifact;
  readonly content: ExecuteContentBlock;
}) => ({
  [EXECUTOR_ARTIFACT_MARKER]: true,
  artifact: input.artifact,
  content: input.content,
});

export const makeContentEnvelope = (content: ExecuteContentBlock) => ({
  [EXECUTOR_CONTENT_MARKER]: true,
  content,
});

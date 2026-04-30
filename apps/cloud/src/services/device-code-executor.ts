import { env } from "cloudflare:workers";
import { Data, Effect } from "effect";
import type * as Cause from "effect/Cause";

import type {
  CodeExecutor,
  ExecuteResult,
  SandboxToolInvoker,
} from "@executor/execution";

type DeviceSessionBinding = DurableObjectNamespace<import("../device-session").DeviceSessionDO>;

const INTERNAL_USER_ID_HEADER = "x-godtool-device-user-id";
const INTERNAL_ORGANIZATION_ID_HEADER = "x-godtool-device-organization-id";
const INTERNAL_ORGANIZATION_NAME_HEADER = "x-godtool-device-organization-name";

export class DeviceExecutionError extends Data.TaggedError("DeviceExecutionError")<{
  readonly message: string;
  readonly status?: number;
}> {}

type DeviceExecuteResponse =
  | {
      readonly status: "completed";
      readonly result: ExecuteResult;
    }
  | {
      readonly status?: string;
      readonly error?: string;
    };

type DeviceCodeExecutorOptions<E extends Cause.YieldableError> = {
  readonly fallback: CodeExecutor<E>;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly userId: string;
};

const deviceSessionNamespace = (): DeviceSessionBinding | null =>
  (env as Env & { DEVICE_SESSION?: DeviceSessionBinding }).DEVICE_SESSION ?? null;

const renderErrorMessage = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }
  return String(value);
};

const shouldFallback = (status: number): boolean =>
  status === 404 || status === 409 || status === 503 || status === 504;

const responseError = (body: DeviceExecuteResponse | null): string | null =>
  body && "error" in body && typeof body.error === "string" ? body.error : null;

const executeOnDevice = (
  options: DeviceCodeExecutorOptions<Cause.YieldableError>,
  code: string,
): Effect.Effect<ExecuteResult | null, DeviceExecutionError> =>
  Effect.tryPromise({
    try: async () => {
      const namespace = deviceSessionNamespace();
      if (!namespace) return null;

      const stub = namespace.get(namespace.idFromName(`org:${options.organizationId}`));
      const response = await stub.fetch("https://device-session/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTERNAL_USER_ID_HEADER]: options.userId,
          [INTERNAL_ORGANIZATION_ID_HEADER]: options.organizationId,
          [INTERNAL_ORGANIZATION_NAME_HEADER]: options.organizationName,
        },
        body: JSON.stringify({ code }),
      });

      const body = (await response.json().catch(() => null)) as DeviceExecuteResponse | null;
      if (!response.ok) {
        if (shouldFallback(response.status)) return null;
        throw new DeviceExecutionError({
          message: responseError(body) ?? `Desktop execution failed with status ${response.status}`,
          status: response.status,
        });
      }

      if (body?.status !== "completed" || !("result" in body)) {
        throw new DeviceExecutionError({
          message: "Desktop execution returned an invalid response",
          status: response.status,
        });
      }

      return body.result;
    },
    catch: (cause) =>
      cause instanceof DeviceExecutionError
        ? cause
        : new DeviceExecutionError({ message: renderErrorMessage(cause) }),
  });

export const makeDeviceFirstCodeExecutor = <E extends Cause.YieldableError>(
  options: DeviceCodeExecutorOptions<E>,
): CodeExecutor<DeviceExecutionError> => ({
  execute: (code: string, toolInvoker: SandboxToolInvoker) =>
    Effect.gen(function* () {
      const deviceResult = yield* executeOnDevice(options, code);
      if (deviceResult) return deviceResult;

      return yield* options.fallback.execute(code, toolInvoker).pipe(
        Effect.mapError((error) => new DeviceExecutionError({ message: renderErrorMessage(error) })),
      );
    }),
});

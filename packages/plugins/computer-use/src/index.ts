import { Effect, Schema } from "effect";

import {
  definePlugin,
  type SourceLifecycleInput,
  type StaticToolDecl,
  type StorageFailure,
  type ToolRow,
} from "@executor/sdk";

export interface ComputerUsePluginConfig {
  readonly hostUrl?: string;
}

export interface ComputerUsePermissionStatus {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

export interface ComputerUseAddSourceInput {
  readonly scope: string;
  readonly namespace?: string;
  readonly name?: string;
}

export interface ComputerUseAddSourceResult {
  readonly namespace: string;
  readonly toolCount: number;
}

export class ComputerUsePermissionError extends Schema.TaggedError<ComputerUsePermissionError>()(
  "ComputerUsePermissionError",
  {
    message: Schema.String,
  },
) {}

export class ComputerUseHostError extends Schema.TaggedError<ComputerUseHostError>()(
  "ComputerUseHostError",
  {
    message: Schema.String,
  },
) {}

export interface ComputerUsePluginExtension {
  readonly status: () => Effect.Effect<ComputerUsePermissionStatus, ComputerUseHostError>;
  readonly requestAccessibilityPermission: () => Effect.Effect<
    ComputerUsePermissionStatus,
    ComputerUseHostError
  >;
  readonly requestScreenRecordingPermission: () => Effect.Effect<
    ComputerUsePermissionStatus,
    ComputerUseHostError
  >;
  readonly addSource: (
    input: ComputerUseAddSourceInput,
  ) => Effect.Effect<
    ComputerUseAddSourceResult,
    ComputerUseHostError | ComputerUsePermissionError | StorageFailure
  >;
}

interface ComputerUseHostResponse<T> {
  readonly ok?: boolean;
  readonly error?: string;
  readonly value?: T;
}

const SOURCE_ID = "computer_use";
const SOURCE_KIND = "computer_use";
const SOURCE_NAME = "Computer Use";

const hostUrlFromConfig = (config?: ComputerUsePluginConfig): string =>
  (
    config?.hostUrl ??
    process.env.GODTOOL_COMPUTER_USE_HOST_URL ??
    process.env.EXECUTOR_COMPUTER_USE_HOST_URL ??
    "http://127.0.0.1:14790"
  ).replace(/\/+$/, "");

const request = async <T>(
  hostUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> => {
  const response = await fetch(`${hostUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const raw = await response.text();
  let data: ComputerUseHostResponse<T>;
  try {
    data = (raw.length === 0 ? {} : JSON.parse(raw)) as ComputerUseHostResponse<T>;
  } catch {
    throw new Error(
      `Computer Use host returned non-JSON response (${response.status}): ${raw.slice(0, 200)}`,
    );
  }
  if (!response.ok) {
    throw new Error(data.error ?? `Computer Use host request failed: ${response.status}`);
  }
  return (data.value ?? data) as T;
};

const hostRequest = <A>(
  config: ComputerUsePluginConfig | undefined,
  path: string,
  init?: RequestInit,
): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: () => request<A>(hostUrlFromConfig(config), path, init),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const extensionHostRequest = <A>(
  config: ComputerUsePluginConfig | undefined,
  path: string,
  init?: RequestInit,
): Effect.Effect<A, ComputerUseHostError> =>
  hostRequest<A>(config, path, init).pipe(
    Effect.mapError(
      (cause) => new ComputerUseHostError({ message: cause.message }),
    ),
  );

const tool = <A>(
  config: ComputerUsePluginConfig | undefined,
  path: string,
  body?: unknown,
): Effect.Effect<A, Error> =>
  hostRequest<A>(config, path, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const normalizeStatus = (status: ComputerUsePermissionStatus): ComputerUsePermissionStatus => ({
  accessibility: Boolean(status.accessibility),
  screenRecording: Boolean(status.screenRecording),
});

const permissionsGranted = (status: ComputerUsePermissionStatus): boolean =>
  status.accessibility && status.screenRecording;

const AppArgs = Schema.Struct({
  app: Schema.String,
});

const ClickArgs = Schema.Struct({
  app: Schema.String,
  element_index: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
  click_count: Schema.optional(Schema.Number),
  mouse_button: Schema.optional(Schema.Literal("left", "right", "middle")),
});

const DragArgs = Schema.Struct({
  app: Schema.String,
  from_x: Schema.Number,
  from_y: Schema.Number,
  to_x: Schema.Number,
  to_y: Schema.Number,
});

const ScrollArgs = Schema.Struct({
  app: Schema.String,
  element_index: Schema.String,
  direction: Schema.Literal("up", "down", "left", "right"),
  pages: Schema.optional(Schema.Number),
});

const SetValueArgs = Schema.Struct({
  app: Schema.String,
  element_index: Schema.String,
  value: Schema.String,
});

const SecondaryActionArgs = Schema.Struct({
  app: Schema.String,
  element_index: Schema.String,
  action: Schema.String,
});

const PressKeyArgs = Schema.Struct({
  app: Schema.String,
  key: Schema.String,
});

const TypeTextArgs = Schema.Struct({
  app: Schema.String,
  text: Schema.String,
});

const decodeAppArgs = Schema.decodeUnknownSync(AppArgs);
const decodeClickArgs = Schema.decodeUnknownSync(ClickArgs);
const decodeDragArgs = Schema.decodeUnknownSync(DragArgs);
const decodeScrollArgs = Schema.decodeUnknownSync(ScrollArgs);
const decodeSetValueArgs = Schema.decodeUnknownSync(SetValueArgs);
const decodeSecondaryActionArgs = Schema.decodeUnknownSync(SecondaryActionArgs);
const decodePressKeyArgs = Schema.decodeUnknownSync(PressKeyArgs);
const decodeTypeTextArgs = Schema.decodeUnknownSync(TypeTextArgs);

const emptySchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const appSchema = {
  type: "object",
  additionalProperties: false,
  required: ["app"],
  properties: { app: { type: "string" } },
} as const;

const clickSchema = {
  type: "object",
  additionalProperties: false,
  required: ["app"],
  properties: {
    app: { type: "string" },
    element_index: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    click_count: { type: "number" },
    mouse_button: { type: "string", enum: ["left", "right", "middle"] },
  },
} as const;

const dragSchema = {
  type: "object",
  additionalProperties: false,
  required: ["app", "from_x", "from_y", "to_x", "to_y"],
  properties: {
    app: { type: "string" },
    from_x: { type: "number" },
    from_y: { type: "number" },
    to_x: { type: "number" },
    to_y: { type: "number" },
  },
} as const;

const scrollSchema = {
  type: "object",
  additionalProperties: false,
  required: ["app", "element_index", "direction"],
  properties: {
    app: { type: "string" },
    element_index: { type: "string" },
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    pages: { type: "number" },
  },
} as const;

const setValueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["app", "element_index", "value"],
  properties: {
    app: { type: "string" },
    element_index: { type: "string" },
    value: { type: "string" },
  },
} as const;

const secondaryActionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["app", "element_index", "action"],
  properties: {
    app: { type: "string" },
    element_index: { type: "string" },
    action: { type: "string" },
  },
} as const;

const pressKeySchema = {
  type: "object",
  additionalProperties: false,
  required: ["app", "key"],
  properties: { app: { type: "string" }, key: { type: "string" } },
} as const;

const typeTextSchema = {
  type: "object",
  additionalProperties: false,
  required: ["app", "text"],
  properties: { app: { type: "string" }, text: { type: "string" } },
} as const;

const toolDeclarations = (
  config: ComputerUsePluginConfig | undefined,
): readonly StaticToolDecl[] => [
  {
    name: "list_apps",
    description: "List running macOS apps available to Computer Use.",
    inputSchema: emptySchema,
    handler: () => tool(config, "/apps"),
  },
  {
    name: "get_app_state",
    description: "Return a macOS app accessibility tree and window screenshot for the target app.",
    inputSchema: appSchema,
    handler: ({ args }) => tool(config, "/state", decodeAppArgs(args)),
  },
  {
    name: "click",
    description: "Click an accessibility element index from get_app_state, or raw screenshot coordinates.",
    inputSchema: clickSchema,
    handler: ({ args }) => tool(config, "/click", decodeClickArgs(args)),
  },
  {
    name: "drag",
    description: "Drag from one screen coordinate to another.",
    inputSchema: dragSchema,
    handler: ({ args }) => tool(config, "/drag", decodeDragArgs(args)),
  },
  {
    name: "scroll",
    description: "Scroll an accessibility element in a direction by pages.",
    inputSchema: scrollSchema,
    handler: ({ args }) => tool(config, "/scroll", decodeScrollArgs(args)),
  },
  {
    name: "set_value",
    description: "Set the value of a settable accessibility element.",
    inputSchema: setValueSchema,
    handler: ({ args }) => tool(config, "/set-value", decodeSetValueArgs(args)),
  },
  {
    name: "perform_secondary_action",
    description: "Invoke a named accessibility action exposed by an element.",
    inputSchema: secondaryActionSchema,
    handler: ({ args }) =>
      tool(config, "/secondary-action", decodeSecondaryActionArgs(args)),
  },
  {
    name: "press_key",
    description: "Press a keyboard key or key combination, such as Return, Tab, or super+c.",
    inputSchema: pressKeySchema,
    handler: ({ args }) => tool(config, "/press-key", decodePressKeyArgs(args)),
  },
  {
    name: "type_text",
    description: "Type literal text using keyboard input.",
    inputSchema: typeTextSchema,
    handler: ({ args }) => tool(config, "/type-text", decodeTypeTextArgs(args)),
  },
];

const toolByName = (config: ComputerUsePluginConfig | undefined) =>
  new Map(toolDeclarations(config).map((decl) => [decl.name, decl] as const));

const dynamicTools = (config: ComputerUsePluginConfig | undefined) =>
  toolDeclarations(config).map((decl) => ({
    name: decl.name,
    description: decl.description,
    inputSchema: decl.inputSchema,
    outputSchema: decl.outputSchema,
    annotations: decl.annotations,
  }));

const invokeDynamicTool = (
  config: ComputerUsePluginConfig | undefined,
  toolRow: ToolRow,
  args: unknown,
) => {
  const decl = toolByName(config).get(toolRow.name);
  if (!decl) return Effect.fail(new Error(`Unknown Computer Use tool: ${toolRow.name}`));
  return decl.handler({ args, ctx: undefined as never, elicit: undefined as never });
};

export const computerUsePlugin = definePlugin((config?: ComputerUsePluginConfig) => ({
  id: SOURCE_ID,
  storage: () => ({}),
  extension: (ctx): ComputerUsePluginExtension => {
    const status = () =>
      extensionHostRequest<ComputerUsePermissionStatus>(config, "/permissions/status").pipe(
        Effect.map(normalizeStatus),
      );

    return {
      status,
      requestAccessibilityPermission: () =>
        extensionHostRequest<ComputerUsePermissionStatus>(
          config,
          "/permissions/accessibility/request",
          { method: "POST" },
        ).pipe(Effect.map(normalizeStatus)),
      requestScreenRecordingPermission: () =>
        extensionHostRequest<ComputerUsePermissionStatus>(
          config,
          "/permissions/screen-recording/request",
          { method: "POST" },
        ).pipe(Effect.map(normalizeStatus)),
      addSource: (input) =>
        Effect.gen(function* () {
          const permissionStatus = yield* status();
          if (!permissionsGranted(permissionStatus)) {
            return yield* Effect.fail(
              new ComputerUsePermissionError({
                message: "Computer Use needs Accessibility and Screen Recording permissions.",
              }),
            );
          }

          const namespace = input.namespace?.trim() || SOURCE_ID;
          const name = input.name?.trim() || SOURCE_NAME;
          const tools = dynamicTools(config);

          yield* ctx.core.sources.register({
            id: namespace,
            scope: input.scope,
            kind: SOURCE_KIND,
            name,
            canRemove: true,
            canRefresh: false,
            canEdit: true,
            tools,
          });

          return { namespace, toolCount: tools.length };
        }),
    };
  },
  invokeTool: ({ toolRow, args }) => invokeDynamicTool(config, toolRow, args),
  removeSource: (_input: SourceLifecycleInput) => Effect.void,
}));

export type ComputerUsePlugin = ReturnType<typeof computerUsePlugin>;

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

export interface ComputerCommandResult {
  readonly exitCode: number;
  readonly logs: string;
  readonly status: string;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ComputerUseBackend {
  readonly runAgentBrowser: (input: {
    readonly args: readonly string[];
    readonly timeoutSeconds?: number;
  }) => Promise<ComputerCommandResult>;
  readonly runDesktopCommand: (input: {
    readonly command: string;
    readonly timeoutSeconds?: number;
  }) => Promise<ComputerCommandResult>;
}

export interface ComputerUsePluginOptions {
  readonly backend: ComputerUseBackend;
}

type JsonObject = Record<string, unknown>;

const DESKTOP_SCREENSHOT_DIRECTORY = "/tmp/godtool-agent-screenshots";
const MAX_ARGUMENTS = 100;
const MAX_ARGUMENT_LENGTH = 8_000;
const MAX_TEXT_LENGTH = 100_000;

const browserCommands = [
  "open",
  "click",
  "dblclick",
  "type",
  "fill",
  "press",
  "hover",
  "focus",
  "check",
  "uncheck",
  "select",
  "drag",
  "upload",
  "download",
  "scroll",
  "scrollintoview",
  "wait",
  "screenshot",
  "pdf",
  "snapshot",
  "eval",
  "connect",
  "close",
  "back",
  "forward",
  "reload",
  "get",
  "is",
  "find",
  "mouse",
  "set",
  "network",
  "cookies",
  "storage",
  "tab",
  "trace",
  "record",
  "console",
  "errors",
  "highlight",
  "session",
] as const;

const objectSchema = {
  type: "object",
  additionalProperties: false,
} as const;

const commandResultSchema = {
  type: "object",
  properties: {
    exitCode: { type: "number" },
    logs: { type: "string" },
    status: { type: "string" },
    stderr: { type: "string" },
    stdout: { type: "string" },
  },
  required: ["exitCode", "logs", "status", "stderr", "stdout"],
} as const;

const record = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

const optionalBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const optionalNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  return value;
};

const requireNumber = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
};

const readTimeoutSeconds = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  const timeout = optionalNumber(value, Number.NaN);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("timeoutSeconds must be a positive number when provided.");
  }
  return Math.min(Math.floor(timeout), 120);
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const readStringArray = (value: unknown, name: string): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of strings.`);
  }
  if (value.length > MAX_ARGUMENTS) {
    throw new Error(`${name} may contain at most ${MAX_ARGUMENTS} arguments.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`${name}[${index}] must be a string.`);
    }
    if (item.length > MAX_ARGUMENT_LENGTH) {
      throw new Error(`${name}[${index}] is too long.`);
    }
    return item;
  });
};

const run = (
  backend: ComputerUseBackend,
  input: { readonly command: string; readonly timeoutSeconds?: number },
) =>
  Effect.tryPromise({
    try: () => backend.runDesktopCommand(input),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });

const runBrowser = (
  backend: ComputerUseBackend,
  input: { readonly args: readonly string[]; readonly timeoutSeconds?: number },
) =>
  Effect.tryPromise({
    try: () => backend.runAgentBrowser(input),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });

const failOnNonZero = (result: ComputerCommandResult) => {
  if (result.exitCode === 0) {
    return result;
  }
  const detail = [result.stderr.trim(), result.stdout.trim()]
    .filter((part) => part.length > 0)
    .join("\n");
  throw new Error(
    detail.length > 0
      ? `Computer command failed with exit code ${result.exitCode}:\n${detail}`
      : `Computer command failed with exit code ${result.exitCode}.`,
  );
};

const parseMaybeJson = (stdout: string): unknown => {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const estimateBase64Size = (data: string): number => {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
};

const basename = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

const attachInlineContent = (input: {
  readonly data: string | null;
  readonly mimeType: string;
  readonly path: string;
}): ReturnType<typeof makeArtifactEnvelope> | null => {
  const artifact: ExecuteArtifact = {
    name: basename(input.path),
    path: input.path,
    uri: `file://${input.path}`,
    mimeType: input.mimeType,
    size: input.data ? estimateBase64Size(input.data) : 0,
  };
  const content: ExecuteContentBlock = input.data
    ? {
        type: "image",
        data: input.data,
        mimeType: input.mimeType,
      }
    : {
        type: "resource_link",
        uri: artifact.uri,
        name: artifact.name,
        mimeType: artifact.mimeType,
      };
  return makeArtifactEnvelope({ artifact, content });
};

const windowListScript = [
  "set -e",
  "ids=$(xdotool search --onlyvisible --name . 2>/dev/null || true)",
  "for id in $ids; do",
  "  name=$(xdotool getwindowname \"$id\" 2>/dev/null || true)",
  "  class=$(xdotool getwindowclassname \"$id\" 2>/dev/null || true)",
  "  geometry=$(xdotool getwindowgeometry --shell \"$id\" 2>/dev/null || true)",
  "  printf '%s\\t%s\\t%s\\t%s\\n' \"$id\" \"$class\" \"$name\" \"$(printf '%s' \"$geometry\" | tr '\\n' ' ')\"",
  "done",
].join("\n");

const parseWindowList = (stdout: string) =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", className = "", name = "", geometry = ""] = line.split("\t");
      return { id, className, name, geometry };
    });

export const computerUsePlugin = (options: ComputerUsePluginOptions) =>
  definePlugin(() => ({
    id: "computer" as const,
    storage: () => ({}),
    extension: () => ({}),
    staticSources: () => [
      {
        id: "computer",
        kind: "control",
        name: "Computer Use",
        tools: [
          {
            name: "desktop.screenshot",
            description:
              "Take a screenshot of the live XFCE desktop. Returns the image path and, by default, a base64 JPEG/PNG payload for small screenshots.",
            inputSchema: {
              ...objectSchema,
              properties: {
                path: { type: "string" },
                format: { type: "string", enum: ["png", "jpg"] },
                timeoutSeconds: { type: "number" },
              },
            },
            outputSchema: {
              type: "object",
              properties: {
                path: { type: "string" },
                mimeType: { type: "string" },
                exitCode: { type: "number" },
                attachment: {},
              },
              required: ["path", "mimeType", "exitCode", "attachment"],
            },
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const context = yield* getCurrentExecutionArtifactContext;
                const format = input.format === "jpg" ? "jpg" : "png";
                const path =
                  optionalString(input.path) ??
                  `${
                    context?.returnDirectory ?? DESKTOP_SCREENSHOT_DIRECTORY
                  }/desktop-screenshot-${Date.now().toString(36)}.${format}`;
                const mimeType = format === "jpg" ? "image/jpeg" : "image/png";
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                const capture = [
                  `mkdir -p ${shellQuote(path.split("/").slice(0, -1).join("/") || ".")}`,
                  `scrot -z ${shellQuote(path)}`,
                  `printf '\\n__GODTOOL_IMAGE__\\n'; base64 -w 0 ${shellQuote(path)}`,
                ].join(" && ");
                const result = failOnNonZero(
                  yield* run(options.backend, { command: capture, timeoutSeconds }),
                );
                const marker = "\n__GODTOOL_IMAGE__\n";
                const markerIndex = result.stdout.indexOf(marker);
                const data =
                  markerIndex >= 0 ? result.stdout.slice(markerIndex + marker.length).trim() : null;
                return {
                  path,
                  mimeType,
                  exitCode: result.exitCode,
                  attachment: attachInlineContent({ data, mimeType, path }),
                };
              }),
          },
          {
            name: "desktop.clipboard.get",
            description: "Read text from the X clipboard or primary selection.",
            inputSchema: {
              ...objectSchema,
              properties: {
                selection: { type: "string", enum: ["clipboard", "primary"] },
                timeoutSeconds: { type: "number" },
              },
            },
            outputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const selection = input.selection === "primary" ? "primary" : "clipboard";
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                const result = yield* run(options.backend, {
                  command: `xclip -selection ${selection} -o 2>/dev/null || true`,
                  timeoutSeconds,
                });
                return { text: result.stdout };
              }),
          },
          {
            name: "desktop.clipboard.set",
            description: "Set text on the X clipboard or primary selection.",
            inputSchema: {
              ...objectSchema,
              properties: {
                text: { type: "string" },
                selection: { type: "string", enum: ["clipboard", "primary"] },
                timeoutSeconds: { type: "number" },
              },
              required: ["text"],
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const text = requireString(input.text, "text");
                if (text.length > MAX_TEXT_LENGTH) {
                  throw new Error(`text may contain at most ${MAX_TEXT_LENGTH} characters.`);
                }
                const selection = input.selection === "primary" ? "primary" : "clipboard";
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* run(options.backend, {
                    command: `printf %s ${shellQuote(text)} | xclip -selection ${selection}`,
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "desktop.clipboard.clear",
            description: "Clear the X clipboard or primary selection.",
            inputSchema: {
              ...objectSchema,
              properties: {
                selection: { type: "string", enum: ["clipboard", "primary"] },
                timeoutSeconds: { type: "number" },
              },
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const selection = input.selection === "primary" ? "primary" : "clipboard";
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* run(options.backend, {
                    command: `printf '' | xclip -selection ${selection}`,
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "desktop.xdotool",
            description:
              "Run an xdotool command against the live desktop. Pass raw xdotool arguments as an array, for example { args: [\"search\", \"--name\", \"Chrome\"] }.",
            inputSchema: {
              ...objectSchema,
              properties: {
                args: { type: "array", items: { type: "string" } },
                timeoutSeconds: { type: "number" },
              },
              required: ["args"],
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const xdotoolArgs = readStringArray(input.args, "args");
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return yield* run(options.backend, {
                  command: ["xdotool", ...xdotoolArgs.map(shellQuote)].join(" "),
                  timeoutSeconds,
                });
              }),
          },
          {
            name: "desktop.mouse.move",
            description: "Move the desktop mouse pointer to absolute screen coordinates.",
            inputSchema: {
              ...objectSchema,
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                timeoutSeconds: { type: "number" },
              },
              required: ["x", "y"],
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const x = requireNumber(input.x, "x");
                const y = requireNumber(input.y, "y");
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* run(options.backend, {
                    command: `xdotool mousemove --sync ${Math.round(x)} ${Math.round(y)}`,
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "desktop.mouse.click",
            description: "Click a mouse button, optionally after moving to absolute screen coordinates.",
            inputSchema: {
              ...objectSchema,
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                button: { type: "number" },
                count: { type: "number" },
                timeoutSeconds: { type: "number" },
              },
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const button = Math.max(1, Math.floor(optionalNumber(input.button, 1)));
                const count = Math.max(1, Math.floor(optionalNumber(input.count, 1)));
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                const move =
                  input.x === undefined || input.y === undefined
                    ? ""
                    : `xdotool mousemove --sync ${Math.round(requireNumber(input.x, "x"))} ${Math.round(requireNumber(input.y, "y"))} && `;
                return failOnNonZero(
                  yield* run(options.backend, {
                    command: `${move}xdotool click --repeat ${count} ${button}`,
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "desktop.mouse.drag",
            description: "Drag the mouse from one absolute coordinate to another.",
            inputSchema: {
              ...objectSchema,
              properties: {
                fromX: { type: "number" },
                fromY: { type: "number" },
                toX: { type: "number" },
                toY: { type: "number" },
                button: { type: "number" },
                timeoutSeconds: { type: "number" },
              },
              required: ["fromX", "fromY", "toX", "toY"],
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const fromX = Math.round(requireNumber(input.fromX, "fromX"));
                const fromY = Math.round(requireNumber(input.fromY, "fromY"));
                const toX = Math.round(requireNumber(input.toX, "toX"));
                const toY = Math.round(requireNumber(input.toY, "toY"));
                const button = Math.max(1, Math.floor(optionalNumber(input.button, 1)));
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* run(options.backend, {
                    command: [
                      `xdotool mousemove --sync ${fromX} ${fromY}`,
                      `xdotool mousedown ${button}`,
                      `xdotool mousemove --sync ${toX} ${toY}`,
                      `xdotool mouseup ${button}`,
                    ].join(" && "),
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "desktop.key",
            description:
              "Press a desktop key or key chord using xdotool syntax, for example Return, ctrl+l, alt+Tab, or super+r.",
            inputSchema: {
              ...objectSchema,
              properties: {
                key: { type: "string" },
                clearModifiers: { type: "boolean" },
                timeoutSeconds: { type: "number" },
              },
              required: ["key"],
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const key = requireString(input.key, "key");
                const clearModifiers = optionalBoolean(input.clearModifiers, true);
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* run(options.backend, {
                    command: `xdotool key ${clearModifiers ? "--clearmodifiers " : ""}${shellQuote(key)}`,
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "desktop.type",
            description: "Type text into the currently focused desktop application.",
            inputSchema: {
              ...objectSchema,
              properties: {
                text: { type: "string" },
                delayMs: { type: "number" },
                timeoutSeconds: { type: "number" },
              },
              required: ["text"],
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const text = requireString(input.text, "text");
                if (text.length > MAX_TEXT_LENGTH) {
                  throw new Error(`text may contain at most ${MAX_TEXT_LENGTH} characters.`);
                }
                const delayMs = Math.max(0, Math.floor(optionalNumber(input.delayMs, 12)));
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* run(options.backend, {
                    command: `xdotool type --delay ${delayMs} ${shellQuote(text)}`,
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "desktop.windows.list",
            description: "List visible desktop windows with xdotool window IDs, classes, names, and geometry.",
            inputSchema: {
              ...objectSchema,
              properties: { timeoutSeconds: { type: "number" } },
            },
            outputSchema: {
              type: "object",
              properties: {
                windows: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      className: { type: "string" },
                      name: { type: "string" },
                      geometry: { type: "string" },
                    },
                    required: ["id", "className", "name", "geometry"],
                  },
                },
              },
              required: ["windows"],
            },
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                const result = failOnNonZero(
                  yield* run(options.backend, {
                    command: windowListScript,
                    timeoutSeconds,
                  }),
                );
                return { windows: parseWindowList(result.stdout) };
              }),
          },
          {
            name: "desktop.window.activate",
            description: "Activate/focus a desktop window by xdotool window ID.",
            inputSchema: {
              ...objectSchema,
              properties: {
                windowId: { type: "string" },
                timeoutSeconds: { type: "number" },
              },
              required: ["windowId"],
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const windowId = requireString(input.windowId, "windowId");
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* run(options.backend, {
                    command: `xdotool windowactivate --sync ${shellQuote(windowId)}`,
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "browser.run",
            description:
              "Run any supported agent-browser command against the visible Chrome via CDP port 9222. Commands include open, click, fill, press, snapshot, get, find, mouse, network, cookies, storage, tab, console, errors, trace, and record.",
            inputSchema: {
              ...objectSchema,
              properties: {
                command: { type: "string", enum: [...browserCommands] },
                args: { type: "array", items: { type: "string" } },
                json: { type: "boolean" },
                timeoutSeconds: { type: "number" },
              },
              required: ["command"],
            },
            outputSchema: {
              type: "object",
              properties: {
                parsed: {},
                result: commandResultSchema,
              },
              required: ["parsed", "result"],
            },
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const command = requireString(input.command, "command");
                if (!browserCommands.includes(command as (typeof browserCommands)[number])) {
                  throw new Error(`Unsupported agent-browser command: ${command}`);
                }
                const extraArgs =
                  input.args === undefined ? [] : readStringArray(input.args, "args");
                const json = optionalBoolean(input.json, true);
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                const result = yield* runBrowser(options.backend, {
                  args: [json ? "--json" : "", command, ...extraArgs].filter(Boolean),
                  timeoutSeconds,
                });
                return {
                  parsed: parseMaybeJson(result.stdout),
                  result,
                };
              }),
          },
          {
            name: "browser.open",
            description: "Navigate the visible Chrome browser to a URL.",
            inputSchema: {
              ...objectSchema,
              properties: {
                url: { type: "string" },
                timeoutSeconds: { type: "number" },
              },
              required: ["url"],
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* runBrowser(options.backend, {
                    args: ["--json", "open", requireString(input.url, "url")],
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "browser.snapshot",
            description:
              "Return an accessibility snapshot of the visible Chrome page. Use this before clicking by @ref.",
            inputSchema: {
              ...objectSchema,
              properties: {
                interactive: { type: "boolean" },
                compact: { type: "boolean" },
                depth: { type: "number" },
                selector: { type: "string" },
                timeoutSeconds: { type: "number" },
              },
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const browserArgs = ["snapshot"];
                if (optionalBoolean(input.interactive, false)) browserArgs.push("-i");
                if (optionalBoolean(input.compact, false)) browserArgs.push("-c");
                if (typeof input.depth === "number") browserArgs.push("-d", String(input.depth));
                const selector = optionalString(input.selector);
                if (selector) browserArgs.push("-s", selector);
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* runBrowser(options.backend, {
                    args: browserArgs,
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "browser.screenshot",
            description:
              "Take a screenshot of the visible Chrome page via agent-browser and attach it to the result so the model can inspect it.",
            inputSchema: {
              ...objectSchema,
              properties: {
                path: { type: "string" },
                fullPage: { type: "boolean" },
                timeoutSeconds: { type: "number" },
              },
            },
            outputSchema: {
              type: "object",
              properties: {
                path: { type: "string" },
                mimeType: { type: "string" },
                result: commandResultSchema,
                attachment: {},
              },
              required: ["path", "mimeType", "result", "attachment"],
            },
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const context = yield* getCurrentExecutionArtifactContext;
                const path =
                  optionalString(input.path) ??
                  `${
                    context?.returnDirectory ?? DESKTOP_SCREENSHOT_DIRECTORY
                  }/browser-screenshot-${Date.now().toString(36)}.png`;
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                const result = failOnNonZero(
                  yield* runBrowser(options.backend, {
                    args: [
                      "--json",
                      "screenshot",
                      path,
                      ...(optionalBoolean(input.fullPage, false) ? ["--full"] : []),
                    ],
                    timeoutSeconds,
                  }),
                );
                const read = failOnNonZero(
                  yield* run(options.backend, {
                    command: `base64 -w 0 ${shellQuote(path)}`,
                    timeoutSeconds,
                  }),
                );
                const mimeType = "image/png";
                return {
                  path,
                  mimeType,
                  result,
                  attachment: attachInlineContent({
                    data: read.stdout.trim(),
                    mimeType,
                    path,
                  }),
                };
              }),
          },
          {
            name: "browser.click",
            description: "Click a browser element by CSS selector or agent-browser @ref.",
            inputSchema: {
              ...objectSchema,
              properties: {
                selector: { type: "string" },
                timeoutSeconds: { type: "number" },
              },
              required: ["selector"],
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* runBrowser(options.backend, {
                    args: ["--json", "click", requireString(input.selector, "selector")],
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "browser.fill",
            description: "Clear and fill a browser input by CSS selector or agent-browser @ref.",
            inputSchema: {
              ...objectSchema,
              properties: {
                selector: { type: "string" },
                text: { type: "string" },
                timeoutSeconds: { type: "number" },
              },
              required: ["selector", "text"],
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* runBrowser(options.backend, {
                    args: [
                      "--json",
                      "fill",
                      requireString(input.selector, "selector"),
                      requireString(input.text, "text"),
                    ],
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "browser.press",
            description: "Press a key in the browser, for example Enter, Tab, Escape, or Control+a.",
            inputSchema: {
              ...objectSchema,
              properties: {
                key: { type: "string" },
                timeoutSeconds: { type: "number" },
              },
              required: ["key"],
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* runBrowser(options.backend, {
                    args: ["--json", "press", requireString(input.key, "key")],
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "browser.get",
            description:
              "Read browser state via agent-browser get, such as text, html, value, title, url, count, box, styles, or attr.",
            inputSchema: {
              ...objectSchema,
              properties: {
                what: { type: "string" },
                selector: { type: "string" },
                extra: { type: "array", items: { type: "string" } },
                timeoutSeconds: { type: "number" },
              },
              required: ["what"],
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const extra = input.extra === undefined ? [] : readStringArray(input.extra, "extra");
                const selector = optionalString(input.selector);
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* runBrowser(options.backend, {
                    args: [
                      "--json",
                      "get",
                      requireString(input.what, "what"),
                      ...(selector ? [selector] : []),
                      ...extra,
                    ],
                    timeoutSeconds,
                  }),
                );
              }),
          },
          {
            name: "browser.eval",
            description: "Evaluate JavaScript in the visible Chrome page via agent-browser.",
            inputSchema: {
              ...objectSchema,
              properties: {
                script: { type: "string" },
                timeoutSeconds: { type: "number" },
              },
              required: ["script"],
            },
            outputSchema: commandResultSchema,
            handler: ({ args }) =>
              Effect.gen(function* () {
                const input = record(args);
                const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
                return failOnNonZero(
                  yield* runBrowser(options.backend, {
                    args: ["--json", "eval", requireString(input.script, "script")],
                    timeoutSeconds,
                  }),
                );
              }),
          },
        ],
      },
    ],
  }))();

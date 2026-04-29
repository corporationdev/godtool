import { writeFileSync } from "node:fs";
import { Effect, Schema } from "effect";

import { definePlugin } from "@executor/sdk";

export interface BrowserSessionSnapshot {
  readonly id: string;
  readonly agentId: string;
  readonly url: string;
  readonly title: string;
  readonly busy: boolean;
  readonly pinned: boolean;
  readonly visible: boolean;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly targetId: string | null;
  readonly cdpUrl: string;
  readonly webSocketDebuggerUrl: string | null;
}

export interface BrowserPluginConfig {
  readonly hostUrl?: string;
}

interface BrowserHostResponse<T> {
  readonly session?: BrowserSessionSnapshot;
  readonly sessions?: readonly BrowserSessionSnapshot[];
  readonly ok?: boolean;
  readonly error?: string;
  readonly value?: T;
}

interface CdpResponse<T> {
  readonly id?: number;
  readonly result?: T;
  readonly error?: { readonly message?: string; readonly [key: string]: unknown };
}

interface RuntimeEvaluateResult<T> {
  readonly result: {
    readonly value?: T;
    readonly description?: string;
    readonly unserializableValue?: string;
  };
  readonly exceptionDetails?: {
    readonly text?: string;
    readonly exception?: { readonly description?: string };
  };
}

const hostUrlFromConfig = (config?: BrowserPluginConfig): string =>
  (config?.hostUrl ?? process.env.GODTOOL_BROWSER_HOST_URL ?? "http://127.0.0.1:14789").replace(
    /\/+$/,
    "",
  );

const request = async <T>(
  hostUrl: string,
  path: string,
  init?: RequestInit,
): Promise<BrowserHostResponse<T>> => {
  const response = await fetch(`${hostUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const data = (await response.json()) as BrowserHostResponse<T>;
  if (!response.ok) {
    throw new Error(data.error ?? `Browser host request failed: ${response.status}`);
  }
  return data;
};

const AgentArgs = Schema.Struct({
  agentId: Schema.String,
});

const OpenArgs = Schema.Struct({
  agentId: Schema.String,
  url: Schema.String,
});

const SelectorArgs = Schema.Struct({
  agentId: Schema.String,
  selector: Schema.String,
});

const TextSelectorArgs = Schema.Struct({
  agentId: Schema.String,
  selector: Schema.String,
  text: Schema.String,
});

const SelectArgs = Schema.Struct({
  agentId: Schema.String,
  selector: Schema.String,
  values: Schema.Array(Schema.String),
});

const PressArgs = Schema.Struct({
  agentId: Schema.String,
  key: Schema.String,
});

const ScrollArgs = Schema.Struct({
  agentId: Schema.String,
  direction: Schema.Literal("up", "down", "left", "right"),
  pixels: Schema.optional(Schema.Number),
});

const WaitArgs = Schema.Struct({
  agentId: Schema.String,
  selector: Schema.optional(Schema.String),
  ms: Schema.optional(Schema.Number),
  timeoutMs: Schema.optional(Schema.Number),
});

const ScreenshotArgs = Schema.Struct({
  agentId: Schema.String,
  path: Schema.optional(Schema.String),
  full: Schema.optional(Schema.Boolean),
});

const EvaluateArgs = Schema.Struct({
  agentId: Schema.String,
  code: Schema.String,
});

const AttributeArgs = Schema.Struct({
  agentId: Schema.String,
  selector: Schema.String,
  name: Schema.String,
});

const FindArgs = Schema.Struct({
  agentId: Schema.String,
  locator: Schema.Literal("role", "text", "label", "placeholder", "alt", "title", "testid"),
  value: Schema.String,
  action: Schema.optional(
    Schema.Literal("click", "fill", "type", "hover", "focus", "check", "uncheck"),
  ),
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  exact: Schema.optional(Schema.Boolean),
});

const decodeAgentArgs = Schema.decodeUnknownSync(AgentArgs);
const decodeOpenArgs = Schema.decodeUnknownSync(OpenArgs);
const decodeSelectorArgs = Schema.decodeUnknownSync(SelectorArgs);
const decodeTextSelectorArgs = Schema.decodeUnknownSync(TextSelectorArgs);
const decodeSelectArgs = Schema.decodeUnknownSync(SelectArgs);
const decodePressArgs = Schema.decodeUnknownSync(PressArgs);
const decodeScrollArgs = Schema.decodeUnknownSync(ScrollArgs);
const decodeWaitArgs = Schema.decodeUnknownSync(WaitArgs);
const decodeScreenshotArgs = Schema.decodeUnknownSync(ScreenshotArgs);
const decodeEvaluateArgs = Schema.decodeUnknownSync(EvaluateArgs);
const decodeAttributeArgs = Schema.decodeUnknownSync(AttributeArgs);
const decodeFindArgs = Schema.decodeUnknownSync(FindArgs);

const agentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId"],
  properties: { agentId: { type: "string" } },
} as const;

const openSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "url"],
  properties: { agentId: { type: "string" }, url: { type: "string" } },
} as const;

const selectorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "selector"],
  properties: { agentId: { type: "string" }, selector: { type: "string" } },
} as const;

const textSelectorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "selector", "text"],
  properties: {
    agentId: { type: "string" },
    selector: { type: "string" },
    text: { type: "string" },
  },
} as const;

const selectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "selector", "values"],
  properties: {
    agentId: { type: "string" },
    selector: { type: "string" },
    values: { type: "array", items: { type: "string" } },
  },
} as const;

const pressSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "key"],
  properties: { agentId: { type: "string" }, key: { type: "string" } },
} as const;

const scrollSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "direction"],
  properties: {
    agentId: { type: "string" },
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    pixels: { type: "number" },
  },
} as const;

const waitSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId"],
  properties: {
    agentId: { type: "string" },
    selector: { type: "string" },
    ms: { type: "number" },
    timeoutMs: { type: "number" },
  },
} as const;

const screenshotSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId"],
  properties: {
    agentId: { type: "string" },
    path: { type: "string" },
    full: { type: "boolean" },
  },
} as const;

const evaluateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "code"],
  properties: { agentId: { type: "string" }, code: { type: "string" } },
} as const;

const attributeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "selector", "name"],
  properties: {
    agentId: { type: "string" },
    selector: { type: "string" },
    name: { type: "string" },
  },
} as const;

const findSchema = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "locator", "value"],
  properties: {
    agentId: { type: "string" },
    locator: {
      type: "string",
      enum: ["role", "text", "label", "placeholder", "alt", "title", "testid"],
    },
    value: { type: "string" },
    action: {
      type: "string",
      enum: ["click", "fill", "type", "hover", "focus", "check", "uncheck"],
    },
    text: { type: "string" },
    name: { type: "string" },
    exact: { type: "boolean" },
  },
} as const;

const withSession = <A>(
  config: BrowserPluginConfig | undefined,
  agentId: string,
  run: (session: BrowserSessionSnapshot, hostUrl: string) => Promise<A>,
): Effect.Effect<A, Error> =>
  Effect.tryPromise(async () => {
    const hostUrl = hostUrlFromConfig(config);
    const data = await request<never>(hostUrl, "/sessions/ensure", {
      method: "POST",
      body: JSON.stringify({ agentId, busy: true }),
    });
    if (!data.session) throw new Error("Browser host did not return a session");

    try {
      return await run(data.session, hostUrl);
    } finally {
      await request<never>(hostUrl, `/sessions/${encodeURIComponent(data.session.id)}/touch`, {
        method: "POST",
        body: JSON.stringify({ busy: false }),
      }).catch(() => undefined);
    }
  });

const connect = (session: BrowserSessionSnapshot) =>
  new Promise<{
    send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
    close: () => void;
  }>((resolve, reject) => {
    if (!session.webSocketDebuggerUrl) {
      reject(new Error(`Browser session has no debuggable page target: ${session.id}`));
      return;
    }

    const socket = new WebSocket(session.webSocketDebuggerUrl);
    const pending = new Map<
      number,
      { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
    >();
    let nextId = 0;
    const openTimeout = setTimeout(() => {
      reject(new Error(`Timed out connecting to browser target ${session.targetId ?? session.id}`));
      socket.close();
    }, 5_000);

    socket.addEventListener("open", () => {
      clearTimeout(openTimeout);
      resolve({
        send: <T>(method: string, params: Record<string, unknown> = {}) =>
          new Promise<T>((resolveMessage, rejectMessage) => {
            const id = ++nextId;
            pending.set(id, {
              resolve: (value) => resolveMessage(value as T),
              reject: rejectMessage,
            });
            socket.send(JSON.stringify({ id, method, params }));
          }),
        close: () => socket.close(),
      });
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse<unknown>;
      if (!message.id) return;
      const callbacks = pending.get(message.id);
      if (!callbacks) return;
      pending.delete(message.id);
      if (message.error) {
        callbacks.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        callbacks.resolve(message.result);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(openTimeout);
      reject(new Error(`Failed to connect to browser target ${session.targetId ?? session.id}`));
    });
  });

const evaluateInSession = async <T>(session: BrowserSessionSnapshot, code: string): Promise<T> => {
  const cdp = await connect(session);
  try {
    await cdp.send("Runtime.enable");
    const result = await cdp.send<RuntimeEvaluateResult<T>>("Runtime.evaluate", {
      expression: code,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "Browser evaluation failed",
      );
    }
    return result.result.value as T;
  } finally {
    cdp.close();
  }
};

const elementScript = (selector: string, body: string): string => `
(() => {
  const selector = ${JSON.stringify(selector)};
  const resolveElement = (value) => {
    if (value.startsWith("@")) return globalThis.__executorBrowserRefs?.[value] ?? null;
    return document.querySelector(value);
  };
  const element = resolveElement(selector);
  if (!element) throw new Error("Element not found: " + selector);
  ${body}
})()
`;

const getBox = (session: BrowserSessionSnapshot, selector: string) =>
  evaluateInSession<{ x: number; y: number; width: number; height: number }>(
    session,
    elementScript(
      selector,
      `
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
`,
    ),
  );

const clickAt = async (
  session: BrowserSessionSnapshot,
  selector: string,
  clickCount: number,
): Promise<{ readonly clicked: true }> => {
  const box = await getBox(session, selector);
  const cdp = await connect(session);
  try {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount,
    });
    return { clicked: true };
  } finally {
    cdp.close();
  }
};

const keyName = (key: string): { key: string; code: string; windowsVirtualKeyCode: number } => {
  const normalized = key.toLowerCase();
  const named: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
    enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
    arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  };
  if (named[normalized]) return named[normalized];
  const character = key.length === 1 ? key : (key.at(-1) ?? key);
  return {
    key: character,
    code: `Key${character.toUpperCase()}`,
    windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0),
  };
};

const pressKey = async (session: BrowserSessionSnapshot, key: string) => {
  const parts = key
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const base = keyName(parts.at(-1) ?? key);
  const modifiers = parts.slice(0, -1).reduce((bits, part) => {
    const lower = part.toLowerCase();
    if (lower === "alt" || lower === "option") return bits | 1;
    if (lower === "ctrl" || lower === "control") return bits | 2;
    if (lower === "meta" || lower === "cmd" || lower === "command") return bits | 4;
    if (lower === "shift") return bits | 8;
    return bits;
  }, 0);
  const cdp = await connect(session);
  try {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...base });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...base });
    return { pressed: key };
  } finally {
    cdp.close();
  }
};

const actionByName = async (
  session: BrowserSessionSnapshot,
  selector: string,
  action: "click" | "fill" | "type" | "hover" | "focus" | "check" | "uncheck",
  text?: string,
) => {
  switch (action) {
    case "click":
      return clickAt(session, selector, 1);
    case "fill":
      return evaluateInSession(
        session,
        elementScript(
          selector,
          `
  element.focus();
  const value = ${JSON.stringify(text ?? "")};
  if ("value" in element) element.value = value;
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { filled: true };
`,
        ),
      );
    case "type": {
      await evaluateInSession(session, elementScript(selector, "element.focus(); return true;"));
      const cdp = await connect(session);
      try {
        await cdp.send("Input.insertText", { text: text ?? "" });
        return { typed: true };
      } finally {
        cdp.close();
      }
    }
    case "hover": {
      const box = await getBox(session, selector);
      const cdp = await connect(session);
      try {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        });
        return { hovered: true };
      } finally {
        cdp.close();
      }
    }
    case "focus":
      return evaluateInSession(
        session,
        elementScript(selector, "element.focus(); return { focused: true };"),
      );
    case "check":
    case "uncheck":
      return evaluateInSession(
        session,
        elementScript(
          selector,
          `
  if (!("checked" in element)) throw new Error("Element is not checkable: " + selector);
  element.checked = ${action === "check"};
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { checked: element.checked };
`,
        ),
      );
  }
};

const tool = <A>(
  config: BrowserPluginConfig | undefined,
  agentId: string,
  run: (session: BrowserSessionSnapshot, hostUrl: string) => Promise<A>,
) => withSession(config, agentId, run);

export const browserPlugin = definePlugin((config?: BrowserPluginConfig) => ({
  id: "browser" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "browser",
      kind: "browser",
      name: "Browser",
      canRemove: false,
      tools: [
        {
          name: "open",
          description: "Navigate the agent browser to a URL.",
          inputSchema: openSchema,
          handler: ({ args }) => {
            const input = decodeOpenArgs(args);
            return tool(config, input.agentId, async (session, hostUrl) => {
              const data = await request<never>(
                hostUrl,
                `/sessions/${encodeURIComponent(session.id)}/navigate`,
                { method: "POST", body: JSON.stringify({ url: input.url }) },
              );
              return data.session;
            });
          },
        },
        {
          name: "snapshot",
          description:
            "Return a compact accessibility-style snapshot with @e refs for visible elements.",
          inputSchema: agentSchema,
          handler: ({ args }) => {
            const input = decodeAgentArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession<string>(
                session,
                `
(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const nameOf = (element) =>
    element.getAttribute("aria-label") ||
    element.getAttribute("alt") ||
    element.getAttribute("title") ||
    element.placeholder ||
    element.innerText ||
    element.textContent ||
    element.value ||
    "";
  const roleOf = (element) =>
    element.getAttribute("role") ||
    ({ A: "link", BUTTON: "button", INPUT: element.type || "input", TEXTAREA: "textbox", SELECT: "combobox" })[element.tagName] ||
    element.tagName.toLowerCase();
  const candidates = [...document.querySelectorAll("a,button,input,textarea,select,[role],[tabindex],summary")]
    .filter(visible)
    .slice(0, 200);
  globalThis.__executorBrowserRefs = {};
  const lines = [
    "url: " + location.href,
    "title: " + document.title,
    ...candidates.map((element, index) => {
      const ref = "@e" + (index + 1);
      globalThis.__executorBrowserRefs[ref] = element;
      const disabled = element.disabled || element.getAttribute("aria-disabled") === "true" ? " disabled" : "";
      const checked = "checked" in element ? (element.checked ? " checked" : " unchecked") : "";
      return ref + " " + roleOf(element) + disabled + checked + " " + nameOf(element).replace(/\\s+/g, " ").trim().slice(0, 160);
    }),
  ];
  return lines.join("\\n");
})()
`,
              ),
            );
          },
        },
        {
          name: "click",
          description: "Click a CSS selector or @e ref from snapshot.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) => clickAt(session, input.selector, 1));
          },
        },
        {
          name: "doubleClick",
          description: "Double-click a CSS selector or @e ref from snapshot.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) => clickAt(session, input.selector, 2));
          },
        },
        {
          name: "type",
          description:
            "Type text into the currently focused element or a selector after focusing it.",
          inputSchema: textSelectorSchema,
          handler: ({ args }) => {
            const input = decodeTextSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              actionByName(session, input.selector, "type", input.text),
            );
          },
        },
        {
          name: "fill",
          description: "Clear and set the value of an input, textarea, or editable element.",
          inputSchema: textSelectorSchema,
          handler: ({ args }) => {
            const input = decodeTextSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              actionByName(session, input.selector, "fill", input.text),
            );
          },
        },
        {
          name: "press",
          description: "Press a keyboard key or combo such as Enter, Tab, Escape, or Control+a.",
          inputSchema: pressSchema,
          handler: ({ args }) => {
            const input = decodePressArgs(args);
            return tool(config, input.agentId, (session) => pressKey(session, input.key));
          },
        },
        {
          name: "hover",
          description: "Move the mouse over a CSS selector or @e ref.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              actionByName(session, input.selector, "hover"),
            );
          },
        },
        {
          name: "focus",
          description: "Focus a CSS selector or @e ref.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              actionByName(session, input.selector, "focus"),
            );
          },
        },
        {
          name: "check",
          description: "Check a checkbox or radio input.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              actionByName(session, input.selector, "check"),
            );
          },
        },
        {
          name: "uncheck",
          description: "Uncheck a checkbox input.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              actionByName(session, input.selector, "uncheck"),
            );
          },
        },
        {
          name: "select",
          description: "Select one or more values in a select element.",
          inputSchema: selectSchema,
          handler: ({ args }) => {
            const input = decodeSelectArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(
                session,
                elementScript(
                  input.selector,
                  `
  if (!(element instanceof HTMLSelectElement)) throw new Error("Element is not a select: " + selector);
  const values = new Set(${JSON.stringify(input.values)});
  for (const option of element.options) option.selected = values.has(option.value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { values: [...element.selectedOptions].map((option) => option.value) };
`,
                ),
              ),
            );
          },
        },
        {
          name: "scroll",
          description: "Scroll the page in a direction by pixels.",
          inputSchema: scrollSchema,
          handler: ({ args }) => {
            const input = decodeScrollArgs(args);
            return tool(config, input.agentId, (session) => {
              const amount = input.pixels ?? 600;
              const [x, y] =
                input.direction === "left"
                  ? [-amount, 0]
                  : input.direction === "right"
                    ? [amount, 0]
                    : input.direction === "up"
                      ? [0, -amount]
                      : [0, amount];
              return evaluateInSession(
                session,
                `window.scrollBy(${x}, ${y}); ({ x: scrollX, y: scrollY })`,
              );
            });
          },
        },
        {
          name: "scrollIntoView",
          description: "Scroll a CSS selector or @e ref into view.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(
                session,
                elementScript(
                  input.selector,
                  'element.scrollIntoView({ block: "center", inline: "center" }); return { scrolled: true };',
                ),
              ),
            );
          },
        },
        {
          name: "wait",
          description: "Wait for a selector to appear, or wait for a number of milliseconds.",
          inputSchema: waitSchema,
          handler: ({ args }) => {
            const input = decodeWaitArgs(args);
            return tool(config, input.agentId, async (session) => {
              if (input.ms !== undefined) {
                await new Promise((resolve) => setTimeout(resolve, input.ms));
                return { waitedMs: input.ms };
              }
              if (!input.selector) throw new Error("wait requires either selector or ms");
              const timeoutMs = input.timeoutMs ?? 5_000;
              return evaluateInSession(
                session,
                `
new Promise((resolve, reject) => {
  const selector = ${JSON.stringify(input.selector)};
  const deadline = Date.now() + ${timeoutMs};
  const tick = () => {
    if (document.querySelector(selector)) resolve({ found: true });
    else if (Date.now() > deadline) reject(new Error("Timed out waiting for selector: " + selector));
    else setTimeout(tick, 100);
  };
  tick();
})
`,
              );
            });
          },
        },
        {
          name: "screenshot",
          description:
            "Capture a PNG screenshot. Direct SDK calls return base64 data unless path is provided; executor MCP emits inline image content when no path is provided.",
          inputSchema: screenshotSchema,
          handler: ({ args }) => {
            const input = decodeScreenshotArgs(args);
            return tool(config, input.agentId, async (session) => {
              const cdp = await connect(session);
              try {
                const capture = await cdp.send<{ data: string }>("Page.captureScreenshot", {
                  format: "png",
                  captureBeyondViewport: input.full ?? false,
                });
                if (input.path) {
                  writeFileSync(input.path, Buffer.from(capture.data, "base64"));
                  return { path: input.path, mimeType: "image/png" };
                }
                return { data: capture.data, mimeType: "image/png" };
              } finally {
                cdp.close();
              }
            });
          },
        },
        {
          name: "evaluate",
          description:
            "Evaluate JavaScript in the current page and return a JSON-serializable result.",
          inputSchema: evaluateSchema,
          handler: ({ args }) => {
            const input = decodeEvaluateArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(session, `Promise.resolve((async () => { ${input.code} })())`),
            );
          },
        },
        {
          name: "back",
          description: "Go back in browser history.",
          inputSchema: agentSchema,
          handler: ({ args }) => {
            const input = decodeAgentArgs(args);
            return tool(config, input.agentId, (_session, hostUrl) =>
              request<never>(hostUrl, `/sessions/${encodeURIComponent(_session.id)}/back`, {
                method: "POST",
                body: "{}",
              }).then((data) => data.session),
            );
          },
        },
        {
          name: "forward",
          description: "Go forward in browser history.",
          inputSchema: agentSchema,
          handler: ({ args }) => {
            const input = decodeAgentArgs(args);
            return tool(config, input.agentId, (session, hostUrl) =>
              request<never>(hostUrl, `/sessions/${encodeURIComponent(session.id)}/forward`, {
                method: "POST",
                body: "{}",
              }).then((data) => data.session),
            );
          },
        },
        {
          name: "reload",
          description: "Reload the current page.",
          inputSchema: agentSchema,
          handler: ({ args }) => {
            const input = decodeAgentArgs(args);
            return tool(config, input.agentId, (session, hostUrl) =>
              request<never>(hostUrl, `/sessions/${encodeURIComponent(session.id)}/reload`, {
                method: "POST",
                body: "{}",
              }).then((data) => data.session),
            );
          },
        },
        {
          name: "getText",
          description: "Get text content for a selector or @e ref.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(
                session,
                elementScript(
                  input.selector,
                  "return element.innerText ?? element.textContent ?? '';",
                ),
              ),
            );
          },
        },
        {
          name: "getHtml",
          description: "Get inner HTML for a selector or @e ref.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(
                session,
                elementScript(input.selector, "return element.innerHTML;"),
              ),
            );
          },
        },
        {
          name: "getValue",
          description: "Get the value for an input-like selector or @e ref.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(
                session,
                elementScript(input.selector, 'return "value" in element ? element.value : null;'),
              ),
            );
          },
        },
        {
          name: "getAttribute",
          description: "Get an attribute from a selector or @e ref.",
          inputSchema: attributeSchema,
          handler: ({ args }) => {
            const input = decodeAttributeArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(
                session,
                elementScript(
                  input.selector,
                  `return element.getAttribute(${JSON.stringify(input.name)});`,
                ),
              ),
            );
          },
        },
        {
          name: "getTitle",
          description: "Get the current page title.",
          inputSchema: agentSchema,
          handler: ({ args }) => {
            const input = decodeAgentArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(session, "document.title"),
            );
          },
        },
        {
          name: "getUrl",
          description: "Get the current page URL.",
          inputSchema: agentSchema,
          handler: ({ args }) => {
            const input = decodeAgentArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(session, "location.href"),
            );
          },
        },
        {
          name: "count",
          description: "Count elements matching a CSS selector.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(
                session,
                `document.querySelectorAll(${JSON.stringify(input.selector)}).length`,
              ),
            );
          },
        },
        {
          name: "getBox",
          description: "Get the bounding box for a selector or @e ref.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) => getBox(session, input.selector));
          },
        },
        {
          name: "getStyles",
          description: "Get computed styles for a selector or @e ref.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(
                session,
                elementScript(
                  input.selector,
                  `
  const style = getComputedStyle(element);
  return Object.fromEntries([...style].map((name) => [name, style.getPropertyValue(name)]));
`,
                ),
              ),
            );
          },
        },
        {
          name: "isVisible",
          description: "Check whether a selector or @e ref is visible.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(
                session,
                elementScript(
                  input.selector,
                  `
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
`,
                ),
              ),
            );
          },
        },
        {
          name: "isEnabled",
          description: "Check whether a selector or @e ref is enabled.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(
                session,
                elementScript(
                  input.selector,
                  'return !element.disabled && element.getAttribute("aria-disabled") !== "true";',
                ),
              ),
            );
          },
        },
        {
          name: "isChecked",
          description: "Check whether a checkbox or radio selector is checked.",
          inputSchema: selectorSchema,
          handler: ({ args }) => {
            const input = decodeSelectorArgs(args);
            return tool(config, input.agentId, (session) =>
              evaluateInSession(
                session,
                elementScript(
                  input.selector,
                  'return "checked" in element ? element.checked : false;',
                ),
              ),
            );
          },
        },
        {
          name: "find",
          description:
            "Find an element by role, text, label, placeholder, alt, title, or test id, then optionally act on it.",
          inputSchema: findSchema,
          handler: ({ args }) => {
            const input = decodeFindArgs(args);
            return tool(config, input.agentId, async (session) => {
              const selector = await evaluateInSession<string>(
                session,
                `
(() => {
  const locator = ${JSON.stringify(input.locator)};
  const value = ${JSON.stringify(input.value)};
  const roleName = ${JSON.stringify(input.name ?? "")};
  const exact = ${input.exact === true};
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const matches = (text) => exact ? text.trim() === value : text.toLowerCase().includes(value.toLowerCase());
  const accessibleName = (element) =>
    element.getAttribute("aria-label") ||
    element.getAttribute("alt") ||
    element.getAttribute("title") ||
    element.placeholder ||
    element.innerText ||
    element.textContent ||
    element.value ||
    "";
  const roleOf = (element) =>
    element.getAttribute("role") ||
    ({ A: "link", BUTTON: "button", INPUT: element.type || "input", TEXTAREA: "textbox", SELECT: "combobox" })[element.tagName] ||
    element.tagName.toLowerCase();
  const all = [...document.querySelectorAll("*")].filter(visible);
  const found = all.find((element) => {
    if (locator === "role") return roleOf(element) === value && (!roleName || matches(accessibleName(element)));
    if (locator === "text") return matches(element.innerText || element.textContent || "");
    if (locator === "label") {
      const id = element.id;
      const label = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : element.closest("label");
      return label ? matches(label.innerText || label.textContent || "") : false;
    }
    if (locator === "placeholder") return matches(element.placeholder || "");
    if (locator === "alt") return matches(element.getAttribute("alt") || "");
    if (locator === "title") return matches(element.getAttribute("title") || "");
    if (locator === "testid") return element.getAttribute("data-testid") === value;
    return false;
  });
  if (!found) throw new Error("Element not found by " + locator + ": " + value);
  globalThis.__executorBrowserRefs = globalThis.__executorBrowserRefs || {};
  globalThis.__executorBrowserRefs["@found"] = found;
  return "@found";
})()
`,
              );
              if (input.action) {
                return actionByName(session, selector, input.action, input.text);
              }
              return { selector };
            });
          },
        },
      ],
    },
  ],
}));

export type BrowserPlugin = ReturnType<typeof browserPlugin>;

import { Effect } from "effect";
import type { Executor, Source } from "@executor/sdk";

export type ExecuteDescriptionRuntimeKind = "dynamic-worker" | "blaxel-sandbox";

type BuildExecuteDescriptionOptions = {
  readonly runtimeKind?: ExecuteDescriptionRuntimeKind;
};

/**
 * Builds a tool description dynamically.
 *
 * Structure:
 *   1. Required startup step (top — highest priority)
 *   2. Workflow
 *   3. Available namespaces (bottom)
 */
export const buildExecuteDescription = (
  executor: Executor,
  options?: BuildExecuteDescriptionOptions,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const sources: readonly Source[] = yield* executor.sources
      .list()
      .pipe(Effect.orDie, Effect.withSpan("executor.sources.list"));
    const runtimeKind = options?.runtimeKind ?? "blaxel-sandbox";

    const description = yield* Effect.sync(() => formatDescription(sources, runtimeKind)).pipe(
      Effect.withSpan("schema.compile.description", {
        attributes: {
          "executor.source_count": sources.length,
          "executor.runtime_kind": runtimeKind,
        },
      }),
    );

    yield* Effect.annotateCurrentSpan({
      "executor.source_count": sources.length,
      "schema.kind": "execute",
      "executor.runtime_kind": runtimeKind,
    });

    return description;
  }).pipe(Effect.withSpan("schema.describe.execute"));

const formatDescription = (
  sources: readonly Source[],
  runtimeKind: ExecuteDescriptionRuntimeKind,
): string => {
  const lines: string[] = [
    "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
    "",
    "## Workflow",
    "",
    '1. `const matches = await tools.search({ query: "<intent + key nouns>", limit: 12 });`',
    '2. `const path = matches[0]?.path; if (!path) return "No matching tools found.";`',
    "3. `const details = await tools.describe.tool({ path });`",
    "4. Use `details.inputTypeScript` / `details.outputTypeScript` and `details.typeScriptDefinitions` for compact shapes.",
    "5. Use `tools.executor.sources.list()` when you need configured source inventory.",
    "6. Call the tool: `const result = await tools.<path>(input);`",
    "",
    "## Rules",
    "",
  ];

  lines.push(
    "- `tools.search()` returns ranked matches, best-first. Use short intent phrases like `github issues`, `repo details`, or `create calendar event`.",
    '- When you already know the namespace, narrow with `tools.search({ namespace: "github", query: "issues" })`.',
    "- Use `tools.executor.sources.list()` to inspect configured sources and their tool counts. Returns `[{ id, toolCount, ... }]`.",
    "- Always use the namespace prefix when calling tools: `tools.<namespace>.<tool>(args)`. Example: `tools.home_assistant_rest_api.states.getState(...)` — not `tools.states.getState(...)`.",
    "- The `tools` object is a lazy proxy — `Object.keys(tools)` won't work. Use `tools.search()` or `tools.executor.sources.list()` instead.",
    '- Pass an object to system tools, e.g. `tools.search({ query: "..." })`, `tools.executor.sources.list()`, and `tools.describe.tool({ path })`.',
    "- `tools.describe.tool()` returns compact TypeScript shapes. Use `inputTypeScript`, `outputTypeScript`, and `typeScriptDefinitions`.",
    "- For tools that return large collections (e.g. `getStates`, `getAll`), filter results in code rather than calling per-item tools.",
    "- Do not use `fetch` — all API calls go through `tools.*`.",
    "- If execution pauses for interaction, resume it with the returned `resumePayload`.",
  );

  if (runtimeKind === "blaxel-sandbox") {
    lines.push(
      "",
      "## Persistent workspace",
      "",
      "At the start of every conversation you must read both `/workspace/SYSTEM.md` and `/workspace/MEMORY.md`.",
      "",
      "```ts",
      'const systemMd = await Bun.file("/workspace/SYSTEM.md").text();',
      'const memoryMd = await Bun.file("/workspace/MEMORY.md").text();',
      "```",
      "",
      "Do not call `tools.search()`, `tools.describe.tool()`, or any task tool until you have read both files.",
      "- Bun shell `$` is already available in scope, so do not import it.",
      "- `/workspace` persists across executions for this organization. Use it for durable notes or reusable files when helpful.",
    );
  }

  if (sources.length > 0) {
    lines.push("");
    lines.push("## Available namespaces");
    lines.push("");
    const sorted = [...sources].sort((a, b) => a.id.localeCompare(b.id));
    for (const source of sorted) {
      const label = source.name;
      lines.push(`- \`${source.id}\`${label !== source.id ? ` — ${label}` : ""}`);
    }
  }

  return lines.join("\n");
};

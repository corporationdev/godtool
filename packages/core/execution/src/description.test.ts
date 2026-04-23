import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor, definePlugin, makeTestConfig } from "@executor/sdk";

import { buildExecuteDescription } from "./description";

const EmptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

// Two plugins registering static sources whose ids are distinct from their
// pluginIds/names. If `buildExecuteDescription` ever renders the wrong field
// (e.g. pluginId, an internal UUID, or the source name), these assertions
// fail — which is the class of bug a hand-rolled fake `Executor` would miss.
const githubPlugin = definePlugin(() => ({
  id: "github-plugin" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "github",
      kind: "in-memory",
      name: "GitHub",
      tools: [
        {
          name: "noop",
          description: "noop",
          inputSchema: EmptyInputSchema,
          handler: () => Effect.succeed(null),
        },
      ],
    },
  ],
}));

const slackPlugin = definePlugin(() => ({
  id: "slack-plugin" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "slack",
      kind: "in-memory",
      name: "Slack Workspace",
      tools: [
        {
          name: "noop",
          description: "noop",
          inputSchema: EmptyInputSchema,
          handler: () => Effect.succeed(null),
        },
      ],
    },
  ],
}));

describe("buildExecuteDescription", () => {
  it.effect(
    "renders the required startup block before the workflow and lists namespaces",
    () =>
      Effect.gen(function* () {
        // Intentionally register in non-alphabetical order — the formatter
        // is expected to sort by source id.
        const executor = yield* createExecutor(
          makeTestConfig({ plugins: [slackPlugin(), githubPlugin()] as const }),
        );

        const description = yield* buildExecuteDescription(executor);

        // Stable anchor from the workflow preamble.
        expect(description).toContain("## REQUIRED FIRST STEP");
        expect(description).toContain(
          "Before any task-specific work, your first execution must read both `/workspace/SYSTEM.md` and `/workspace/MEMORY.md`.",
        );
        expect(description).toContain(
          'const systemMd = await Bun.file("/workspace/SYSTEM.md").text();',
        );
        expect(description).toContain(
          'const memoryMd = await Bun.file("/workspace/MEMORY.md").text();',
        );
        expect(description).toContain(
          "Do not call `tools.search()`, `tools.describe.tool()`, or any task tool until you have read both files.",
        );
        expect(description).toContain(
          "Execute TypeScript in a sandboxed runtime",
        );
        expect(description).toContain(
          "## Workflow",
        );
        expect(description).toContain(
          '1. `const systemMd = await Bun.file("/workspace/SYSTEM.md").text(); const memoryMd = await Bun.file("/workspace/MEMORY.md").text();`',
        );
        expect(description).toContain(
          "Bun shell `$` is already available in scope, so do not import it.",
        );
        const requiredIdx = description.indexOf("## REQUIRED FIRST STEP");
        const workflowIdx = description.indexOf("## Workflow");
        expect(requiredIdx).toBeGreaterThan(-1);
        expect(workflowIdx).toBeGreaterThan(-1);
        expect(requiredIdx).toBeLessThan(workflowIdx);
        // The namespaces section header.
        expect(description).toContain("## Available namespaces");
        // Each source renders with its ACTUAL id (not pluginId / name / UUID).
        expect(description).toContain("`github` — GitHub");
        expect(description).toContain("`slack` — Slack Workspace");
        // And the plugin ids must NOT leak into the namespace list.
        expect(description).not.toContain("`github-plugin`");
        expect(description).not.toContain("`slack-plugin`");

        // Sort order: `github` before `slack`.
        const githubIdx = description.indexOf("`github`");
        const slackIdx = description.indexOf("`slack`");
        expect(githubIdx).toBeGreaterThan(-1);
        expect(slackIdx).toBeGreaterThan(-1);
        expect(githubIdx).toBeLessThan(slackIdx);
      }),
  );

  it.effect(
    "omits the Available namespaces section when no plugins register sources",
    () =>
      Effect.gen(function* () {
        const executor = yield* createExecutor(
          makeTestConfig({ plugins: [] as const }),
        );

        const description = yield* buildExecuteDescription(executor);

        expect(description).toContain(
          "## REQUIRED FIRST STEP",
        );
        expect(description).toContain(
          "Before any task-specific work, your first execution must read both `/workspace/SYSTEM.md` and `/workspace/MEMORY.md`.",
        );
        expect(description).not.toContain("## Available namespaces");
      }),
  );
});

import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import {
  ScopeId,
  SecretId,
  SetSecretInput,
  createExecutor,
  definePlugin,
  makeTestConfig,
  type InvokeOptions,
  type SecretProvider,
} from "@executor/sdk";

import { rawPlugin } from "./plugin";
import { buildRequestUrl } from "./invoke";
import { rawPresets } from "./presets";

const TEST_SCOPE = "test-scope";
const autoApprove: InvokeOptions = { onElicitation: "accept-all" };

const toRequest = (input: RequestInfo | URL, init?: RequestInit): Request =>
  input instanceof Request ? input : new Request(input, init);

const memoryProvider: SecretProvider = (() => {
  const store = new Map<string, string>();
  return {
    key: "memory",
    writable: true,
    get: (id, scope) => Effect.sync(() => store.get(`${scope}\u0000${id}`) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(`${scope}\u0000${id}`, value);
      }),
    delete: (id, scope) => Effect.sync(() => store.delete(`${scope}\u0000${id}`)),
  };
})();

const memorySecretsPlugin = definePlugin(() => ({
  id: "memory-secrets" as const,
  storage: () => ({}),
  secretProviders: [memoryProvider],
}));

const makeExecutor = () =>
  createExecutor(
    makeTestConfig({
      plugins: [rawPlugin(), memorySecretsPlugin()] as const,
    }),
  );

describe("rawPlugin", () => {
  it.effect("registers one fetch tool per source plus the static control tool", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      const result = yield* executor.raw.addSource({
        baseUrl: "https://api.example.com/v1",
        scope: TEST_SCOPE,
        namespace: "example_api",
      });

      expect(result).toEqual({ sourceId: "example_api", toolCount: 1 });

      const tools = yield* executor.tools.list();
      expect(tools.map((tool) => tool.id)).toContain("example_api.fetch");
      expect(tools.map((tool) => tool.id)).toContain("raw.addSource");
    }),
  );

  it.effect("static raw.addSource delegates to the extension", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      const result = yield* executor.tools.invoke(
        "raw.addSource",
        {
          baseUrl: "https://api.example.com/v1",
          namespace: "via_static",
        },
        autoApprove,
      );

      expect(result).toEqual({ sourceId: "via_static", toolCount: 1 });

      const source = yield* executor.raw.getSource("via_static", TEST_SCOPE);
      expect(source?.baseUrl).toBe("https://api.example.com/v1");
    }),
  );

  it.effect("resolves configured headers and performs scoped fetches", () =>
    Effect.gen(function* () {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const request = toRequest(input, init);
        expect(request.url).toBe("https://api.example.com/v1/users");
        expect(request.headers.get("authorization")).toBe("Bearer secret-value-123");
        expect(request.headers.get("x-static")).toBe("override");
        return new Response(
          JSON.stringify({
            authorization: request.headers.get("authorization"),
            xStatic: request.headers.get("x-static"),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      });

      try {
        const executor = yield* makeExecutor();

        yield* executor.secrets.set(
          new SetSecretInput({
            id: SecretId.make("api-token"),
            scope: ScopeId.make(TEST_SCOPE),
            name: "API Token",
            value: "secret-value-123",
          }),
        );

        yield* executor.raw.addSource({
          baseUrl: "https://api.example.com/v1",
          scope: TEST_SCOPE,
          namespace: "authed",
          headers: {
            Authorization: { secretId: "api-token", prefix: "Bearer " },
            "X-Static": "hello",
          },
        });

        const result = yield* executor.tools.invoke(
          "authed.fetch",
          {
            path: "users",
            headers: {
              "X-Static": "override",
            },
          },
          autoApprove,
        );

        expect(result).toEqual({
          ok: true,
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            authorization: "Bearer secret-value-123",
            xStatic: "override",
          },
        });
      } finally {
        fetchSpy.mockRestore();
      }
    }),
  );

  it("keeps request paths inside the configured base URL", () => {
    expect(
      buildRequestUrl("https://api.example.com/v1", "users", {
        limit: 10,
      }).toString(),
    ).toBe("https://api.example.com/v1/users?limit=10");

    expect(() => buildRequestUrl("https://api.example.com/v1", "https://evil.test", {})).toThrow(
      /relative/,
    );
    expect(() => buildRequestUrl("https://api.example.com/v1", "../admin", {})).toThrow(/escapes/);
  });

  it("ships managed-auth ready raw HTTP presets", () => {
    expect(rawPresets.map((preset) => preset.id)).toEqual([
      "slack",
      "notion",
      "twitter",
      "supabase",
      "airtable",
      "hubspot",
      "gong",
      "salesforce",
      "canvas",
      "zendesk",
      "discord",
    ]);
    expect(rawPresets.find((preset) => preset.id === "slack")).toMatchObject({
      baseUrl: "https://slack.com/api",
    });
    expect(rawPresets.find((preset) => preset.id === "notion")).toMatchObject({
      baseUrl: "https://api.notion.com",
      defaultHeaders: {
        "Notion-Version": "2022-06-28",
      },
    });
    expect(rawPresets.find((preset) => preset.id === "hubspot")).toMatchObject({
      baseUrl: "https://api.hubapi.com",
      composio: { app: "hubspot" },
    });
  });
});

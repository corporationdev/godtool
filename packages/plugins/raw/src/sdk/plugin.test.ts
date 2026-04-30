import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import {
  ConnectionId,
  CreateConnectionInput,
  ScopeId,
  SecretId,
  SetSecretInput,
  TokenMaterial,
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
    get: (id, scope) =>
      Effect.sync(() => store.get(`${scope}\u0000${id}`) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(`${scope}\u0000${id}`, value);
      }),
    delete: (id, scope) =>
      Effect.sync(() => store.delete(`${scope}\u0000${id}`)),
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
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const request = toRequest(input, init);
          expect(request.url).toBe("https://api.example.com/v1/users");
          expect(request.headers.get("authorization")).toBe(
            "Bearer secret-value-123",
          );
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

  it.effect("invokes managed auth sources through a cloud broker token when imported locally", () =>
    Effect.gen(function* () {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const request = toRequest(input, init);
        expect(request.url).toBe("https://cloud.test/api/composio-proxy/raw");
        expect(request.headers.get("authorization")).toBe("Bearer broker-token");
        const body = await request.json();
        expect(body).toMatchObject({
          endpoint: "https://slack.com/api/users.list",
          method: "GET",
          parameters: [{ name: "X-Test", value: "yes", type: "header" }],
        });
        return new Response(
          JSON.stringify({
            status: 200,
            headers: { "content-type": "application/json" },
            data: { ok: true },
            error: null,
            binaryData: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      try {
        const executor = yield* makeExecutor();
        yield* executor.connections.create(
          new CreateConnectionInput({
            id: ConnectionId.make("raw-composio-slack"),
            scope: ScopeId.make(TEST_SCOPE),
            provider: "raw-composio",
            identityLabel: "Slack",
            accessToken: new TokenMaterial({
              secretId: SecretId.make("raw-composio-slack.managed"),
              name: "Slack Managed Auth",
              value: "broker-token",
            }),
            refreshToken: null,
            expiresAt: null,
            oauthScope: null,
            providerState: {
              brokerUrl: "https://cloud.test/api/composio-proxy/raw",
              connectedAccountId: "ca_123",
              app: "slack",
              authConfigId: "ac_123",
            },
          }),
        );
        yield* executor.raw.addSource({
          baseUrl: "https://slack.com/api",
          scope: TEST_SCOPE,
          namespace: "slack",
          headers: { "X-Test": "yes" },
          composio: {
            kind: "composio",
            app: "slack",
            authConfigId: "ac_123",
            connectionId: "raw-composio-slack",
          },
          auth: {
            kind: "composio",
            app: "slack",
            authConfigId: "ac_123",
            connectionId: "raw-composio-slack",
          },
        });

        const result = yield* executor.tools.invoke(
          "slack.fetch",
          { path: "users.list" },
          autoApprove,
        );

        expect(result).toEqual({
          ok: true,
          status: 200,
          headers: { "content-type": "application/json" },
          body: { ok: true },
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

    expect(() =>
      buildRequestUrl("https://api.example.com/v1", "https://evil.test", {}),
    ).toThrow(/relative/);
    expect(() =>
      buildRequestUrl("https://api.example.com/v1", "../admin", {}),
    ).toThrow(/escapes/);
  });

  it("ships the popular managed-auth raw HTTP presets", () => {
    expect(rawPresets.map((preset) => preset.id)).toEqual([
      "gmail",
      "googlesheets",
      "googledrive",
      "googlecalendar",
      "slack",
      "notion",
      "github",
      "linear",
    ]);
    for (const preset of rawPresets) {
      expect(preset.composio?.app).toBeTruthy();
    }
    expect(rawPresets.find((preset) => preset.id === "slack")).toMatchObject({
      baseUrl: "https://slack.com/api",
      composio: { app: "slack" },
    });
    expect(rawPresets.find((preset) => preset.id === "notion")).toMatchObject({
      baseUrl: "https://api.notion.com",
      defaultHeaders: {
        "Notion-Version": "2022-06-28",
      },
      composio: { app: "notion" },
    });
  });
});

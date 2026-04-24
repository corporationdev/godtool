import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import {
  ConnectionId,
  CreateConnectionInput,
  ElicitationResponse,
  createExecutor,
  definePlugin,
  makeTestConfig,
  ScopeId,
  SecretId,
  SetSecretInput,
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
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((key) => {
          const name = key.split("\u0000", 2)[1] ?? key;
          return { id: name, name };
        }),
      ),
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
      plugins: [rawPlugin({ composioApiKey: "composio-test-key" }), memorySecretsPlugin()] as const,
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

  it.effect("resolves secret-backed headers and lets per-call headers override source headers", () =>
    Effect.gen(function* () {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
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

  it.effect("serializes JSON bodies and parses non-2xx JSON responses without throwing", () =>
    Effect.gen(function* () {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const request = toRequest(input, init);
          expect(request.method).toBe("POST");
          expect(request.headers.get("content-type")).toBe("application/json");
          expect(await request.text()).toBe(JSON.stringify({ name: "Ada" }));
          return new Response(
            JSON.stringify({ error: "bad request" }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          );
        });

      try {
        const executor = yield* makeExecutor();
        yield* executor.raw.addSource({
          baseUrl: "https://api.example.com/v1",
          scope: TEST_SCOPE,
          namespace: "posts",
        });

        const result = yield* executor.tools.invoke(
          "posts.fetch",
          {
            path: "users",
            method: "POST",
            body: { name: "Ada" },
          },
          autoApprove,
        );

        expect(result).toEqual({
          ok: false,
          status: 400,
          headers: { "content-type": "application/json" },
          body: { error: "bad request" },
        });
      } finally {
        fetchSpy.mockRestore();
      }
    }),
  );

  it.effect("rejects paths that escape the configured base URL", () =>
    Effect.gen(function* () {
      expect(() =>
        buildRequestUrl("https://api.example.com/v1", "../oauth/token", undefined),
      ).toThrow(/escapes the configured base URL/);
    }),
  );

  it.effect("routes composio-backed sources through the proxy", () =>
    Effect.gen(function* () {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const request = toRequest(input, init);
          expect(request.url).toBe("https://backend.composio.dev/api/v3/tools/execute/proxy");

          const body = JSON.parse(await request.text()) as {
            endpoint: string;
            method: string;
            parameters: Array<{ name: string; value: string; type: string }>;
          };
          expect(body.endpoint).toBe("https://slack.com/api/conversations.list");
          expect(body.method).toBe("GET");
          expect(body.parameters).toEqual([]);

          return new Response(
            JSON.stringify({
              status: 200,
              headers: { "content-type": "application/json" },
              data: { ok: true, source: "composio" },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        });

      try {
        const executor = yield* makeExecutor();

        yield* executor.connections.create(
          new CreateConnectionInput({
            id: ConnectionId.make("raw-composio-example"),
            scope: ScopeId.make(TEST_SCOPE),
            provider: "raw-composio",
            kind: "user",
            identityLabel: "Slack",
            accessToken: null,
            refreshToken: null,
            expiresAt: null,
            oauthScope: null,
            providerState: {
              connectedAccountId: "ca_slack_123",
              app: "slack",
              authConfigId: null,
            },
          }),
        );

        const composioAuth = {
          kind: "composio" as const,
          app: "slack",
          authConfigId: null,
          connectionId: "raw-composio-example",
        };

        yield* executor.raw.addSource({
          baseUrl: "https://slack.com/api",
          scope: TEST_SCOPE,
          namespace: "slack",
          composio: composioAuth,
          auth: composioAuth,
        });

        const result = yield* executor.tools.invoke(
          "slack.fetch",
          { path: "conversations.list" },
          autoApprove,
        );

        expect(result).toEqual({
          ok: true,
          status: 200,
          headers: { "content-type": "application/json" },
          body: { ok: true, source: "composio" },
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    }),
  );

  it("ships the Notion preset with the API root URL and required version header", () => {
    const notion = rawPresets.find((preset) => preset.id === "notion");

    expect(notion).toMatchObject({
      id: "notion",
      baseUrl: "https://api.notion.com",
      defaultHeaders: {
        "Notion-Version": "2022-06-28",
      },
    });
  });

  it.effect("only elicits approval for mutating methods", () =>
    Effect.gen(function* () {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () =>
          new Response("ok", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        );

      try {
        const executor = yield* makeExecutor();
        yield* executor.raw.addSource({
          baseUrl: "https://api.example.com/v1",
          scope: TEST_SCOPE,
          namespace: "approval",
        });

        let getElicitations = 0;
        yield* executor.tools.invoke(
          "approval.fetch",
          { path: "users", method: "GET" },
          {
            onElicitation: () => {
              getElicitations += 1;
              return Effect.succeed(new ElicitationResponse({ action: "accept" }));
            },
          },
        );
        expect(getElicitations).toBe(0);

        let postElicitations = 0;
        yield* executor.tools.invoke(
          "approval.fetch",
          { path: "users", method: "POST", body: { ok: true } },
          {
            onElicitation: (ctx) => {
              postElicitations += 1;
              expect(ctx.request._tag).toBe("FormElicitation");
              return Effect.succeed(new ElicitationResponse({ action: "accept" }));
            },
          },
        );
        expect(postElicitations).toBe(1);
      } finally {
        fetchSpy.mockRestore();
      }
    }),
  );

  it.effect("aborts mutating requests when approval is declined", () =>
    Effect.gen(function* () {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );

      try {
        const executor = yield* makeExecutor();
        yield* executor.raw.addSource({
          baseUrl: "https://api.example.com/v1",
          scope: TEST_SCOPE,
          namespace: "decline",
        });

        const error = yield* executor.tools
          .invoke(
            "decline.fetch",
            { path: "users", method: "DELETE" },
            {
              onElicitation: () =>
                Effect.succeed(new ElicitationResponse({ action: "decline" })),
            },
          )
          .pipe(Effect.flip);

        expect((error as { _tag: string })._tag).toBe("ToolInvocationError");
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    }),
  );
});

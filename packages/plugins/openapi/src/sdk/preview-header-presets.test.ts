import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "@effect/platform";

import { previewSpec as previewSpecRaw } from "./preview";

const previewSpec = (input: string) =>
  previewSpecRaw(input).pipe(Effect.provide(FetchHttpClient.layer));

const minimalSpec = (securitySchemes: Record<string, unknown>) => ({
  openapi: "3.0.0",
  info: { title: "Test API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/ping": {
      get: { responses: { "200": { description: "ok" } } },
    },
  },
  components: { securitySchemes },
});

describe("previewSpec header preset labels", () => {
  it.effect("disambiguates duplicate bearer labels using security scheme names", () =>
    Effect.gen(function* () {
      const spec = minimalSpec({
        pat: { type: "http", scheme: "bearer" },
        team_token: { type: "http", scheme: "bearer" },
        oauth_project_token: { type: "http", scheme: "bearer" },
      });

      const preview = yield* previewSpec(JSON.stringify(spec));
      const labels = preview.headerPresets.map((preset) => preset.label);

      expect(labels).toEqual([
        "Bearer Token · pat",
        "Bearer Token · team_token",
        "Bearer Token · oauth_project_token",
      ]);
    }),
  );

  it.effect("keeps friendly labels unchanged when they are unique", () =>
    Effect.gen(function* () {
      const spec = minimalSpec({
        basic_auth: { type: "http", scheme: "basic" },
        api_key: { type: "apiKey", in: "header", name: "X-API-Key" },
      });

      const preview = yield* previewSpec(JSON.stringify(spec));
      const labels = preview.headerPresets.map((preset) => preset.label);

      expect(labels).toEqual(["Basic Auth", "api_key"]);
    }),
  );
});

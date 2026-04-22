// Source endpoints — CRUD through HttpApiClient. Complements tenant
// isolation tests by exercising add → get → update → remove flows and
// the error paths (remove non-existent, remove static, etc.) within a
// single org.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import { ScopeId } from "@executor/sdk";

import { asOrg } from "./__test-harness__/api-harness";

const MINIMAL_OPENAPI_SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Sources API Test", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "ping",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

// The Cloudflare OpenAPI spec is the biggest real spec we care about:
// 16MB, 2700+ operations, thousands of shared schemas. Exercising
// addSpec end-to-end on it through the real postgres adapter is the
// load-bearing check that any adapter regression (per-row `createMany`,
// accidental N+1 reads, transaction snapshots that copy too much) will
// show up as a test failure instead of a prod incident.
const CLOUDFLARE_SPEC_PATH = resolve(
  __dirname,
  "../../../../packages/plugins/openapi/fixtures/cloudflare.json",
);
const CLOUDFLARE_SPEC = readFileSync(CLOUDFLARE_SPEC_PATH, "utf-8");

const GOOGLE_DISCOVERY_FIXTURE_PATH = resolve(
  __dirname,
  "../../../../packages/plugins/google-discovery/fixtures/drive.json",
);
const GOOGLE_DISCOVERY_FIXTURE = readFileSync(GOOGLE_DISCOVERY_FIXTURE_PATH, "utf-8");

interface DiscoveryServerHandle {
  readonly discoveryUrl: string;
  readonly close: () => Promise<void>;
}

const startGoogleDiscoveryServer = (): Promise<DiscoveryServerHandle> =>
  new Promise((resolvePromise, rejectPromise) => {
    const server: Server = createServer((_request, response) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        response.statusCode = 500;
        response.end();
        return;
      }

      const fixture = JSON.stringify({
        ...JSON.parse(GOOGLE_DISCOVERY_FIXTURE),
        rootUrl: `http://127.0.0.1:${address.port}/`,
      });
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(fixture);
    });

    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPromise(new Error("Failed to resolve discovery server address"));
        return;
      }
      resolvePromise({
        discoveryUrl: `http://127.0.0.1:${address.port}/$discovery/rest?version=v3`,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });

describe("sources api (HTTP)", () => {
  it.effect("addSpec → sources.list includes the new namespace", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          const result = yield* client.openapi.addSpec({
            path: { scopeId: ScopeId.make(org) },
            payload: { spec: MINIMAL_OPENAPI_SPEC, namespace },
          });
          expect(result.namespace).toBe(namespace);
          expect(result.toolCount).toBeGreaterThan(0);
        }),
      );

      const sources = yield* asOrg(org, (client) =>
        client.sources.list({ path: { scopeId: ScopeId.make(org) } }),
      );
      expect(sources.map((s) => s.id)).toContain(namespace);
    }),
  );

  it.effect("openapi.getSource returns the stored source after addSpec", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        client.openapi.addSpec({
          path: { scopeId: ScopeId.make(org) },
          payload: { spec: MINIMAL_OPENAPI_SPEC, namespace },
        }),
      );

      const fetched = yield* asOrg(org, (client) =>
        client.openapi.getSource({ path: { scopeId: ScopeId.make(org), namespace } }),
      );
      expect(fetched).not.toBeNull();
      expect(fetched?.namespace).toBe(namespace);
    }),
  );

  it.effect("sources.remove deletes the source and it drops off sources.list", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            path: { scopeId: ScopeId.make(org) },
            payload: { spec: MINIMAL_OPENAPI_SPEC, namespace },
          });
          yield* client.sources.remove({
            path: { scopeId: ScopeId.make(org), sourceId: namespace },
          });
        }),
      );

      const after = yield* asOrg(org, (client) =>
        client.sources.list({ path: { scopeId: ScopeId.make(org) } }),
      );
      expect(after.map((s) => s.id)).not.toContain(namespace);
    }),
  );

  it.effect("sources.remove on a non-existent sourceId is a no-op (idempotent)", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const ghost = `missing_${crypto.randomUUID().slice(0, 8)}`;

      const result = yield* asOrg(org, (client) =>
        client.sources
          .remove({ path: { scopeId: ScopeId.make(org), sourceId: ghost } })
          .pipe(Effect.either),
      );
      expect(result._tag).toBe("Right");
    }),
  );

  it.effect("sources.remove on a static source is rejected", () =>
    Effect.gen(function* () {
      // `canRemove: false` is reserved for static (plugin-declared)
      // sources. The openapi plugin declares one with id "openapi"
      // for its control tools.
      const org = `org_${crypto.randomUUID()}`;

      const result = yield* asOrg(org, (client) =>
        client.sources
          .remove({ path: { scopeId: ScopeId.make(org), sourceId: "openapi" } })
          .pipe(Effect.either),
      );
      expect(result._tag).toBe("Left");
    }),
  );

  it.effect("openapi.updateSource round-trips baseUrl + name changes", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            path: { scopeId: ScopeId.make(org) },
            payload: { spec: MINIMAL_OPENAPI_SPEC, namespace },
          });
          yield* client.openapi.updateSource({
            path: { scopeId: ScopeId.make(org), namespace },
            payload: { name: "Renamed API", baseUrl: "https://override.example.com" },
          });
        }),
      );

      const fetched = yield* asOrg(org, (client) =>
        client.openapi.getSource({ path: { scopeId: ScopeId.make(org), namespace } }),
      );
      expect(fetched?.name).toBe("Renamed API");
      expect(fetched?.config.baseUrl).toBe("https://override.example.com");
    }),
  );

  it.effect("googleDiscovery.addSource stores the source and exposes it via getSource", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `google_${crypto.randomUUID().replace(/-/g, "_")}`;
      const server = yield* Effect.promise(() => startGoogleDiscoveryServer());

      try {
        const result = yield* asOrg(org, (client) =>
          client.googleDiscovery.addSource({
            path: { scopeId: ScopeId.make(org) },
            payload: {
              name: "Google Drive",
              discoveryUrl: server.discoveryUrl,
              namespace,
              auth: { kind: "none" },
            },
          }),
        );
        expect(result.namespace).toBe(namespace);
        expect(result.toolCount).toBeGreaterThan(0);

        const fetched = yield* asOrg(org, (client) =>
          client.googleDiscovery.getSource({
            path: { scopeId: ScopeId.make(org), namespace },
          }),
        );
        expect(fetched).not.toBeNull();
        expect(fetched?.namespace).toBe(namespace);
        expect(fetched?.config.service).toBe("drive");
      } finally {
        yield* Effect.promise(() => server.close());
      }
    }),
  );

  it.effect(
    "addSpec persists the full Cloudflare spec through the real adapter",
    () =>
      Effect.gen(function* () {
        const org = `org_${crypto.randomUUID()}`;
        const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

        const result = yield* asOrg(org, (client) =>
          client.openapi.addSpec({
            path: { scopeId: ScopeId.make(org) },
            payload: { spec: CLOUDFLARE_SPEC, namespace },
          }),
        );
        expect(result.namespace).toBe(namespace);
        expect(result.toolCount).toBeGreaterThan(1000);

        const sources = yield* asOrg(org, (client) =>
          client.sources.list({ path: { scopeId: ScopeId.make(org) } }),
        );
        expect(sources.map((s) => s.id)).toContain(namespace);

        // removeSpec on the same size must also land cleanly — catches
        // symmetrical regressions on the delete side (e.g. deleteMany
        // fanning out to per-row deletes).
        yield* asOrg(org, (client) =>
          client.sources.remove({
            path: { scopeId: ScopeId.make(org), sourceId: namespace },
          }),
        );
        const after = yield* asOrg(org, (client) =>
          client.sources.list({ path: { scopeId: ScopeId.make(org) } }),
        );
        expect(after.map((s) => s.id)).not.toContain(namespace);
      }),
    // 60s is generous for a correct O(1) write path on local PGlite;
    // a per-row regression would take minutes and hit this ceiling
    // long before the suite would tolerate it.
    { timeout: 60_000 },
  );
});

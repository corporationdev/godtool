import { describe, expect, it } from "vitest";

import { graphqlPresets } from "../packages/plugins/graphql/src/sdk/presets";
import { googleDiscoveryPresets } from "../packages/plugins/google-discovery/src/sdk/presets";
import { openApiPresets } from "../packages/plugins/openapi/src/sdk/presets";

const openApiManagedAuthIds = openApiPresets
  .filter((preset) => preset.composio)
  .map((preset) => preset.id)
  .sort();

const graphqlManagedAuthIds = graphqlPresets
  .filter((preset) => preset.composio)
  .map((preset) => preset.id)
  .sort();

const googleDiscoveryManagedAuthIds = googleDiscoveryPresets
  .filter((preset) => preset.composio)
  .map((preset) => preset.id)
  .sort();

describe("preset managed auth coverage", () => {
  it("matches the supported OpenAPI presets", () => {
    expect(openApiManagedAuthIds).toEqual([
      "asana",
      "convex",
      "digitalocean",
      "github-rest",
      "sentry",
      "stripe",
      "supabase",
    ]);
  });

  it("matches the supported GraphQL presets", () => {
    expect(graphqlManagedAuthIds).toEqual([
      "github-graphql",
      "gitlab",
      "linear",
      "monday",
    ]);
  });

  it("matches the supported Google Discovery presets", () => {
    expect(googleDiscoveryManagedAuthIds).toEqual([
      "google-bigquery",
      "google-calendar",
      "google-classroom",
      "google-docs",
      "google-drive",
      "google-gmail",
      "google-search-console",
      "google-sheets",
      "google-slides",
      "google-tasks",
      "google-youtube-data",
    ]);
  });
});

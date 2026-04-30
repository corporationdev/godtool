import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SourcesAddPage } from "@executor/react/pages/sources-add";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { mcpSourcePlugin } from "@executor/plugin-mcp/react";
import { googleDiscoverySourcePlugin } from "@executor/plugin-google-discovery/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";
import { rawSourcePlugin } from "@executor/plugin-raw/react";

const sourcePlugins = [
  openApiSourcePlugin,
  mcpSourcePlugin,
  rawSourcePlugin,
  googleDiscoverySourcePlugin,
  graphqlSourcePlugin,
];

const SearchParams = Schema.standardSchemaV1(
  Schema.Struct({
    url: Schema.optional(Schema.String),
    preset: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
  }),
);

export const Route = createFileRoute("/sources/add/$pluginKey")({
  validateSearch: SearchParams,
  component: () => {
    const { pluginKey } = Route.useParams();
    const { url, preset, namespace } = Route.useSearch();
    const localDeviceAvailable = useLocalDeviceAvailable();
    return (
      <SourcesAddPage
        pluginKey={pluginKey}
        url={url}
        preset={preset}
        namespace={namespace}
        sourcePlugins={sourcePlugins}
        nativePlacement="cloud"
        signedIn
        localDeviceAvailable={localDeviceAvailable}
        syncToLocal={(sourceId) => sourceSync("to-local", { sourceIds: [sourceId] })}
        syncToCloud={(sourceId) => sourceSync("to-cloud", { sourceIds: [sourceId] })}
      />
    );
  },
});

const sourceSync = async (route: "to-cloud" | "to-local", payload: unknown) => {
  const response = await fetch(`/api/source-sync/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Source sync failed with status ${response.status}`);
  }
};

function useLocalDeviceAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch("/api/devices/status", {
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error("device status failed");
        const data = (await response.json()) as {
          readonly devices?: readonly { readonly online?: boolean }[];
        };
        if (alive) setAvailable((data.devices ?? []).some((device) => device.online === true));
      } catch {
        if (alive) setAvailable(false);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, []);
  return available;
}

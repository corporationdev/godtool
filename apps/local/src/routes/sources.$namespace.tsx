import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SourceDetailPage } from "@executor/react/pages/source-detail";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { createMcpSourcePlugin } from "@executor/plugin-mcp/react";

const mcpSourcePlugin = createMcpSourcePlugin({ allowStdio: true });
import { googleDiscoverySourcePlugin } from "@executor/plugin-google-discovery/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";
import { rawSourcePlugin } from "@executor/plugin-raw/react";
import { computerUseSourcePlugin } from "@executor/plugin-computer-use/react";
import { useLocalAuth } from "../web/auth";

const sourcePlugins = [
  computerUseSourcePlugin,
  openApiSourcePlugin,
  mcpSourcePlugin,
  rawSourcePlugin,
  googleDiscoverySourcePlugin,
  graphqlSourcePlugin,
];

export const Route = createFileRoute("/sources/$namespace")({
  component: () => {
    const { namespace } = Route.useParams();
    const { auth, deleteSources, listCloudSources, syncSourcesToCloud, syncSourcesToLocal } =
      useLocalAuth();
    const cloudExists = useCloudSourceExists(
      auth.status === "authenticated" ? namespace : null,
      listCloudSources,
    );
    return (
      <SourceDetailPage
        namespace={namespace}
        sourcePlugins={sourcePlugins}
        availability={cloudExists ? "both" : "local"}
        localDeviceAvailable
        onSyncToCloud={
          auth.status === "authenticated" ? (sourceId) => syncSourcesToCloud([sourceId]) : undefined
        }
        onSyncToLocal={
          auth.status === "authenticated" ? (sourceId) => syncSourcesToLocal([sourceId]) : undefined
        }
        onDeleteSource={
          auth.status === "authenticated"
            ? (sourceId) => deleteSources([sourceId], ["local", "cloud"])
            : undefined
        }
      />
    );
  },
});

function useCloudSourceExists(
  sourceId: string | null,
  listCloudSources: ReturnType<typeof useLocalAuth>["listCloudSources"],
) {
  const [exists, setExists] = useState(false);
  useEffect(() => {
    if (!sourceId) {
      setExists(false);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const sources = await listCloudSources();
        if (alive) setExists(sources.some((source) => source.id === sourceId));
      } catch {
        if (alive) setExists(false);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [sourceId, listCloudSources]);
  return exists;
}

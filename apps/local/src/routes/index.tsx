import { createFileRoute } from "@tanstack/react-router";
import { SourcesPage } from "@executor/react/pages/sources";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { createMcpSourcePlugin } from "@executor/plugin-mcp/react";
import { useEffect, useMemo, useState } from "react";
import { useLocalAuth, type CloudSource } from "../web/auth";

const mcpSourcePlugin = createMcpSourcePlugin({ allowStdio: true });
import { googleDiscoverySourcePlugin } from "@executor/plugin-google-discovery/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";
import { rawSourcePlugin } from "@executor/plugin-raw/react";
import { computerUseSourcePlugin } from "@executor/plugin-computer-use/react";

const sourcePlugins = [
  computerUseSourcePlugin,
  openApiSourcePlugin,
  mcpSourcePlugin,
  rawSourcePlugin,
  googleDiscoverySourcePlugin,
  graphqlSourcePlugin,
];

export const Route = createFileRoute("/")({
  component: SourcesRoute,
});

function SourcesRoute() {
  const { auth, listCloudSources } = useLocalAuth();
  const [cloudSources, setCloudSources] = useState<readonly CloudSource[]>([]);
  const organizationId = auth.status === "authenticated" ? (auth.organization?.id ?? "") : "";

  useEffect(() => {
    if (auth.status !== "authenticated") {
      setCloudSources([]);
      return;
    }

    let alive = true;
    const load = async () => {
      try {
        const sources = await listCloudSources();
        if (alive) setCloudSources(sources);
      } catch {
        if (alive) setCloudSources([]);
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [auth.status, organizationId, listCloudSources]);

  const overlaySources = useMemo(
    () => cloudSources.map((source) => ({ ...source, availability: "cloud" as const })),
    [cloudSources],
  );

  return (
    <SourcesPage
      sourcePlugins={sourcePlugins}
      baseSourceAvailability="local"
      overlaySources={overlaySources}
      linkableSourceAvailabilities={["local", "both"]}
    />
  );
}

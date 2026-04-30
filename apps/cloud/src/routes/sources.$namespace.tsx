import { createFileRoute } from "@tanstack/react-router";
import { SourceDetailPage } from "@executor/react/pages/source-detail";
import { useEffect, useState } from "react";
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

export const Route = createFileRoute("/sources/$namespace")({
  component: () => {
    const { namespace } = Route.useParams();
    const localPlacement = useKnownLocalPlacement(namespace);
    return (
      <SourceDetailPage
        namespace={namespace}
        sourcePlugins={sourcePlugins}
        deleteDisabledReason={
          localPlacement.exists && !localPlacement.online
            ? "Connect the Mac to delete the local copy."
            : null
        }
        onDeleteSource={(sourceId) =>
          sourceSync("delete", {
            sourceIds: [sourceId],
            placements: localPlacement.exists ? ["cloud", "local"] : ["cloud"],
          })
        }
      />
    );
  },
});

const sourceSync = async (route: "delete", payload: unknown) => {
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

function useKnownLocalPlacement(sourceId: string) {
  const [state, setState] = useState({ exists: false, online: false });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch("/api/devices/catalog", {
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error("catalog failed");
        const data = (await response.json()) as {
          readonly sources?: readonly {
            readonly id?: string;
            readonly localAvailable?: boolean;
          }[];
        };
        const source = (data.sources ?? []).find((candidate) => candidate.id === sourceId);
        if (alive) setState({ exists: Boolean(source), online: source?.localAvailable === true });
      } catch {
        if (alive) setState({ exists: false, online: false });
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [sourceId]);
  return state;
}

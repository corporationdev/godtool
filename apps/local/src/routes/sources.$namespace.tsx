import { createFileRoute } from "@tanstack/react-router";
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
    const { auth, deleteSources } = useLocalAuth();
    return (
      <SourceDetailPage
        namespace={namespace}
        sourcePlugins={sourcePlugins}
        onDeleteSource={
          auth.status === "authenticated"
            ? (sourceId) => deleteSources([sourceId], ["local", "cloud"])
            : undefined
        }
      />
    );
  },
});

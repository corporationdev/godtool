import { createFileRoute } from "@tanstack/react-router";
import { SourcesPage } from "@executor/react/pages/sources";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { createMcpSourcePlugin } from "@executor/plugin-mcp/react";
import { googleDiscoverySourcePlugin } from "@executor/plugin-google-discovery/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";
import { rawSourcePlugin } from "@executor/plugin-raw/react";
import { computerUseSourcePlugin } from "@executor/plugin-computer-use/react";
import { useLocalAuth } from "../web/auth";

const mcpSourcePlugin = createMcpSourcePlugin({ allowStdio: false });

const sourcePlugins = [
  computerUseSourcePlugin,
  openApiSourcePlugin,
  mcpSourcePlugin,
  rawSourcePlugin,
  googleDiscoverySourcePlugin,
  graphqlSourcePlugin,
];

export const Route = createFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  const auth = useLocalAuth();

  return (
    <SourcesPage
      sourcePlugins={sourcePlugins}
      auth={auth.auth}
      onSignIn={auth.available ? () => void auth.signIn() : undefined}
    />
  );
}

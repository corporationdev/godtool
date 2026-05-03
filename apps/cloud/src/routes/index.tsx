import { createFileRoute } from "@tanstack/react-router";
import { SourcesPage } from "@executor/react/pages/sources";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { mcpSourcePlugin } from "@executor/plugin-mcp/react";
import { googleDiscoverySourcePlugin } from "@executor/plugin-google-discovery/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";
import { rawSourcePlugin } from "@executor/plugin-raw/react";
import { AUTH_PATHS } from "../auth/api";
import { useAuth } from "../web/auth";

const sourcePlugins = [
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
  const auth = useAuth();

  return (
    <SourcesPage
      sourcePlugins={sourcePlugins}
      auth={auth}
      onSignIn={() => {
        window.location.href = AUTH_PATHS.login;
      }}
    />
  );
}

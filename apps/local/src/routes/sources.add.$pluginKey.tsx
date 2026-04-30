import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";
import { SourcesAddPage } from "@executor/react/pages/sources-add";
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
    const { auth, entitlements, signIn, openBillingPlans, syncSourcesToCloud, syncSourcesToLocal } =
      useLocalAuth();
    const managedAuthAccess =
      auth.status === "loading"
        ? { state: "loading" as const }
        : auth.status !== "authenticated"
          ? { state: "sign-in" as const, onSignIn: signIn }
          : entitlements?.managedAuth
            ? { state: "allowed" as const }
            : { state: "upgrade" as const, onUpgrade: openBillingPlans };
    return (
      <SourcesAddPage
        pluginKey={pluginKey}
        url={url}
        preset={preset}
        namespace={namespace}
        sourcePlugins={sourcePlugins}
        nativePlacement="local"
        signedIn={auth.status === "authenticated"}
        managedAuthAccess={managedAuthAccess}
        localDeviceAvailable
        syncToCloud={async (sourceId) => {
          await syncSourcesToCloud([sourceId]);
          await syncSourcesToLocal([sourceId]);
        }}
        syncToLocal={(sourceId) => syncSourcesToLocal([sourceId])}
      />
    );
  },
});

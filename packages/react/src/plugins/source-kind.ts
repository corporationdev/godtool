const KIND_TO_PLUGIN_KEY: Record<string, string> = {
  openapi: "openapi",
  mcp: "mcp",
  graphql: "graphql",
  raw: "raw",
  googleDiscovery: "googleDiscovery",
};

export const sourcePluginKeyForKind = (kind: string): string =>
  KIND_TO_PLUGIN_KEY[kind] ?? kind;

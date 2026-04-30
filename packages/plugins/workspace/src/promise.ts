import { workspacePlugin as workspacePluginEffect, type WorkspacePluginConfig } from "./index";

export type { WorkspacePluginConfig } from "./index";

export const workspacePlugin = (config?: WorkspacePluginConfig) => workspacePluginEffect(config);

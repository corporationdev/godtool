import { browserPlugin as browserPluginEffect, type BrowserPluginConfig } from "./index";

export type { BrowserPluginConfig } from "./index";

export const browserPlugin = (config?: BrowserPluginConfig) => browserPluginEffect(config);

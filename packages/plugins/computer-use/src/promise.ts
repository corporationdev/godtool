import {
  computerUsePlugin as computerUsePluginEffect,
  type ComputerUsePluginConfig,
} from "./index";

export type { ComputerUsePluginConfig } from "./index";

export const computerUsePlugin = (config?: ComputerUsePluginConfig) =>
  computerUsePluginEffect(config);

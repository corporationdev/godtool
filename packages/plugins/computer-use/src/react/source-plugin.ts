import { lazy } from "react";
import type { SourcePlugin } from "@executor/react/plugins/source-plugin";

export const computerUseSourcePlugin: SourcePlugin = {
  key: "computer_use",
  label: "Computer Use",
  add: lazy(() => import("./AddComputerUseSource")),
  edit: lazy(() => import("./EditComputerUseSource")),
  summary: lazy(() => import("./ComputerUseSourceSummary")),
  presets: [
    {
      id: "computer_use",
      name: "Computer Use",
      summary: "Let agents inspect and control apps on this Mac.",
    },
  ],
};

import { lazy } from "react";
import type { SourcePlugin } from "@executor/react/plugins/source-plugin";

const computerUseIcon =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect x="3.5" y="4.5" width="17" height="11" rx="2" stroke="#9CA3AF" stroke-width="1.8"/><path d="M8 19.5h8M12 15.5v4" stroke="#9CA3AF" stroke-width="1.8" stroke-linecap="round"/></svg>',
  );

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
      icon: computerUseIcon,
    },
  ],
};

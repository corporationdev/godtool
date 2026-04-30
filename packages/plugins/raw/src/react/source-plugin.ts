import { lazy } from "react";

import type { SourcePlugin } from "@executor/react/plugins/source-plugin";

import { rawPresets } from "../sdk/presets";

export const rawSourcePlugin: SourcePlugin = {
  key: "raw",
  label: "Raw HTTP",
  add: lazy(() => import("./AddRawSource")),
  edit: lazy(() => import("./EditRawSource")),
  summary: lazy(() => import("./RawSourceSummary")),
  presets: rawPresets,
};

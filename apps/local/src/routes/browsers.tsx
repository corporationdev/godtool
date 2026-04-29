import { createFileRoute } from "@tanstack/react-router";
import { BrowsersPage } from "@executor/react/pages/browsers";

export const Route = createFileRoute("/browsers")({
  component: BrowsersPage,
});

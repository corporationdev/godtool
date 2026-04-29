import { createFileRoute } from "@tanstack/react-router";
import { FilesPage } from "@executor/react/pages/files";

export const Route = createFileRoute("/files")({
  component: FilesPage,
});

import React from "react";
import { createRootRoute } from "@tanstack/react-router";
import { PostHogProvider } from "posthog-js/react";
import { ExecutorProvider } from "@executor/react/api/provider";
import { Shell } from "../web/shell";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <PostHogProvider
      apiKey={import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN as string}
      options={{
        api_host: "/ingest",
        ui_host: (import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string) || "https://us.posthog.com",
        defaults: "2026-01-30",
        capture_exceptions: true,
        debug: import.meta.env.DEV,
      }}
    >
      <ExecutorProvider>
        <Shell />
      </ExecutorProvider>
    </PostHogProvider>
  );
}

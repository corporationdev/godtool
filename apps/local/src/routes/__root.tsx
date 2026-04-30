import React from "react";
import { createRootRoute } from "@tanstack/react-router";
import { ExecutorProvider } from "@executor/react/api/provider";
import { Shell } from "../web/shell";
import { LocalAuthProvider } from "../web/auth";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <LocalAuthProvider>
      <ExecutorProvider>
        <Shell />
      </ExecutorProvider>
    </LocalAuthProvider>
  );
}

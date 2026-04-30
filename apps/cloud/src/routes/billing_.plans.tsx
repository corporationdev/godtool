import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/billing_/plans")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/billing/plans" });
  },
});

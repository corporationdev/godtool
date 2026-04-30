import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  staticData: { shellSidebar: "settings" },
  beforeLoad: ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/billing" });
    }
  },
  component: SettingsLayout,
});

function SettingsLayout() {
  return <Outlet />;
}

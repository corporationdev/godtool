import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import { useAtomValue, useAtomSet, Result } from "@effect-atom/atom-react";
import { Building2, CreditCard, DatabaseZap, KeyRound } from "lucide-react";
import { Button } from "@executor/react/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor/react/components/dialog";
import { CommandPalette } from "@executor/react/components/command-palette";
import { AccountMenu } from "@executor/react/components/account-menu";
import {
  Sidebar,
  SidebarContent as ShadSidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@executor/react/components/sidebar";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { mcpSourcePlugin } from "@executor/plugin-mcp/react";
import { googleDiscoverySourcePlugin } from "@executor/plugin-google-discovery/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";
import { rawSourcePlugin } from "@executor/plugin-raw/react";
import { AUTH_PATHS } from "../auth/api";
import { organizationsAtom, switchOrganization, useAuth } from "./auth";
import {
  CreateOrganizationFields,
  useCreateOrganizationForm,
} from "./components/create-organization-form";

const sourcePlugins = [
  openApiSourcePlugin,
  mcpSourcePlugin,
  rawSourcePlugin,
  googleDiscoverySourcePlugin,
  graphqlSourcePlugin,
];

type DeviceStatusResponse = {
  readonly activeDeviceId: string | null;
  readonly devices: readonly {
    readonly deviceId: string;
    readonly name: string;
    readonly online: boolean;
    readonly lastSeenAt: number;
  }[];
};

// ── NavItem ──────────────────────────────────────────────────────────────

function NavItem(props: {
  to: string;
  label: string;
  active: boolean;
  icon: ComponentType<{ className?: string }>;
}) {
  const Icon = props.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={props.active} tooltip={props.label}>
        <Link to={props.to}>
          <Icon />
          <span>{props.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// ── UserFooter ──────────────────────────────────────────────────────────

function UserFooter() {
  const auth = useAuth();
  const organizations = useAtomValue(organizationsAtom);
  const doSwitchOrganization = useAtomSet(switchOrganization, { mode: "promiseExit" });
  const [createOrganizationOpen, setCreateOrganizationOpen] = useState(false);

  const suggestedOrganizationName =
    auth.status === "authenticated" && auth.user.name?.trim() !== "" && auth.user.name != null
      ? `${auth.user.name}'s Organization`
      : "New Organization";

  const form = useCreateOrganizationForm({
    defaultName: suggestedOrganizationName,
    onSuccess: () => window.location.reload(),
  });

  if (auth.status !== "authenticated") return null;

  const openCreateOrganization = () => {
    form.reset(suggestedOrganizationName);
    setCreateOrganizationOpen(true);
  };

  const handleSwitchOrganization = async (organizationId: string) => {
    if (organizationId === auth.organization?.id) return;
    const exit = await doSwitchOrganization({ payload: { organizationId } });
    if (exit._tag === "Success") window.location.reload();
  };

  const organizationState = Result.match(organizations, {
    onInitial: () => ({ loading: true, error: false, organizations: [] }),
    onFailure: () => ({ loading: false, error: true, organizations: [] }),
    onSuccess: ({ value }) => ({
      loading: false,
      error: false,
      organizations: value.organizations,
    }),
  });

  return (
    <SidebarFooter className="group-data-[collapsible=icon]:items-center">
      <Dialog
        open={createOrganizationOpen}
        onOpenChange={(open) => {
          setCreateOrganizationOpen(open);
          if (!open) form.reset(suggestedOrganizationName);
        }}
      >
        <AccountMenu
          auth={auth}
          organizations={organizationState.organizations}
          organizationsLoading={organizationState.loading}
          organizationsError={organizationState.error}
          activeOrganizationId={auth.organization?.id ?? null}
          onSwitchOrganization={handleSwitchOrganization}
          onCreateOrganization={openCreateOrganization}
          onSignOut={async () => {
            await fetch(AUTH_PATHS.logout, { method: "POST" });
            window.location.href = "/";
          }}
        />

        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Create organization</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed">
              Add another organization under your current account and switch into it immediately.
            </DialogDescription>
          </DialogHeader>

          <CreateOrganizationFields
            name={form.name}
            onNameChange={(name) => {
              form.setName(name);
              if (form.error) form.setError(null);
            }}
            error={form.error}
            onSubmit={() => void form.submit()}
          />

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm" disabled={form.creating}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={() => void form.submit()}
              disabled={!form.canSubmit || form.creating}
            >
              {form.creating ? "Creating…" : "Create organization"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarFooter>
  );
}

function DeviceConnectionFooter() {
  const auth = useAuth();
  const activeOrganizationId =
    auth.status === "authenticated" ? (auth.organization?.id ?? null) : null;
  const [status, setStatus] = useState<DeviceStatusResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!activeOrganizationId) {
      setStatus(null);
      setFailed(false);
      return;
    }

    let alive = true;
    const controller = new AbortController();

    const load = async () => {
      try {
        const response = await fetch("/api/devices/status", {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Device status failed: ${response.status}`);
        const data = (await response.json()) as DeviceStatusResponse;
        if (!alive) return;
        setStatus(data);
        setFailed(false);
      } catch {
        if (!alive) return;
        setFailed(true);
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [activeOrganizationId]);

  if (auth.status !== "authenticated" || !auth.organization) return null;

  const onlineDevices = status?.devices.filter((device) => device.online) ?? [];
  const activeDevice =
    onlineDevices.find((device) => device.deviceId === status?.activeDeviceId) ?? onlineDevices[0];
  const connected = onlineDevices.length > 0;
  const label = connected
    ? onlineDevices.length === 1
      ? (activeDevice?.name ?? "Local Mac")
      : `${onlineDevices.length} devices online`
    : failed
      ? "Connection unavailable"
      : "No local device";

  return (
    <div className="shrink-0 px-3 pb-2 group-data-[collapsible=icon]:px-2">
      <div
        className="flex items-center gap-2 rounded-md px-2.5 py-2 text-xs text-sidebar-foreground group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
        title={label}
      >
        <span
          className={[
            "size-2 rounded-full",
            connected ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.6)]" : "bg-muted",
          ].join(" ")}
        />
        <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">
          {label}
        </span>
        <span
          className={[
            connected ? "text-emerald-400" : "text-muted-foreground",
            "group-data-[collapsible=icon]:hidden",
          ].join(" ")}
        >
          {connected ? "Connected" : "Offline"}
        </span>
      </div>
    </div>
  );
}

// ── SidebarContent ───────────────────────────────────────────────────────

function AppSidebar(props: { pathname: string }) {
  const isHome = props.pathname === "/";
  const isSecrets = props.pathname === "/secrets";
  const isBilling = props.pathname === "/billing" || props.pathname.startsWith("/billing/");
  const isOrg = props.pathname === "/org";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex h-10 items-center px-2 group-data-[collapsible=icon]:justify-center">
          <div className="min-w-0 flex-1 overflow-hidden max-w-[999px] transition-[max-width] duration-200 ease-linear group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:flex-none">
            <Link to="/" className="flex items-center gap-2 text-foreground">
              <span className="font-display text-base tracking-tight">GOD TOOL</span>
            </Link>
          </div>
          <SidebarTrigger className="shrink-0" />
        </div>
      </SidebarHeader>

      <ShadSidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItem to="/" label="Sources" icon={DatabaseZap} active={isHome} />
              <NavItem to="/secrets" label="Secrets" icon={KeyRound} active={isSecrets} />
              <NavItem to="/org" label="Organization" icon={Building2} active={isOrg} />
              <NavItem to="/billing" label="Billing" icon={CreditCard} active={isBilling} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </ShadSidebarContent>

      <DeviceConnectionFooter />
      <UserFooter />
      <SidebarRail />
    </Sidebar>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────

export function Shell() {
  const location = useLocation();
  const pathname = location.pathname;

  return (
    <SidebarProvider>
      <CommandPalette sourcePlugins={sourcePlugins} />
      <AppSidebar pathname={pathname} />
      <main className="flex min-h-0 flex-1 flex-col min-w-0 overflow-hidden">
        <Outlet />
      </main>
    </SidebarProvider>
  );
}

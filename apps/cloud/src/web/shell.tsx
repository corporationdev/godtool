import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAtomValue, useAtomSet, Result } from "@effect-atom/atom-react";
import {
  Building2,
  ChevronsUpDown,
  CreditCard,
  Database,
  Files,
  KeyRound,
  Link2,
} from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@executor/react/components/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
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
import { CommandPalette } from "@executor/react/components/command-palette";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { mcpSourcePlugin } from "@executor/plugin-mcp/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";
import { AUTH_PATHS } from "../auth/api";
import { organizationsAtom, switchOrganization, useAuth } from "./auth";
import {
  CreateOrganizationFields,
  useCreateOrganizationForm,
} from "./components/create-organization-form";

const sourcePlugins = [
  openApiSourcePlugin,
  mcpSourcePlugin,
  graphqlSourcePlugin,
];

// ── Nav items ─────────────────────────────────────────────────────────────

const navItems = [
  { to: "/", label: "Sources", icon: Database },
  { to: "/files", label: "Files", icon: Files },
  { to: "/connections", label: "Connections", icon: Link2 },
  { to: "/secrets", label: "Secrets", icon: KeyRound },
  { to: "/org", label: "Organization", icon: Building2 },
  { to: "/billing", label: "Billing", icon: CreditCard },
] as const;

// ── Avatar ────────────────────────────────────────────────────────────────

function initialsFor(name: string | null, email: string) {
  if (name) {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }
  return email[0]!.toUpperCase();
}

function UserAvatar(props: { url: string | null; name: string | null; email: string; size?: "sm" | "md" }) {
  const size = props.size === "md" ? "size-8" : "size-7";
  const text = props.size === "md" ? "text-sm" : "text-xs";
  if (props.url) {
    return <img src={props.url} alt="" className={`${size} shrink-0 rounded-full`} />;
  }
  return (
    <div
      className={`flex ${size} shrink-0 items-center justify-center rounded-full bg-primary/10 ${text} font-semibold text-primary`}
    >
      {initialsFor(props.name, props.email)}
    </div>
  );
}

// ── OrganizationSwitcherItems ─────────────────────────────────────────────

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="ml-auto size-3 text-muted-foreground">
      <path
        d="M3.5 8.5L6.5 11.5L12.5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OrganizationSwitcherItems(props: { activeOrganizationId: string | null }) {
  const organizations = useAtomValue(organizationsAtom);
  const doSwitchOrganization = useAtomSet(switchOrganization, { mode: "promiseExit" });

  const handleSwitch = async (organizationId: string) => {
    if (organizationId === props.activeOrganizationId) return;
    const exit = await doSwitchOrganization({ payload: { organizationId } });
    if (exit._tag === "Success") window.location.reload();
  };

  return Result.match(organizations, {
    onInitial: () => <DropdownMenuItem disabled>Loading…</DropdownMenuItem>,
    onFailure: () => <DropdownMenuItem disabled>Failed to load organizations</DropdownMenuItem>,
    onSuccess: ({ value }) =>
      value.organizations.length === 0 ? (
        <DropdownMenuItem disabled>No organizations</DropdownMenuItem>
      ) : (
        <>
          {value.organizations.map((organization) => {
            const isActive = organization.id === props.activeOrganizationId;
            return (
              <DropdownMenuItem
                key={organization.id}
                disabled={isActive}
                onClick={() => handleSwitch(organization.id)}
                className="text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                {isActive && <CheckIcon />}
              </DropdownMenuItem>
            );
          })}
        </>
      ),
  });
}

// ── UserFooter ────────────────────────────────────────────────────────────

function UserFooter() {
  const auth = useAuth();
  const [createOrganizationOpen, setCreateOrganizationOpen] = useState(false);

  const suggestedOrganizationName =
    auth.status === "authenticated" &&
    auth.user.name?.trim() !== "" &&
    auth.user.name != null
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

  return (
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <Dialog
            open={createOrganizationOpen}
            onOpenChange={(open) => {
              setCreateOrganizationOpen(open);
              if (!open) form.reset(suggestedOrganizationName);
            }}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  tooltip={auth.user.name ?? auth.user.email}
                >
                  <UserAvatar
                    url={auth.user.avatarUrl}
                    name={auth.user.name}
                    email={auth.user.email}
                    size="md"
                  />
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">
                      {auth.user.name ?? auth.user.email}
                    </span>
                    {auth.organization && (
                      <span className="truncate text-xs text-muted-foreground">
                        {auth.organization.name}
                      </span>
                    )}
                  </div>
                  <ChevronsUpDown className="ml-auto size-4 shrink-0" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-64">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Organization
                </DropdownMenuLabel>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="text-xs">
                    <span className="min-w-0 flex-1 truncate">
                      {auth.organization?.name ?? "No organization"}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56">
                    <OrganizationSwitcherItems activeOrganizationId={auth.organization?.id ?? null} />
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-xs"
                      onSelect={(event) => {
                        event.preventDefault();
                        openCreateOrganization();
                      }}
                    >
                      Create organization
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Signed in as
                </DropdownMenuLabel>
                <DropdownMenuItem className="gap-2 text-xs pointer-events-none">
                  <UserAvatar url={auth.user.avatarUrl} name={auth.user.name} email={auth.user.email} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">
                      {auth.user.name ?? auth.user.email}
                    </p>
                    {auth.user.name && (
                      <p className="truncate text-muted-foreground">{auth.user.email}</p>
                    )}
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-xs text-destructive focus:text-destructive"
                  onClick={async () => {
                    await fetch(AUTH_PATHS.logout, { method: "POST" });
                    window.location.href = "/";
                  }}
                >
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

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
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

// ── AppSidebar ────────────────────────────────────────────────────────────

function AppSidebar(props: { pathname: string }) {
  const isActive = (to: string) =>
    to === "/" ? props.pathname === "/" : props.pathname === to || props.pathname.startsWith(to + "/");

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex h-10 items-center px-2 group-data-[collapsible=icon]:justify-center">
          <div className="min-w-0 flex-1 overflow-hidden max-w-[999px] group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:flex-none transition-[max-width] duration-200 ease-linear">
            <Link to="/" className="flex items-center">
              <span className="whitespace-nowrap font-display text-base tracking-tight text-foreground">
                GOD TOOL
              </span>
            </Link>
          </div>
          <SidebarTrigger className="shrink-0" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map(({ to, label, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton asChild isActive={isActive(to)} tooltip={label}>
                    <Link to={to}>
                      <Icon />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <UserFooter />
      <SidebarRail />
    </Sidebar>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────

export function Shell() {
  const location = useLocation();
  const pathname = location.pathname;
  const lastPathname = useRef(pathname);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  if (lastPathname.current !== pathname) {
    lastPathname.current = pathname;
    if (mobileSidebarOpen) setMobileSidebarOpen(false);
  }

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

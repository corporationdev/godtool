import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAtomValue, useAtomSet, Result } from "@effect-atom/atom-react";
import { useSourcesWithPending } from "@executor/react/api/optimistic";
import { useScope } from "@executor/react/api/scope-context";
import { Button } from "@executor/react/components/button";
import { Skeleton } from "@executor/react/components/skeleton";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor/react/components/dialog";
import { SourceFavicon } from "@executor/react/components/source-favicon";
import { CommandPalette } from "@executor/react/components/command-palette";
import { AccountMenu } from "@executor/react/components/account-menu";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { mcpSourcePlugin } from "@executor/plugin-mcp/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";
import { AUTH_PATHS } from "../auth/api";
import { organizationsAtom, switchOrganization, useAuth } from "./auth";
import {
  CreateOrganizationFields,
  useCreateOrganizationForm,
} from "./components/create-organization-form";

const sourcePlugins = [openApiSourcePlugin, mcpSourcePlugin, graphqlSourcePlugin];

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

function NavItem(props: { to: string; label: string; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      to={props.to}
      onClick={props.onNavigate}
      className={[
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
        props.active
          ? "bg-sidebar-active text-foreground font-medium"
          : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
      ].join(" ")}
    >
      {props.label}
    </Link>
  );
}

// ── SourceList ───────────────────────────────────────────────────────────

function SourceList(props: { pathname: string; onNavigate?: () => void }) {
  const scopeId = useScope();
  const sources = useSourcesWithPending(scopeId);

  return Result.match(sources, {
    onInitial: () => (
      <div className="flex flex-col gap-1 px-2.5 py-1">
        {[80, 65, 72, 58, 68].map((w, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md py-1.5">
            <Skeleton className="size-3.5 shrink-0 rounded" />
            <Skeleton className="h-3" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    ),
    onFailure: () => (
      <div className="px-2.5 py-2 text-xs text-muted-foreground">No sources yet</div>
    ),
    onSuccess: ({ value }) =>
      value.length === 0 ? (
        <div className="px-2.5 py-2 text-sm leading-relaxed text-muted-foreground">
          No sources yet
        </div>
      ) : (
        <div className="flex flex-col gap-px">
          {value.map((s) => {
            const detailPath = `/sources/${s.id}`;
            const active =
              props.pathname === detailPath || props.pathname.startsWith(`${detailPath}/`);
            return (
              <Link
                key={s.id}
                to="/sources/$namespace"
                params={{ namespace: s.id }}
                onClick={props.onNavigate}
                className={[
                  "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                  active
                    ? "bg-sidebar-active text-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
                ].join(" ")}
              >
                <SourceFavicon url={s.url} />
                <span className="flex-1 truncate">{s.name}</span>
                <span className="rounded bg-secondary/50 px-1 py-px text-xs font-medium text-muted-foreground">
                  {s.kind}
                </span>
              </Link>
            );
          })}
        </div>
      ),
  });
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
    <div className="shrink-0 border-t border-sidebar-border px-3 py-2.5">
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
    </div>
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
      ? activeDevice?.name ?? "Local Mac"
      : `${onlineDevices.length} devices online`
    : failed
      ? "Connection unavailable"
      : "No local device";

  return (
    <div className="shrink-0 px-3 pb-2">
      <div className="flex items-center gap-2 rounded-md px-2.5 py-2 text-xs text-sidebar-foreground">
        <span
          className={[
            "size-2 rounded-full",
            connected ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.6)]" : "bg-muted",
          ].join(" ")}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className={connected ? "text-emerald-400" : "text-muted-foreground"}>
          {connected ? "Connected" : "Offline"}
        </span>
      </div>
    </div>
  );
}

// ── SidebarContent ───────────────────────────────────────────────────────

function SidebarContent(props: { pathname: string; onNavigate?: () => void; showBrand?: boolean }) {
  const isHome = props.pathname === "/";
  const isSecrets = props.pathname === "/secrets";
  const isBilling = props.pathname === "/billing" || props.pathname.startsWith("/billing/");
  const isOrg = props.pathname === "/org";

  return (
    <>
      {props.showBrand !== false && (
        <div className="flex h-12 shrink-0 items-center border-b border-sidebar-border px-4">
          <Link to="/" className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">executor</span>
          </Link>
        </div>
      )}

      <nav className="flex flex-1 flex-col overflow-y-auto p-2">
        <NavItem to="/" label="Sources" active={isHome} onNavigate={props.onNavigate} />
        <NavItem to="/secrets" label="Secrets" active={isSecrets} onNavigate={props.onNavigate} />
        <NavItem to="/org" label="Organization" active={isOrg} onNavigate={props.onNavigate} />
        <NavItem to="/billing" label="Billing" active={isBilling} onNavigate={props.onNavigate} />

        <div className="mt-5 mb-1 px-2.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          <span>Sources</span>
        </div>

        <SourceList pathname={props.pathname} onNavigate={props.onNavigate} />
      </nav>

      <DeviceConnectionFooter />
      <UserFooter />
    </>
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

  // Lock scroll when mobile sidebar open
  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileSidebarOpen]);

  return (
    <div className="flex h-screen overflow-hidden">
      <CommandPalette sourcePlugins={sourcePlugins} />
      {/* Desktop sidebar */}
      <aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col lg:w-56">
        <SidebarContent pathname={pathname} />
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          {/* oxlint-disable-next-line react/forbid-elements */}
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <div className="relative flex h-full w-[84vw] max-w-xs flex-col border-r border-sidebar-border bg-sidebar shadow-2xl">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
              <Link to="/" className="flex items-center gap-1.5">
                <span className="font-display text-base tracking-tight text-foreground">
                  executor
                </span>
              </Link>
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label="Close navigation"
                onClick={() => setMobileSidebarOpen(false)}
                className="text-sidebar-foreground hover:bg-sidebar-active hover:text-foreground"
              >
                <svg viewBox="0 0 16 16" className="size-3.5">
                  <path
                    d="M3 3l10 10M13 3L3 13"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </Button>
            </div>
            <SidebarContent
              pathname={pathname}
              onNavigate={() => setMobileSidebarOpen(false)}
              showBrand={false}
            />
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex min-h-0 flex-1 flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4 md:hidden">
          <Button
            variant="outline"
            size="icon-sm"
            type="button"
            aria-label="Open navigation"
            onClick={() => setMobileSidebarOpen(true)}
            className="bg-card hover:bg-accent/50"
          >
            <svg viewBox="0 0 16 16" className="size-4">
              <path
                d="M2 4h12M2 8h12M2 12h12"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </Button>
          <Link to="/" className="flex items-center gap-1.5">
            <span className="font-display text-base tracking-tight text-foreground">executor</span>
          </Link>
          <div className="w-8 shrink-0" />
        </div>

        <Outlet />
      </main>
    </div>
  );
}

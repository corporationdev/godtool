import { Link, Outlet, useLocation, useMatches } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { ComponentType } from "react";
import {
  ArrowLeft,
  CreditCard,
  DatabaseZap,
  Folder,
  Globe,
  KeyRound,
  RefreshCw,
  Settings,
} from "lucide-react";
import { useAtomRefresh } from "@effect-atom/atom-react";
import { sourcesAtom, toolsAtom } from "@executor/react/api/atoms";
import { useScope } from "@executor/react/api/scope-context";
import { Button } from "@executor/react/components/button";
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
import { createMcpSourcePlugin } from "@executor/plugin-mcp/react";
import { useLocalAuth } from "./auth";
import { googleDiscoverySourcePlugin } from "@executor/plugin-google-discovery/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";
import { rawSourcePlugin } from "@executor/plugin-raw/react";
import { computerUseSourcePlugin } from "@executor/plugin-computer-use/react";

const mcpSourcePlugin = createMcpSourcePlugin({ allowStdio: false });

const sourcePlugins = [
  computerUseSourcePlugin,
  openApiSourcePlugin,
  mcpSourcePlugin,
  rawSourcePlugin,
  googleDiscoverySourcePlugin,
  graphqlSourcePlugin,
];

const settingsNavItems = [{ to: "/settings/billing", label: "Billing", icon: CreditCard }] as const;

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    shellSidebar?: "app" | "settings";
  }
}

// ── Env ─────────────────────────────────────────────────────────────────

type AppMetaEnv = {
  readonly VITE_APP_VERSION: string;
  readonly VITE_GITHUB_URL: string;
};

const { VITE_APP_VERSION } = (
  import.meta as ImportMeta & {
    readonly env: AppMetaEnv;
  }
).env;

// ── Version helpers ─────────────────────────────────────────────────────

type UpdateChannel = "latest" | "beta";

const EXECUTOR_DIST_TAGS_PATH = "/v1/app/npm/dist-tags";

type ReadyDesktopUpdateStatus = {
  readonly state: "ready";
  readonly channel: string;
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly percent?: number;
};

const isReadyDesktopUpdateStatus = (
  status: DesktopUpdateStatus | null,
): status is ReadyDesktopUpdateStatus => status?.state === "ready";

type ParsedVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string | number> | null;
};

const semverPattern =
  /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const resolveUpdateChannel = (version: string): UpdateChannel =>
  version.includes("-beta.") ? "beta" : "latest";

const parseVersion = (version: string): ParsedVersion | null => {
  const match = version.trim().match(semverPattern);
  if (!match?.groups) return null;
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    prerelease: match.groups.prerelease
      ? match.groups.prerelease.split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id))
      : null,
  };
};

const comparePrereleaseIdentifiers = (
  left: ReadonlyArray<string | number> | null,
  right: ReadonlyArray<string | number> | null,
): number => {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === "number" && typeof r === "number") return l < r ? -1 : 1;
    if (typeof l === "number") return -1;
    if (typeof r === "number") return 1;
    return l < r ? -1 : 1;
  }
  return 0;
};

const compareVersions = (left: string, right: string): number | null => {
  const lv = parseVersion(left);
  const rv = parseVersion(right);
  if (!lv || !rv) return null;
  if (lv.major !== rv.major) return lv.major < rv.major ? -1 : 1;
  if (lv.minor !== rv.minor) return lv.minor < rv.minor ? -1 : 1;
  if (lv.patch !== rv.patch) return lv.patch < rv.patch ? -1 : 1;
  return comparePrereleaseIdentifiers(lv.prerelease, rv.prerelease);
};

// ── useLatestVersion ────────────────────────────────────────────────────

function useLatestVersion(currentVersion: string) {
  const channel = resolveUpdateChannel(currentVersion);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(EXECUTOR_DIST_TAGS_PATH)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load dist tags: ${res.status}`);
        return res.json() as Promise<Partial<Record<UpdateChannel, string>>>;
      })
      .then((data) => {
        if (!cancelled) setLatestVersion(data[channel] ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [channel]);

  const updateAvailable =
    latestVersion !== null && compareVersions(currentVersion, latestVersion) === -1;

  return { latestVersion, updateAvailable, channel };
}

// ── UpdateCard ──────────────────────────────────────────────────────────

function UpdateCard(props: { latestVersion: string; channel: UpdateChannel }) {
  const command = `npm i -g executor@${props.channel}`;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [command]);

  return (
    <div className="mx-2 mb-2 rounded-xl border border-primary/25 bg-primary/[0.06] p-3 group-data-[collapsible=icon]:hidden">
      <div className="flex items-center gap-2">
        <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <svg viewBox="0 0 16 16" fill="none" className="size-3 text-primary">
            <path
              d="M8 3v7M5 7l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">Update available</p>
          <p className="text-sm text-muted-foreground">v{props.latestVersion}</p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={handleCopy}
        className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-lg border-border/60 bg-background/50 px-2.5 py-1.5 text-left hover:bg-background/80"
      >
        <code className="truncate font-mono text-xs text-sidebar-foreground">{command}</code>
        <span className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground">
          {copied ? (
            <svg viewBox="0 0 16 16" fill="none" className="size-3 text-primary">
              <path
                d="M3 8.5l3.5 3.5L13 4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="size-3">
              <rect
                x="5"
                y="5"
                width="8"
                height="8"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path
                d="M3 11V3.5A.5.5 0 013.5 3H11"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </span>
      </Button>
    </div>
  );
}

// ── useDesktopUpdate ────────────────────────────────────────────────────

function useDesktopUpdate() {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    const updates = window.electronAPI?.updates;
    if (!updates) return;

    let cancelled = false;
    updates
      .getStatus()
      .then((nextStatus) => {
        if (!cancelled) setStatus(nextStatus);
      })
      .catch(() => {});
    const unsubscribe = updates.onStatus(setStatus);
    void updates.check().catch(() => {});

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const restartAndInstall = useCallback(() => {
    const updates = window.electronAPI?.updates;
    if (!updates) return;
    setRestarting(true);
    void updates.restartAndInstall().then((started) => {
      if (!started) setRestarting(false);
    });
  }, []);

  return { status, restarting, restartAndInstall };
}

function DesktopUpdateCard(props: {
  status: ReadyDesktopUpdateStatus;
  restarting: boolean;
  onRestart: () => void;
}) {
  return (
    <div className="mx-2 mb-2 rounded-xl border border-primary/25 bg-primary/[0.06] p-3 group-data-[collapsible=icon]:hidden">
      <div className="flex items-center gap-2">
        <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <RefreshCw className="size-3 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">Update ready</p>
          <p className="text-sm text-muted-foreground">v{props.status.latestVersion}</p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={props.onRestart}
        disabled={props.restarting}
        className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-lg border-border/60 bg-background/50 px-2.5 py-1.5 hover:bg-background/80"
      >
        <RefreshCw className="size-3.5" />
        {props.restarting ? "Restarting..." : "Restart"}
      </Button>
    </div>
  );
}

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

// ── SidebarContent ───────────────────────────────────────────────────────

function AppSidebar(props: {
  pathname: string;
  updateAvailable: boolean;
  latestVersion: string | null;
  channel: UpdateChannel;
  desktopUpdate: ReturnType<typeof useDesktopUpdate>;
  auth: ReturnType<typeof useLocalAuth>;
}) {
  const isHome = props.pathname === "/";
  const isSecrets = props.pathname === "/secrets";
  const isBrowsers = props.pathname === "/browsers";
  const isFiles = props.pathname === "/files";
  const readyDesktopUpdate = isReadyDesktopUpdateStatus(props.desktopUpdate.status)
    ? props.desktopUpdate.status
    : null;

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="desktop-sidebar-header" />

      <ShadSidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItem to="/" label="Sources" icon={DatabaseZap} active={isHome} />
              <NavItem to="/browsers" label="Browsers" icon={Globe} active={isBrowsers} />
              <NavItem to="/files" label="Files" icon={Folder} active={isFiles} />
              <NavItem to="/secrets" label="Secrets" icon={KeyRound} active={isSecrets} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </ShadSidebarContent>

      {readyDesktopUpdate ? (
        <DesktopUpdateCard
          status={readyDesktopUpdate}
          restarting={props.desktopUpdate.restarting}
          onRestart={props.desktopUpdate.restartAndInstall}
        />
      ) : props.updateAvailable && props.latestVersion ? (
        <UpdateCard latestVersion={props.latestVersion} channel={props.channel} />
      ) : null}

      <SidebarFooter className="group-data-[collapsible=icon]:items-center">
        <AccountMenu
          auth={props.auth.auth}
          onSignIn={props.auth.available ? () => void props.auth.signIn() : undefined}
          onSignOut={props.auth.available ? () => void props.auth.signOut() : undefined}
          settingsLink={
            <Link to="/settings/billing">
              <Settings />
              Settings
            </Link>
          }
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function SettingsSidebar(props: { pathname: string; auth: ReturnType<typeof useLocalAuth> }) {
  const isActive = (to: string) => props.pathname === to || props.pathname.startsWith(to + "/");

  return (
    <Sidebar collapsible="none" className="h-svh border-r border-sidebar-border">
      <SidebarHeader className="desktop-settings-sidebar-header min-h-[104px] px-2 pb-2 pt-14">
        <div className="flex h-10 items-center gap-2 px-2">
          <Link
            to="/"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            aria-label="Back to app"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <span className="font-display text-base tracking-tight text-foreground">Settings</span>
        </div>
      </SidebarHeader>

      <ShadSidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {settingsNavItems.map(({ to, label, icon: Icon }) => (
                <NavItem key={to} to={to} label={label} icon={Icon} active={isActive(to)} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </ShadSidebarContent>

      <SidebarFooter className="group-data-[collapsible=icon]:items-center">
        <AccountMenu
          auth={props.auth.auth}
          onSignIn={props.auth.available ? () => void props.auth.signIn() : undefined}
          onSignOut={props.auth.available ? () => void props.auth.signOut() : undefined}
          settingsLink={
            <Link to="/settings/billing">
              <Settings />
              Settings
            </Link>
          }
        />
      </SidebarFooter>
    </Sidebar>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────

export function Shell() {
  const location = useLocation();
  const matches = useMatches();
  const pathname = location.pathname;
  const scopeId = useScope();
  const refreshSources = useAtomRefresh(sourcesAtom(scopeId));
  const refreshTools = useAtomRefresh(toolsAtom(scopeId));
  const auth = useLocalAuth();
  const { latestVersion, updateAvailable, channel } = useLatestVersion(VITE_APP_VERSION);
  const desktopUpdate = useDesktopUpdate();
  const shellSidebar = matches.some((match) => match.staticData.shellSidebar === "settings")
    ? "settings"
    : "app";

  useEffect(() => {
    if (!import.meta.hot) {
      return;
    }

    const refreshBackendData = () => {
      refreshSources();
      refreshTools();
    };

    import.meta.hot.on("executor:backend-updated", refreshBackendData);

    return () => {
      import.meta.hot?.off("executor:backend-updated", refreshBackendData);
    };
  }, [refreshSources, refreshTools]);

  return (
    <SidebarProvider>
      <CommandPalette sourcePlugins={sourcePlugins} />
      {shellSidebar === "app" ? <SidebarTrigger className="desktop-sidebar-trigger shrink-0" /> : null}
      {shellSidebar === "settings" ? (
        <SettingsSidebar pathname={pathname} auth={auth} />
      ) : (
        <AppSidebar
          pathname={pathname}
          updateAvailable={updateAvailable}
          latestVersion={latestVersion}
          channel={channel}
          desktopUpdate={desktopUpdate}
          auth={auth}
        />
      )}
      <main className="flex min-h-0 flex-1 flex-col min-w-0 overflow-hidden">
        <Outlet />
      </main>
    </SidebarProvider>
  );
}

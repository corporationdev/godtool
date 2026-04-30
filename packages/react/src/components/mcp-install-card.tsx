import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import CursorIcon from "@lobehub/icons/es/Cursor/components/Mono";
import ClaudeIcon from "@lobehub/icons/es/Claude/components/Color";
import OpenCodeIcon from "@lobehub/icons/es/OpenCode/components/Mono";
import { LockIcon } from "lucide-react";
import { Button } from "./button";
import { CodeBlock } from "./code-block";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";
import { cn } from "../lib/utils";
import { useScopeInfo } from "../api/scope-context";
import { useManagedAuthAccess } from "../plugins/managed-auth";

type TransportMode = "local-http" | "remote-http" | "stdio";

type ElectronWindow = Window & {
  readonly electronAPI?: {
    readonly cloudAuth?: {
      readonly getCloudUrl?: () => Promise<string>;
    };
  };
};

const SUPPORTED_AGENTS = [
  { key: "cursor", label: "Cursor", Icon: CursorIcon },
  { key: "claude", label: "Claude", Icon: ClaudeIcon },
  { key: "opencode", label: "OpenCode", Icon: OpenCodeIcon },
] as const;

const isDev = import.meta.env.DEV;
const isLocal =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname.endsWith(".localhost"));

export function McpInstallCard(props: { className?: string }) {
  const showLocalHttp = isLocal;
  const [mode, setMode] = useState<TransportMode>(showLocalHttp ? "local-http" : "remote-http");
  const [origin, setOrigin] = useState<string | null>(null);
  const [cloudOrigin, setCloudOrigin] = useState<string | null>(null);
  const scopeInfo = useScopeInfo();
  const proAccess = useManagedAuthAccess();

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    const electronCloudAuth = (window as ElectronWindow).electronAPI?.cloudAuth;
    if (electronCloudAuth?.getCloudUrl) {
      void electronCloudAuth
        .getCloudUrl()
        .then(setCloudOrigin)
        .catch(() => setCloudOrigin(null));
      return;
    }
    const configured = import.meta.env.VITE_PUBLIC_SITE_URL;
    if (typeof configured === "string" && configured.length > 0) {
      setCloudOrigin(configured);
      return;
    }
    if (!isLocal) setCloudOrigin(window.location.origin);
  }, []);

  const localMcpUrl = origin ? `${origin}/mcp` : "http://localhost:3001/mcp";
  const remoteMcpUrl = cloudOrigin ? `${cloudOrigin}/mcp` : "https://app.godtool.dev/mcp";
  const isRemoteMode = mode === "remote-http";
  const remoteLocked = isRemoteMode && !proAccess.loading && !proAccess.allowed;

  const scopeFlag = scopeInfo.dir ? ` --scope ${JSON.stringify(scopeInfo.dir)}` : "";
  const commandUrl = isRemoteMode ? remoteMcpUrl : localMcpUrl;

  const command =
    mode === "stdio"
      ? isDev
        ? `npx add-mcp "bun run dev:cli mcp${scopeFlag}" --name "GOD TOOL"`
        : `npx add-mcp "executor mcp${scopeFlag}" --name "GOD TOOL"`
      : `npx add-mcp "${commandUrl}" --transport http --name "${
          isRemoteMode ? "GOD TOOL Remote" : "GOD TOOL Local"
        }"`;

  const subtitle =
    mode === "local-http"
      ? "Connect to this Mac over local streamable HTTP."
      : mode === "remote-http"
        ? "Connect to GOD TOOL from anywhere over streamable HTTP."
        : isDev
          ? "Uses the repo-local dev CLI. Run from the repository root."
          : "Requires the GOD TOOL CLI on your PATH.";

  const mcpUrlLabel = useMemo(() => {
    try {
      const url = new URL(commandUrl);
      return `${url.host}${url.pathname}`;
    } catch {
      return commandUrl;
    }
  }, [commandUrl]);

  const agentLogos = (
    <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
      <span className="text-xs text-muted-foreground">Work with your agent</span>
      <div className="group/agents flex items-center">
        {SUPPORTED_AGENTS.map(({ key, label, Icon }, index) => (
          <span
            key={key}
            title={label}
            aria-label={label}
            style={{ zIndex: SUPPORTED_AGENTS.length - index }}
            className={cn(
              "flex h-6 items-center justify-center rounded-md border border-border/60 bg-background px-1.5 transition-[margin] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
              index > 0 && "-ml-2 group-hover/agents:ml-1",
            )}
          >
            <Icon size={14} />
          </span>
        ))}
      </div>
      <span className="text-xs text-muted-foreground">and more</span>
    </div>
  );

  const header = (
    <CardStackHeader
      className="items-start pt-3 pb-1"
      rightSlot={
        showLocalHttp ? (
          <TabsList>
            <TabsTrigger value="local-http">Local HTTP</TabsTrigger>
            <TabsTrigger value="remote-http">
              {!proAccess.loading && !proAccess.allowed && <LockIcon className="size-3" />}
              Remote HTTP
            </TabsTrigger>
            <TabsTrigger value="stdio">Standard I/O</TabsTrigger>
          </TabsList>
        ) : undefined
      }
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-semibold text-foreground">Connect an agent</span>
        <span className="text-xs font-normal text-muted-foreground">{subtitle}</span>
      </div>
    </CardStackHeader>
  );

  const body = (
    <CardStackContent>
      <div className="px-4 pt-1 pb-3">
        <CodeBlock code={command} lang="bash" />
      </div>
      {remoteLocked && (
        <div className="px-4 pb-3">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/20 px-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <LockIcon className="size-3.5 text-muted-foreground" />
                Remote MCP requires Pro
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{mcpUrlLabel}</p>
            </div>
            <Button asChild size="sm">
              <Link to="/settings/billing">Upgrade to Pro</Link>
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-center px-4 py-3">{agentLogos}</div>
    </CardStackContent>
  );

  return (
    <CardStack className={props.className}>
      {showLocalHttp ? (
        <Tabs value={mode} onValueChange={(v) => setMode(v as TransportMode)}>
          {header}
          <TabsContent value="local-http">{body}</TabsContent>
          <TabsContent value="remote-http">{body}</TabsContent>
          <TabsContent value="stdio">{body}</TabsContent>
        </Tabs>
      ) : (
        <>
          {header}
          {body}
        </>
      )}
    </CardStack>
  );
}

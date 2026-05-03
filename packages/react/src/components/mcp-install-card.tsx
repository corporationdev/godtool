import CursorIcon from "@lobehub/icons/es/Cursor/components/Mono";
import ClaudeIcon from "@lobehub/icons/es/Claude/components/Color";
import OpenCodeIcon from "@lobehub/icons/es/OpenCode/components/Mono";
import { useEffect, useState } from "react";
import type { AccountAuthState } from "./account-menu";
import { Button } from "./button";
import { CodeBlock } from "./code-block";
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

const SUPPORTED_AGENTS = [
  { key: "cursor", label: "Cursor", Icon: CursorIcon },
  { key: "claude", label: "Claude", Icon: ClaudeIcon },
  { key: "opencode", label: "OpenCode", Icon: OpenCodeIcon },
] as const;

const REMOTE_MCP_HOST = "app.godtool.dev";
const REMOTE_MCP_URL = `https://${REMOTE_MCP_HOST}/mcp`;
const LOCAL_MCP_HOST = "127.0.0.1:1355";
const LOCAL_MCP_URL = `http://${LOCAL_MCP_HOST}/mcp`;

type McpInstallMode = "local-http" | "remote-http";

export function McpInstallCard(props: {
  className?: string;
  auth?: AccountAuthState;
  onSignIn?: () => void;
}) {
  const [mode, setMode] = useState<McpInstallMode>("local-http");
  const signedIn = props.auth?.status === "authenticated";
  const checkingAuth = props.auth?.status === "loading";

  useEffect(() => {
    if (!signedIn && mode === "remote-http") setMode("local-http");
  }, [mode, signedIn]);

  const localCommand = `npx add-mcp "${LOCAL_MCP_URL}" --transport http --name "GOD TOOL Local"`;
  const remoteCommand = `npx add-mcp "${REMOTE_MCP_URL}" --transport http --name "GOD TOOL Remote"`;

  const agentLogos = (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span className="mr-0.5">Works with</span>
      {SUPPORTED_AGENTS.map(({ key, label, Icon }) => (
        <span
          key={key}
          title={label}
          aria-label={label}
          className="inline-flex h-6 items-center gap-1 rounded-md border border-border/60 bg-background/70 px-1.5 text-foreground/80"
        >
          <Icon size={14} />
          <span>{label}</span>
        </span>
      ))}
      <span>and more</span>
    </div>
  );

  return (
    <CardStack className={props.className}>
      <CardStackHeader className="items-start gap-4 pt-3 pb-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-semibold text-foreground">Connect an agent</span>
          <span className="text-xs font-normal text-muted-foreground">
            Connect to GOD TOOL over streamable HTTP.
          </span>
        </div>
        <Tabs value={mode} onValueChange={(value) => setMode(value as McpInstallMode)}>
          <TabsList className="h-9">
            <TabsTrigger value="local-http" className="px-3">
              Local HTTP
            </TabsTrigger>
            {signedIn ? (
              <TabsTrigger value="remote-http" className="px-3">
                Remote HTTP
              </TabsTrigger>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={checkingAuth || !props.onSignIn}
                onClick={props.onSignIn}
                className="h-[calc(100%-1px)] rounded-md px-3 text-sm font-medium"
              >
                {checkingAuth ? "Checking..." : "Sign in"}
              </Button>
            )}
          </TabsList>
        </Tabs>
      </CardStackHeader>
      <CardStackContent className="[&>*+*]:before:bg-border/40">
        <div className="px-4 py-3">
          <Tabs value={mode} onValueChange={(value) => setMode(value as McpInstallMode)}>
            <TabsContent value="local-http" className="mt-0">
              <CodeBlock
                code={localCommand}
                lang="bash"
                className="rounded-md bg-background/60 [&_pre]:!p-2.5 [&_pre]:!text-xs [&_pre]:!leading-6 [&_code]:!text-xs"
              />
            </TabsContent>
            {signedIn && (
              <TabsContent value="remote-http" className="mt-0">
                <CodeBlock
                  code={remoteCommand}
                  lang="bash"
                  className="rounded-md bg-background/60 [&_pre]:!p-2.5 [&_pre]:!text-xs [&_pre]:!leading-6 [&_code]:!text-xs"
                />
              </TabsContent>
            )}
          </Tabs>
        </div>
        <div className="flex items-center px-4 py-2.5">{agentLogos}</div>
      </CardStackContent>
    </CardStack>
  );
}

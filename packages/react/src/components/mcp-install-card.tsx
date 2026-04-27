import { useEffect, useState } from "react";
import CursorIcon from "@lobehub/icons/es/Cursor/components/Mono";
import ClaudeIcon from "@lobehub/icons/es/Claude/components/Color";
import OpenCodeIcon from "@lobehub/icons/es/OpenCode/components/Mono";
import { CodeBlock } from "./code-block";
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";
import { cn } from "../lib/utils";

const SUPPORTED_AGENTS = [
  { key: "cursor", label: "Cursor", Icon: CursorIcon },
  { key: "claude", label: "Claude", Icon: ClaudeIcon },
  { key: "opencode", label: "OpenCode", Icon: OpenCodeIcon },
] as const;

export function McpInstallCard(props: { className?: string }) {
  const [origin, setOrigin] = useState<string | null>(null);
  const serverOrigin = import.meta.env.VITE_SERVER_URL || origin;

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const command = serverOrigin
    ? `npx add-mcp "${serverOrigin}/mcp" --transport http --name "god-tool"`
    : 'npx add-mcp "<this-server>/mcp" --transport http --name "god-tool"';

  const subtitle = "Connect to GOD TOOL as a remote MCP server over streamable HTTP.";

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
    <CardStackHeader className="items-start pt-3 pb-1">
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
      <div className="flex items-center px-4 py-3">{agentLogos}</div>
    </CardStackContent>
  );

  return (
    <CardStack className={props.className}>
      {header}
      {body}
    </CardStack>
  );
}

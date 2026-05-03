import CursorIcon from "@lobehub/icons/es/Cursor/components/Mono";
import ClaudeIcon from "@lobehub/icons/es/Claude/components/Color";
import OpenCodeIcon from "@lobehub/icons/es/OpenCode/components/Mono";
import { CodeBlock } from "./code-block";
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";

const SUPPORTED_AGENTS = [
  { key: "cursor", label: "Cursor", Icon: CursorIcon },
  { key: "claude", label: "Claude", Icon: ClaudeIcon },
  { key: "opencode", label: "OpenCode", Icon: OpenCodeIcon },
] as const;

const REMOTE_MCP_HOST = "app.godtool.dev";
const REMOTE_MCP_URL = `https://${REMOTE_MCP_HOST}/mcp`;

export function McpInstallCard(props: { className?: string }) {
  const command = `npx add-mcp "${REMOTE_MCP_URL}" --transport http --name "godtool"`;

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
      <CardStackHeader className="items-start pt-3 pb-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-semibold text-foreground">Remote MCP</span>
          <span className="text-xs font-normal text-muted-foreground">{REMOTE_MCP_HOST}</span>
        </div>
      </CardStackHeader>
      <CardStackContent className="[&>*+*]:before:bg-border/40">
        <div className="px-4 py-3">
          <CodeBlock
            code={command}
            lang="bash"
            className="rounded-md bg-background/60 [&_pre]:!p-2.5 [&_pre]:!text-xs [&_pre]:!leading-6 [&_code]:!text-xs"
          />
        </div>
        <div className="flex items-center px-4 py-2.5">{agentLogos}</div>
      </CardStackContent>
    </CardStack>
  );
}

export interface RawPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly baseUrl: string;
  readonly defaultHeaders?: Record<string, string>;
  readonly icon?: string;
  readonly featured?: boolean;
  readonly composio?: {
    readonly app: string;
  };
}

const slackIcon = "https://www.google.com/s2/favicons?domain=slack.com&sz=64";
const notionIcon = "https://www.google.com/s2/favicons?domain=notion.so&sz=64";

export const rawPresets: readonly RawPreset[] = [
  {
    id: "slack",
    name: "Slack",
    summary:
      "Slack is a channel-based messaging platform for team communication, collaboration, and workflow automation.",
    baseUrl: "https://slack.com/api",
    icon: slackIcon,
    featured: true,
    composio: { app: "slack" },
  },
  {
    id: "notion",
    name: "Notion",
    summary:
      "Notion centralizes notes, docs, wikis, databases, and tasks in a unified workspace.",
    baseUrl: "https://api.notion.com",
    defaultHeaders: {
      "Notion-Version": "2022-06-28",
    },
    icon: notionIcon,
    featured: true,
    composio: { app: "notion" },
  },
];

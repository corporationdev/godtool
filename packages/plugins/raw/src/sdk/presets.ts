export interface RawPresetComposio {
  readonly app: string;
  readonly authConfigId?: string;
}

export interface RawPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly baseUrl: string;
  readonly defaultHeaders?: Record<string, string>;
  readonly icon?: string;
  readonly featured?: boolean;
  readonly composio?: RawPresetComposio;
}

export const rawPresets: readonly RawPreset[] = [
  {
    id: "slack",
    name: "Slack",
    summary: "Channels, messages, users, files, and workspace automation.",
    baseUrl: "https://slack.com/api",
    icon: "https://slack.com/favicon.ico",
    featured: true,
    composio: { app: "slack" },
  },
  {
    id: "notion",
    name: "Notion",
    summary: "Pages, databases, blocks, comments, and workspace content.",
    baseUrl: "https://api.notion.com",
    defaultHeaders: {
      "Notion-Version": "2022-06-28",
    },
    icon: "https://www.notion.so/images/favicon.ico",
    featured: true,
    composio: { app: "notion" },
  },
];

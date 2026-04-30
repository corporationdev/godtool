export interface RawPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly baseUrl: string;
  readonly defaultHeaders?: Record<string, string>;
  readonly icon?: string;
  readonly featured?: boolean;
}

const slackIcon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='white'/%3E%3Cpath fill='%2336C5F0' d='M12.3 6a3 3 0 0 0 0 6h3V9a3 3 0 0 0-3-3Zm0 8h-3a3 3 0 0 0 0 6h3v-6Z'/%3E%3Cpath fill='%232EB67D' d='M26 12.3a3 3 0 0 0-6 0v3h3a3 3 0 0 0 3-3Zm-8 0v-3a3 3 0 0 0-6 0v3h6Z'/%3E%3Cpath fill='%23ECB22E' d='M19.7 26a3 3 0 0 0 0-6h-3v3a3 3 0 0 0 3 3Zm0-8h3a3 3 0 0 0 0-6h-3v6Z'/%3E%3Cpath fill='%23E01E5A' d='M6 19.7a3 3 0 0 0 6 0v-3H9a3 3 0 0 0-3 3Zm8 0v3a3 3 0 0 0 6 0v-3h-6Z'/%3E%3C/svg%3E";

const notionIcon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='3' y='3' width='26' height='26' rx='3' fill='white' stroke='black' stroke-width='2'/%3E%3Cpath fill='black' d='M10 10.2 13 10l8 12.1V12.7l-2.1-.2V10h6.2v2.5l-2.1.2V25h-3.2L12 13.1v9.7l2.1.3V25H8v-1.9l2-.3V12.7l-2-.2v-1.8l2-.5Z'/%3E%3C/svg%3E";

export const rawPresets: readonly RawPreset[] = [
  {
    id: "slack",
    name: "Slack",
    summary:
      "Slack is a channel-based messaging platform for team communication, collaboration, and workflow automation.",
    baseUrl: "https://slack.com/api",
    icon: slackIcon,
    featured: true,
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
  },
];

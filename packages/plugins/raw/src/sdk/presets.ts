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
    readonly authConfigId?: string;
  };
}

const slackIcon = "https://www.google.com/s2/favicons?domain=slack.com&sz=64";
const notionIcon = "https://www.google.com/s2/favicons?domain=notion.so&sz=64";
const icon = (app: string) => `https://logos.composio.dev/api/${app}`;

export const rawPresets: readonly RawPreset[] = [
  {
    id: "gmail",
    name: "Gmail",
    summary: "Send, read, search, and organize Gmail messages through Google Workspace.",
    baseUrl: "https://www.googleapis.com",
    icon: icon("gmail"),
    featured: true,
    composio: { app: "gmail" },
  },
  {
    id: "googlesheets",
    name: "Google Sheets",
    summary: "Read and update Google Sheets spreadsheets, rows, ranges, and values.",
    baseUrl: "https://sheets.googleapis.com/v4",
    icon: icon("googlesheets"),
    featured: true,
    composio: { app: "googlesheets" },
  },
  {
    id: "googledrive",
    name: "Google Drive",
    summary: "Access, search, upload, and manage files in Google Drive.",
    baseUrl: "https://www.googleapis.com/drive/v3",
    icon: icon("googledrive"),
    featured: true,
    composio: { app: "googledrive" },
  },
  {
    id: "googlecalendar",
    name: "Google Calendar",
    summary: "List, create, and update Google Calendar events.",
    baseUrl: "https://www.googleapis.com/calendar/v3",
    icon: icon("googlecalendar"),
    featured: true,
    composio: { app: "googlecalendar" },
  },
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
  {
    id: "github",
    name: "GitHub",
    summary: "Work with repositories, issues, pull requests, users, and GitHub organization data.",
    baseUrl: "https://api.github.com",
    icon: icon("github"),
    featured: true,
    composio: { app: "github" },
  },
  {
    id: "linear",
    name: "Linear",
    summary: "Query and update Linear issues, projects, teams, and workflow state.",
    baseUrl: "https://api.linear.app",
    icon: icon("linear"),
    featured: true,
    composio: { app: "linear" },
  },
];

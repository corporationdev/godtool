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
const favicon = (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

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
    summary: "Notion centralizes notes, docs, wikis, databases, and tasks in a unified workspace.",
    baseUrl: "https://api.notion.com",
    defaultHeaders: {
      "Notion-Version": "2022-06-28",
    },
    icon: notionIcon,
    featured: true,
    composio: { app: "notion" },
  },
  {
    id: "twitter",
    name: "X / Twitter",
    summary: "Posts, users, timelines, search, direct messages, and social workflows.",
    baseUrl: "https://api.x.com/2",
    icon: favicon("x.com"),
    featured: true,
    composio: { app: "twitter" },
  },
  {
    id: "supabase",
    name: "Supabase",
    summary: "Organizations, projects, branches, auth, storage, and database management.",
    baseUrl: "https://api.supabase.com/v1",
    icon: favicon("supabase.com"),
    featured: true,
    composio: { app: "supabase" },
  },
  {
    id: "airtable",
    name: "Airtable",
    summary: "Bases, tables, records, comments, webhooks, and collaborative data apps.",
    baseUrl: "https://api.airtable.com/v0",
    icon: favicon("airtable.com"),
    featured: true,
    composio: { app: "airtable" },
  },
  {
    id: "hubspot",
    name: "HubSpot",
    summary: "CRM objects, contacts, companies, deals, tickets, marketing, and sales workflows.",
    baseUrl: "https://api.hubapi.com",
    icon: favicon("hubspot.com"),
    featured: true,
    composio: { app: "hubspot" },
  },
  {
    id: "gong",
    name: "Gong",
    summary: "Calls, transcripts, users, CRM activity, forecasts, and revenue intelligence.",
    baseUrl: "https://api.gong.io/v2",
    icon: favicon("gong.io"),
    composio: { app: "gong" },
  },
  {
    id: "salesforce",
    name: "Salesforce",
    summary: "CRM records, accounts, contacts, opportunities, cases, and platform data.",
    baseUrl: "https://instance.my.salesforce.com/services/data",
    icon: favicon("salesforce.com"),
    featured: true,
    composio: { app: "salesforce" },
  },
  {
    id: "canvas",
    name: "Canvas LMS",
    summary: "Courses, assignments, submissions, users, enrollments, and education workflows.",
    baseUrl: "https://canvas.instructure.com/api/v1",
    icon: favicon("instructure.com"),
    composio: { app: "canvas" },
  },
  {
    id: "zendesk",
    name: "Zendesk",
    summary: "Tickets, users, organizations, help center content, and customer support.",
    baseUrl: "https://subdomain.zendesk.com/api/v2",
    icon: favicon("zendesk.com"),
    featured: true,
    composio: { app: "zendesk" },
  },
  {
    id: "discord",
    name: "Discord",
    summary: "Guilds, channels, messages, users, roles, and community operations.",
    baseUrl: "https://discord.com/api/v10",
    icon: favicon("discord.com"),
    composio: { app: "discord" },
  },
];

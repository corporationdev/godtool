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
  {
    id: "hubspot",
    name: "HubSpot",
    summary: "CRM records, companies, contacts, deals, tickets, and marketing data.",
    baseUrl: "https://api.hubapi.com",
    icon: "https://hubspot.com/favicon.ico",
    composio: { app: "hubspot" },
  },
  {
    id: "jira",
    name: "Jira",
    summary: "Issues, projects, workflows, and agile boards. Replace the base URL with your Atlassian site.",
    baseUrl: "https://your-domain.atlassian.net/rest/api/3",
    icon: "https://www.atlassian.com/favicon.ico",
    composio: { app: "jira" },
  },
  {
    id: "confluence",
    name: "Confluence",
    summary: "Pages, spaces, comments, and search. Replace the base URL with your Atlassian site.",
    baseUrl: "https://your-domain.atlassian.net/wiki/api/v2",
    icon: "https://www.atlassian.com/favicon.ico",
    composio: { app: "confluence" },
  },
  {
    id: "outlook",
    name: "Outlook",
    summary: "Mail, calendar, contacts, and Microsoft Graph user data.",
    baseUrl: "https://graph.microsoft.com/v1.0",
    icon: "https://outlook.live.com/favicon.ico",
    composio: { app: "outlook" },
  },
  {
    id: "clickup",
    name: "ClickUp",
    summary: "Tasks, lists, docs, comments, goals, and workspace workflows.",
    baseUrl: "https://api.clickup.com/api/v2",
    icon: "https://clickup.com/favicon.ico",
    composio: { app: "clickup" },
  },
  {
    id: "airtable",
    name: "Airtable",
    summary: "Bases, records, comments, schema metadata, and views.",
    baseUrl: "https://api.airtable.com",
    icon: "https://airtable.com/favicon.ico",
    composio: { app: "airtable" },
  },
  {
    id: "figma",
    name: "Figma",
    summary: "Files, comments, exports, variables, and design metadata.",
    baseUrl: "https://api.figma.com/v1",
    icon: "https://static.figma.com/app/icon/2/favicon.png",
    composio: { app: "figma" },
  },
  {
    id: "intercom",
    name: "Intercom",
    summary: "Contacts, conversations, tickets, help center content, and messaging.",
    baseUrl: "https://api.intercom.io",
    icon: "https://www.intercom.com/intercom-marketing-site/favicons/favicon-32x32.png",
    composio: { app: "intercom" },
  },
  {
    id: "shopify",
    name: "Shopify",
    summary: "Products, orders, inventory, and storefront admin data. Replace the base URL with your store domain.",
    baseUrl: "https://your-store.myshopify.com/admin/api/2025-01",
    icon: "https://www.shopify.com/favicon.ico",
  },
  {
    id: "attio",
    name: "Attio",
    summary: "People, companies, lists, notes, deals, and custom objects.",
    baseUrl: "https://api.attio.com/v2",
    icon: "https://attio.com/favicon.ico",
    composio: { app: "attio" },
  },
  {
    id: "calendly",
    name: "Calendly",
    summary: "Event types, scheduling links, invitees, and booked meetings.",
    baseUrl: "https://api.calendly.com",
    icon: "https://calendly.com/favicon.ico",
    composio: { app: "calendly" },
  },
  {
    id: "canva",
    name: "Canva",
    summary: "Designs, assets, comments, exports, and brand resources.",
    baseUrl: "https://api.canva.com/rest/v1",
    icon: "https://www.canva.com/favicon.ico",
    composio: { app: "canva" },
  },
  {
    id: "contentful",
    name: "Contentful",
    summary: "Spaces, entries, assets, content models, and environments.",
    baseUrl: "https://api.contentful.com",
    icon: "https://www.contentful.com/favicon.ico",
    composio: { app: "contentful" },
  },
  {
    id: "todoist",
    name: "Todoist",
    summary: "Tasks, projects, sections, comments, labels, and productivity workflows.",
    baseUrl: "https://api.todoist.com/rest/v2",
    icon: "https://todoist.com/favicon.ico",
    composio: { app: "todoist" },
  },
  {
    id: "zoom",
    name: "Zoom",
    summary: "Meetings, webinars, recordings, whiteboards, and user settings.",
    baseUrl: "https://api.zoom.us/v2",
    icon: "https://zoom.us/favicon.ico",
    composio: { app: "zoom" },
  },
  {
    id: "trello",
    name: "Trello",
    summary: "Boards, cards, lists, comments, labels, and kanban workflows.",
    baseUrl: "https://api.trello.com/1",
    icon: "https://trello.com/favicon.ico",
    composio: { app: "trello" },
  },
  {
    id: "bitbucket",
    name: "Bitbucket",
    summary: "Repositories, pull requests, issues, pipelines, and workspaces.",
    baseUrl: "https://api.bitbucket.org/2.0",
    icon: "https://bitbucket.org/favicon.ico",
    composio: { app: "bitbucket" },
  },
  {
    id: "box",
    name: "Box",
    summary: "Files, folders, comments, uploads, metadata, and enterprise content.",
    baseUrl: "https://api.box.com/2.0",
    icon: "https://box.com/favicon.ico",
    composio: { app: "box" },
  },
  {
    id: "onedrive",
    name: "OneDrive",
    summary: "Drive items, folders, sharing links, and Microsoft file storage.",
    baseUrl: "https://graph.microsoft.com/v1.0",
    icon: "https://onedrive.live.com/favicon.ico",
    composio: { app: "one_drive" },
  },
  {
    id: "discord",
    name: "Discord",
    summary: "User identity, guilds, connections, and Discord API resources.",
    baseUrl: "https://discord.com/api/v10",
    icon: "https://discord.com/assets/favicon.ico",
    composio: { app: "discord" },
  },
];

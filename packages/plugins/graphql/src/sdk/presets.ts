export interface GraphqlPresetComposio {
  readonly app: string;
  readonly authConfigId?: string;
}

export interface GraphqlPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly url: string;
  readonly icon?: string;
  readonly featured?: boolean;
  readonly composio?: GraphqlPresetComposio;
}

export const graphqlPresets: readonly GraphqlPreset[] = [
  {
    id: "github-graphql",
    name: "GitHub GraphQL",
    summary: "Repos, issues, pull requests, actions, and users.",
    url: "https://api.github.com/graphql",
    icon: "https://github.com/favicon.ico",
    featured: true,
    composio: { app: "github" },
  },
  {
    id: "gitlab",
    name: "GitLab",
    summary: "Projects, merge requests, pipelines, and users.",
    url: "https://gitlab.com/api/graphql",
    icon: "https://gitlab.com/favicon.ico",
    featured: true,
    composio: { app: "gitlab" },
  },
  {
    id: "linear",
    name: "Linear",
    summary: "Issues, projects, teams, and cycles.",
    url: "https://api.linear.app/graphql",
    icon: "https://linear.app/favicon.ico",
    featured: true,
    composio: { app: "linear" },
  },
  {
    id: "monday",
    name: "Monday.com",
    summary: "Boards, items, columns, and workspace automation.",
    url: "https://api.monday.com/v2",
    icon: "https://monday.com/favicon.ico",
    composio: { app: "monday" },
  },
];

<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into GOD TOOL. Changes were made across the `apps/local` app and `packages/react` shared package. The `PostHogProvider` was added to the TanStack Router root route, a Vite reverse proxy routes PostHog traffic through `/ingest`, and eight business-critical events were instrumented across five files covering the full source management lifecycle.

**Important:** Run `bun install` in the repo root to install the `posthog-js` package (added to both `packages/react/package.json` and `apps/local/package.json`).

| Event | Description | File |
|---|---|---|
| `source_url_detected` | User pasted a URL and auto-detection successfully identified the source type | `packages/react/src/pages/sources.tsx` |
| `source_detect_failed` | URL detection was attempted but failed (reason: `no_results`, `no_plugin`, or `error`) | `packages/react/src/pages/sources.tsx` |
| `source_added` | User successfully completed adding a new source (properties: `plugin_key`, `source_id`, `via_preset`, `via_url`) | `packages/react/src/pages/sources-add.tsx` |
| `source_deleted` | User deleted an existing source (properties: `source_id`, `kind`, `tool_count`) | `packages/react/src/pages/source-detail.tsx` |
| `source_refreshed` | User triggered a manual refresh of a source's tool list | `packages/react/src/pages/source-detail.tsx` |
| `tool_selected` | User selected a tool within a source to view its details | `packages/react/src/pages/source-detail.tsx` |
| `connection_removed` | User removed an OAuth connection (properties: `provider`, `kind`) | `packages/react/src/pages/connections.tsx` |
| `update_command_copied` | User copied the CLI update command from the sidebar banner | `apps/local/src/web/shell.tsx` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard**: [Analytics basics](https://us.posthog.com/project/394847/dashboard/1504072)
- **Sources added over time** (line chart): [https://us.posthog.com/project/394847/insights/NTLhLGCg](https://us.posthog.com/project/394847/insights/NTLhLGCg)
- **Source add funnel: URL detect → Source added** (funnel): [https://us.posthog.com/project/394847/insights/CYWCBR1O](https://us.posthog.com/project/394847/insights/CYWCBR1O)
- **Source detection failures by reason** (bar chart): [https://us.posthog.com/project/394847/insights/vqiOpa9c](https://us.posthog.com/project/394847/insights/vqiOpa9c)
- **Sources added by plugin type** (bar chart): [https://us.posthog.com/project/394847/insights/Q2mwSuYt](https://us.posthog.com/project/394847/insights/Q2mwSuYt)
- **Source churn: deletions vs additions** (line chart): [https://us.posthog.com/project/394847/insights/drcip9eG](https://us.posthog.com/project/394847/insights/drcip9eG)

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>

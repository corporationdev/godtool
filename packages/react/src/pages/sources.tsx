import { Suspense, useState, useCallback, useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Result, useAtomSet } from "@effect-atom/atom-react";
import { detectSource } from "../api/atoms";
import { useSourcesWithPending } from "../api/optimistic";
import { useScope } from "../hooks/use-scope";
import type { SourcePlugin, SourcePreset } from "../plugins/source-plugin";
import type { AccountAuthState } from "../components/account-menu";
import { McpInstallCard } from "../components/mcp-install-card";
import { Button } from "../components/button";
import { Badge } from "../components/badge";
import { Input } from "../components/input";
import {
  CardStack,
  CardStackHeader,
  CardStackContent,
  CardStackEntry,
  CardStackEntryField,
  CardStackEntryMedia,
  CardStackEntryContent,
  CardStackEntryTitle,
  CardStackEntryDescription,
  CardStackEntryActions,
} from "../components/card-stack";
import { SourceFavicon } from "../components/source-favicon";
import { Skeleton } from "../components/skeleton";

const KIND_TO_PLUGIN_KEY: Record<string, string> = {
  openapi: "openapi",
  mcp: "mcp",
  graphql: "graphql",
  googleDiscovery: "googleDiscovery",
  computer_use: "computer_use",
  browser_use: "browser",
};

const isConnectedSource = (source: { id: string; runtime?: boolean }) =>
  !source.runtime || source.id === "browser_use";

const supportsUrlSourceDetection = (plugin: SourcePlugin) => plugin.key !== "computer_use";

function googleServiceFromUrl(url?: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "www.googleapis.com") {
      return parsed.pathname.match(/\/discovery\/v1\/apis\/([^/]+)/)?.[1] ?? null;
    }
    if (hostname.endsWith(".googleapis.com")) {
      return hostname.slice(0, -".googleapis.com".length);
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeSourceName(name: string) {
  return name
    .toLowerCase()
    .replace(/\s+api$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function findPresetIcon(source: { name: string; url?: string }, plugin?: SourcePlugin) {
  if (!plugin?.presets) return undefined;
  const service = googleServiceFromUrl(source.url);
  if (service) {
    const servicePreset = plugin.presets.find(
      (preset) => googleServiceFromUrl(preset.url) === service,
    );
    if (servicePreset?.icon) return servicePreset.icon;
  }

  const sourceName = normalizeSourceName(source.name);
  return plugin.presets.find((preset) => normalizeSourceName(preset.name) === sourceName)?.icon;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SourcesPage(props: {
  sourcePlugins: readonly SourcePlugin[];
  auth?: AccountAuthState;
  onSignIn?: () => void;
}) {
  const { sourcePlugins } = props;
  const urlSourcePlugins = useMemo(
    () => sourcePlugins.filter(supportsUrlSourceDetection),
    [sourcePlugins],
  );
  const [url, setUrl] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeId = useScope();
  const sources = useSourcesWithPending(scopeId);
  const doDetect = useAtomSet(detectSource, { mode: "promise" });
  const navigate = useNavigate();

  const handleDetect = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setDetecting(true);
    setError(null);
    try {
      const results = await doDetect({
        path: { scopeId },
        payload: { url: trimmed },
      });
      if (results.length === 0) {
        setError("Could not detect a source type from this URL. Try adding manually.");
        setDetecting(false);
        return;
      }
      const pluginKey = KIND_TO_PLUGIN_KEY[results[0].kind];
      if (pluginKey) {
        void navigate({
          to: "/sources/add/$pluginKey",
          params: { pluginKey },
          search: { url: trimmed, namespace: results[0].namespace },
        });
      } else {
        setError(`Detected source type "${results[0].kind}" but no plugin is available for it.`);
      }
    } catch {
      setError("Detection failed. Try adding a source manually.");
    } finally {
      setDetecting(false);
    }
  }, [url, doDetect, navigate, scopeId]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-end justify-between">
            <div>
              <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
                Sources
              </h1>
              <p className="mt-1.5 text-[14px] text-muted-foreground">
                Tool providers available in this workspace.
              </p>
            </div>
          </div>

          {/* URL detection input */}
          <div className="mt-5">
            <CardStack>
              <CardStackContent>
                <CardStackEntryField
                  label="Paste URL"
                  description="auto-detect source type"
                  hint={error ?? undefined}
                >
                  <div className="flex gap-2">
                    <Input
                      type="url"
                      value={url}
                      onChange={(e) => {
                        setUrl((e.target as HTMLInputElement).value);
                        setError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleDetect();
                      }}
                      placeholder="https://..."
                      disabled={detecting}
                      className="flex-1"
                    />
                    <Button onClick={handleDetect} disabled={detecting || !url.trim()}>
                      {detecting ? "Detecting..." : "Detect"}
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    Or add manually:{" "}
                    {urlSourcePlugins.map((p) => (
                      <Link
                        key={p.key}
                        to="/sources/add/$pluginKey"
                        params={{ pluginKey: p.key }}
                        className="rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-muted"
                      >
                        {p.label}
                      </Link>
                    ))}
                  </div>
                </CardStackEntryField>
              </CardStackContent>
            </CardStack>
          </div>
        </div>

        <div className="mb-8">
          <McpInstallCard auth={props.auth} onSignIn={props.onSignIn} />
        </div>

        {Result.match(sources, {
          onInitial: () => <SourcesGridSkeleton />,
          onFailure: () => <p className="text-sm text-destructive">Failed to load sources</p>,
          onSuccess: ({ value }) => {
            const connectedSources = value.filter(isConnectedSource);

            return value.length === 0 ? (
              <div className="mb-8 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground mb-4">
                  <svg viewBox="0 0 24 24" fill="none" className="size-5">
                    <path
                      d="M12 6v12M6 12h12"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
                <p className="text-[14px] font-medium text-foreground/70 mb-1">No sources yet</p>
                <p className="text-[13px] text-muted-foreground/60 mb-5">
                  Add a source to get started.
                </p>
              </div>
            ) : (
              <div className="mb-8 space-y-8">
                {connectedSources.length > 0 && (
                  <section className="space-y-3">
                    <SourceGrid sources={connectedSources} sourcePlugins={sourcePlugins} />
                  </section>
                )}
              </div>
            );
          },
        })}

        <div className="mb-8 border-t border-border/50" />

        {Result.match(sources, {
          onInitial: () => <PresetGrid plugins={sourcePlugins} />,
          onFailure: () => <PresetGrid plugins={sourcePlugins} />,
          onSuccess: ({ value }) => (
            <PresetGrid
              plugins={sourcePlugins}
              connectedSources={value.filter(isConnectedSource)}
            />
          ),
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset grid
// ---------------------------------------------------------------------------

type PresetEntry = {
  preset: SourcePreset;
  pluginKey: string;
  pluginLabel: string;
};

const TOP_PRESET_ORDER = [
  "computer_use:computer_use",
  "openapi:github-rest",
  "googleDiscovery:google-gmail",
  "raw:slack",
  "googleDiscovery:google-drive",
  "raw:notion",
  "googleDiscovery:google-sheets",
  "raw:hubspot",
  "openapi:microsoft-outlook",
  "googleDiscovery:google-calendar",
  "openapi:jira-cloud",
  "graphql:linear",
  "raw:salesforce",
  "openapi:microsoft-teams",
  "openapi:stripe",
  "raw:supabase",
  "openapi:figma",
  "raw:airtable",
  "graphql:gitlab",
  "openapi:asana",
  "openapi:intercom",
] as const;

const TOP_PRESET_RANK = new Map<string, number>(TOP_PRESET_ORDER.map((key, index) => [key, index]));

function PresetGrid(props: {
  plugins: readonly SourcePlugin[];
  connectedSources?: readonly { id: string; kind: string }[];
}) {
  const connectedSourceIds = useMemo(
    () => new Set((props.connectedSources ?? []).map((source) => source.id)),
    [props.connectedSources],
  );
  const allPresets = useMemo(() => {
    const entries: PresetEntry[] = [];
    for (const plugin of props.plugins) {
      for (const preset of plugin.presets ?? []) {
        if (plugin.key === "computer_use" && connectedSourceIds.has(preset.id)) continue;
        entries.push({
          preset,
          pluginKey: plugin.key,
          pluginLabel: plugin.label,
        });
      }
    }
    return entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const aRank = TOP_PRESET_RANK.get(`${a.entry.pluginKey}:${a.entry.preset.id}`);
        const bRank = TOP_PRESET_RANK.get(`${b.entry.pluginKey}:${b.entry.preset.id}`);
        if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
        if (aRank !== undefined) return -1;
        if (bRank !== undefined) return 1;
        return a.index - b.index;
      })
      .map(({ entry }) => entry);
  }, [connectedSourceIds, props.plugins]);

  if (allPresets.length === 0) return null;

  return (
    <section className="mb-8 space-y-3">
      <CardStack searchable>
        <CardStackHeader>Popular sources</CardStackHeader>
        <CardStackContent>
          {allPresets.map(({ preset, pluginKey, pluginLabel }) => {
            const search: Record<string, string> = { preset: preset.id };
            if (preset.url) search.url = preset.url;
            return (
              <CardStackEntry
                key={`${pluginKey}-${preset.id}`}
                asChild
                searchText={`${preset.name} ${preset.summary ?? ""} ${pluginLabel}`}
              >
                <Link to="/sources/add/$pluginKey" params={{ pluginKey }} search={search}>
                  <CardStackEntryMedia>
                    {preset.icon ? (
                      <img
                        src={preset.icon}
                        alt=""
                        className="size-5 object-contain"
                        loading="lazy"
                      />
                    ) : (
                      <svg viewBox="0 0 16 16" className="size-3.5" fill="none">
                        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
                      </svg>
                    )}
                  </CardStackEntryMedia>
                  <CardStackEntryContent>
                    <CardStackEntryTitle>{preset.name}</CardStackEntryTitle>
                    <CardStackEntryDescription>{preset.summary}</CardStackEntryDescription>
                  </CardStackEntryContent>
                  <CardStackEntryActions>
                    <Badge variant="secondary">{pluginLabel}</Badge>
                  </CardStackEntryActions>
                </Link>
              </CardStackEntry>
            );
          })}
        </CardStackContent>
      </CardStack>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Source grid
// ---------------------------------------------------------------------------

function SourceGrid(props: {
  sources: readonly {
    id: string;
    name: string;
    kind: string;
    url?: string;
    runtime?: boolean;
  }[];
  sourcePlugins: readonly SourcePlugin[];
}) {
  const pluginByKind = useMemo(() => {
    const out = new Map<string, SourcePlugin>();
    for (const p of props.sourcePlugins) out.set(p.key, p);
    return out;
  }, [props.sourcePlugins]);

  return (
    <CardStack searchable>
      <CardStackHeader>Connected</CardStackHeader>
      <CardStackContent>
        {props.sources.map((s) => {
          const pluginKey = KIND_TO_PLUGIN_KEY[s.kind] ?? s.kind;
          const plugin = pluginByKind.get(pluginKey);
          const iconUrl = findPresetIcon(s, plugin);
          const SummaryComponent = plugin?.summary;
          return (
            <CardStackEntry key={s.id} asChild searchText={`${s.name} ${s.id} ${s.kind}`}>
              <Link to="/sources/$namespace" params={{ namespace: s.id }}>
                <CardStackEntryMedia>
                  <SourceFavicon
                    url={s.url}
                    iconUrl={iconUrl}
                    size={32}
                    sourceId={s.id}
                    kind={s.kind}
                  />
                </CardStackEntryMedia>
                <CardStackEntryContent>
                  <CardStackEntryTitle>{s.name}</CardStackEntryTitle>
                  <CardStackEntryDescription>{s.id}</CardStackEntryDescription>
                </CardStackEntryContent>
                <CardStackEntryActions>
                  {SummaryComponent && (
                    <Suspense fallback={null}>
                      <SummaryComponent sourceId={s.id} />
                    </Suspense>
                  )}
                  <Badge variant="secondary">{s.kind}</Badge>
                </CardStackEntryActions>
              </Link>
            </CardStackEntry>
          );
        })}
      </CardStackContent>
    </CardStack>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function SourcesGridSkeleton() {
  return (
    <CardStack>
      <CardStackContent>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-8 shrink-0 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-4" style={{ width: `${40 + ((i * 11) % 30)}%` }} />
              <Skeleton className="h-3" style={{ width: `${25 + ((i * 7) % 20)}%` }} />
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </CardStackContent>
    </CardStack>
  );
}

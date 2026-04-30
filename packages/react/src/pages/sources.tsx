import { Suspense, useEffect, useState, useCallback, useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Result, useAtomSet } from "@effect-atom/atom-react";
import { detectSource } from "../api/atoms";
import { useSourcesWithPending } from "../api/optimistic";
import { useScope } from "../hooks/use-scope";
import type { SourcePlugin, SourcePreset } from "../plugins/source-plugin";
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

type CatalogSource = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly pluginId?: string;
  readonly toolCount?: number;
  readonly localAvailable?: boolean;
};

type SourceAvailability = "local" | "cloud" | "both";

type DisplaySource = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly url?: string;
  readonly runtime?: boolean;
  readonly pluginId?: string;
  readonly toolCount?: number;
  readonly availability?: SourceAvailability;
};

type OverlaySource = DisplaySource & {
  readonly availability: SourceAvailability;
};

const mergeAvailability = (
  current: SourceAvailability | undefined,
  next: SourceAvailability,
): SourceAvailability => {
  if (!current || current === next) return next;
  if (current === "both" || next === "both") return "both";
  return "both";
};

const useCatalogSources = (endpoint: string | undefined) => {
  const [sources, setSources] = useState<readonly CatalogSource[]>([]);

  useEffect(() => {
    if (!endpoint) {
      setSources([]);
      return;
    }

    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(endpoint, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`Catalog failed: ${response.status}`);
        const data = (await response.json()) as { readonly sources?: readonly CatalogSource[] };
        if (alive) setSources(data.sources ?? []);
      } catch {
        if (alive) setSources([]);
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [endpoint]);

  return sources;
};

const mergeDisplaySources = (
  baseSources: readonly DisplaySource[],
  catalogSources: readonly CatalogSource[],
  baseSourceAvailability: SourceAvailability | undefined,
  overlaySources: readonly OverlaySource[],
): readonly DisplaySource[] => {
  const remote = baseSources.filter(isConnectedSource);
  const byId = new Map<string, DisplaySource>();
  for (const source of remote) {
    byId.set(source.id, { ...source, availability: baseSourceAvailability });
  }

  for (const source of overlaySources) {
    const existing = byId.get(source.id);
    if (existing) {
      byId.set(source.id, {
        ...source,
        ...existing,
        pluginId: existing.pluginId ?? source.pluginId,
        toolCount: existing.toolCount ?? source.toolCount,
        availability: mergeAvailability(existing.availability, source.availability),
      });
      continue;
    }

    byId.set(source.id, source);
  }

  for (const source of catalogSources) {
    const existing = byId.get(source.id);
    if (existing) {
      byId.set(source.id, {
        ...existing,
        name: existing.name || source.name,
        kind: existing.kind || source.kind,
        pluginId: existing.pluginId ?? source.pluginId,
        toolCount: source.toolCount ?? existing.toolCount,
        availability: mergeAvailability(existing.availability, "local"),
      });
      continue;
    }

    byId.set(source.id, {
      id: source.id,
      name: source.name,
      kind: source.kind,
      pluginId: source.pluginId,
      toolCount: source.toolCount,
      availability: "local",
      runtime: false,
    });
  }

  return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id));
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SourcesPage(props: {
  sourcePlugins: readonly SourcePlugin[];
  catalogEndpoint?: string;
  baseSourceAvailability?: SourceAvailability;
  overlaySources?: readonly OverlaySource[];
  linkableSourceAvailabilities?: readonly SourceAvailability[];
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
  const catalogSources = useCatalogSources(props.catalogEndpoint);
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
          <McpInstallCard />
        </div>

        {Result.match(sources, {
          onInitial: () => <SourcesGridSkeleton />,
          onFailure: () => <p className="text-sm text-destructive">Failed to load sources</p>,
          onSuccess: ({ value }) => {
            const connectedSources = mergeDisplaySources(
              value,
              catalogSources,
              props.baseSourceAvailability,
              props.overlaySources ?? [],
            );

            return connectedSources.length === 0 ? (
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
                    <SourceGrid
                      sources={connectedSources}
                      sourcePlugins={sourcePlugins}
                      linkableSourceAvailabilities={props.linkableSourceAvailabilities}
                    />
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
              connectedSources={mergeDisplaySources(
                value,
                catalogSources,
                props.baseSourceAvailability,
                props.overlaySources ?? [],
              )}
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
    return entries;
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
  sources: readonly DisplaySource[];
  sourcePlugins: readonly SourcePlugin[];
  linkableSourceAvailabilities?: readonly SourceAvailability[];
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
          const SummaryComponent = plugin?.summary;
          const linkableAvailabilities = props.linkableSourceAvailabilities ?? ["cloud", "both"];
          const isLinkable = s.availability
            ? linkableAvailabilities.includes(s.availability)
            : true;
          const content = (
            <>
              <CardStackEntryMedia>
                <SourceFavicon url={s.url} size={32} sourceId={s.id} kind={s.kind} />
              </CardStackEntryMedia>
              <CardStackEntryContent>
                <CardStackEntryTitle>{s.name}</CardStackEntryTitle>
                <CardStackEntryDescription>{s.id}</CardStackEntryDescription>
              </CardStackEntryContent>
              <CardStackEntryActions>
                {SummaryComponent && isLinkable && (
                  <Suspense fallback={null}>
                    <SummaryComponent sourceId={s.id} />
                  </Suspense>
                )}
                {s.availability && <AvailabilityBadge availability={s.availability} />}
                <Badge variant="secondary">{s.kind}</Badge>
              </CardStackEntryActions>
            </>
          );

          return (
            <CardStackEntry
              key={s.id}
              asChild={isLinkable}
              searchText={`${s.name} ${s.id} ${s.kind}`}
            >
              {isLinkable ? (
                <Link to="/sources/$namespace" params={{ namespace: s.id }}>
                  {content}
                </Link>
              ) : (
                content
              )}
            </CardStackEntry>
          );
        })}
      </CardStackContent>
    </CardStack>
  );
}

function AvailabilityBadge(props: { availability: SourceAvailability }) {
  const label =
    props.availability === "both" ? "Both" : props.availability === "local" ? "Local" : "Cloud";
  return <Badge variant={props.availability === "both" ? "default" : "outline"}>{label}</Badge>;
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArchiveIcon, PlusIcon } from "lucide-react";

import { Button } from "../components/button";
import { Badge } from "../components/badge";
import { Input } from "../components/input";

interface BrowserSessionSnapshot {
  readonly id: string;
  readonly sessionName: string;
  readonly url: string;
  readonly title: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly isLoading: boolean;
  readonly pinned: boolean;
  readonly visible: boolean;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly targetId: string | null;
  readonly cdpUrl: string;
  readonly webSocketDebuggerUrl: string | null;
}

interface BrowserBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface BrowserApi {
  readonly list: () => Promise<readonly BrowserSessionSnapshot[]>;
  readonly ensure: (input: {
    readonly callerId?: string;
    readonly sessionName?: string;
    readonly url?: string;
    readonly pinned?: boolean;
  }) => Promise<BrowserSessionSnapshot>;
  readonly activateViewport: () => Promise<boolean>;
  readonly deactivateViewport: () => Promise<boolean>;
  readonly show: (sessionId: string, bounds: BrowserBounds) => Promise<BrowserSessionSnapshot>;
  readonly setBounds: (sessionId: string, bounds: BrowserBounds) => Promise<BrowserSessionSnapshot>;
  readonly hide: (sessionId: string) => Promise<BrowserSessionSnapshot>;
  readonly rename: (sessionId: string, sessionName: string) => Promise<BrowserSessionSnapshot>;
  readonly navigate: (sessionId: string, url: string) => Promise<BrowserSessionSnapshot>;
  readonly back: (sessionId: string) => Promise<BrowserSessionSnapshot>;
  readonly forward: (sessionId: string) => Promise<BrowserSessionSnapshot>;
  readonly reload: (sessionId: string) => Promise<BrowserSessionSnapshot>;
  readonly touch: (
    sessionId: string,
    input: { readonly pinned?: boolean },
  ) => Promise<BrowserSessionSnapshot>;
  readonly close: (sessionId: string) => Promise<boolean>;
  readonly clearBrowserData: () => Promise<boolean>;
  readonly onChanged?: (
    listener: (sessions: readonly BrowserSessionSnapshot[]) => void,
  ) => () => void;
}

const FALLBACK_HOST_URL = "http://127.0.0.1:14789";

const createHttpBrowserApi = (): BrowserApi => {
  const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${FALLBACK_HOST_URL}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init?.headers,
      },
    });
    const data = (await response.json()) as T & { readonly error?: string };
    if (!response.ok)
      throw new Error(data.error ?? `Browser host request failed: ${response.status}`);
    return data;
  };

  return {
    list: async () =>
      (await request<{ readonly sessions: readonly BrowserSessionSnapshot[] }>("/sessions"))
        .sessions,
    ensure: async (input) =>
      (
        await request<{ readonly session: BrowserSessionSnapshot }>("/sessions/ensure", {
          method: "POST",
          body: JSON.stringify(input),
        })
      ).session,
    activateViewport: async () =>
      (
        await request<{ readonly ok: boolean }>("/viewport/activate", {
          method: "POST",
          body: "{}",
        })
      ).ok,
    deactivateViewport: async () =>
      (
        await request<{ readonly ok: boolean }>("/viewport/deactivate", {
          method: "POST",
          body: "{}",
        })
      ).ok,
    show: async (sessionId, bounds) =>
      (
        await request<{ readonly session: BrowserSessionSnapshot }>(
          `/sessions/${encodeURIComponent(sessionId)}/show`,
          { method: "POST", body: JSON.stringify({ bounds }) },
        )
      ).session,
    setBounds: async (sessionId, bounds) =>
      (
        await request<{ readonly session: BrowserSessionSnapshot }>(
          `/sessions/${encodeURIComponent(sessionId)}/bounds`,
          { method: "POST", body: JSON.stringify({ bounds }) },
        )
      ).session,
    hide: async (sessionId) =>
      (
        await request<{ readonly session: BrowserSessionSnapshot }>(
          `/sessions/${encodeURIComponent(sessionId)}/hide`,
          { method: "POST", body: "{}" },
        )
      ).session,
    rename: async (sessionId, sessionName) =>
      (
        await request<{ readonly session: BrowserSessionSnapshot }>(
          `/sessions/${encodeURIComponent(sessionId)}/rename`,
          { method: "POST", body: JSON.stringify({ sessionName }) },
        )
      ).session,
    navigate: async (sessionId, url) =>
      (
        await request<{ readonly session: BrowserSessionSnapshot }>(
          `/sessions/${encodeURIComponent(sessionId)}/navigate`,
          { method: "POST", body: JSON.stringify({ url }) },
        )
      ).session,
    back: async (sessionId) =>
      (
        await request<{ readonly session: BrowserSessionSnapshot }>(
          `/sessions/${encodeURIComponent(sessionId)}/back`,
          { method: "POST", body: "{}" },
        )
      ).session,
    forward: async (sessionId) =>
      (
        await request<{ readonly session: BrowserSessionSnapshot }>(
          `/sessions/${encodeURIComponent(sessionId)}/forward`,
          { method: "POST", body: "{}" },
        )
      ).session,
    reload: async (sessionId) =>
      (
        await request<{ readonly session: BrowserSessionSnapshot }>(
          `/sessions/${encodeURIComponent(sessionId)}/reload`,
          { method: "POST", body: "{}" },
        )
      ).session,
    touch: async (sessionId, input) =>
      (
        await request<{ readonly session: BrowserSessionSnapshot }>(
          `/sessions/${encodeURIComponent(sessionId)}/touch`,
          { method: "POST", body: JSON.stringify(input) },
        )
      ).session,
    close: async (sessionId) =>
      (
        await request<{ readonly ok: boolean }>(
          `/sessions/${encodeURIComponent(sessionId)}/close`,
          {
            method: "POST",
            body: "{}",
          },
        )
      ).ok,
    clearBrowserData: async () =>
      (
        await request<{ readonly ok: boolean }>("/browser-data/clear", {
          method: "POST",
          body: "{}",
        })
      ).ok,
  };
};

const getBrowserApi = (): BrowserApi => {
  const electronApi = window as Window & {
    readonly electronAPI?: { readonly browsers?: BrowserApi };
  };
  return electronApi.electronAPI?.browsers ?? createHttpBrowserApi();
};

const formatAge = (time: number): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
};

const AGENT_ACTIVE_WINDOW_MS = 30_000;

const isRecentlyUsedByAgent = (session: BrowserSessionSnapshot, now: number): boolean =>
  now - session.lastUsedAt < AGENT_ACTIVE_WINDOW_MS;

const boundsForElement = (element: HTMLElement): BrowserBounds => {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
};

const nextBrowserSessionName = (sessions: readonly BrowserSessionSnapshot[]): string => {
  const existing = new Set(sessions.map((session) => session.sessionName));
  for (let index = sessions.length + 1; ; index += 1) {
    const candidate = `browser-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
};

export function BrowsersPage() {
  const api = useMemo(getBrowserApi, []);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const [sessions, setSessions] = useState<readonly BrowserSessionSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const selected = sessions.find((session) => session.id === selectedId) ?? null;
  const activeCount = sessions.filter((session) => isRecentlyUsedByAgent(session, now)).length;

  const refresh = useCallback(async () => {
    try {
      setSessions(await api.list());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api]);

  const syncBounds = useCallback(async () => {
    if (!selectedId || !viewportRef.current) return;
    await api.setBounds(selectedId, boundsForElement(viewportRef.current));
  }, [api, selectedId]);

  const showSession = useCallback(
    async (sessionId: string) => {
      if (!viewportRef.current) return;
      setSelectedId(sessionId);
      await api.activateViewport();
      const bounds = boundsForElement(viewportRef.current);
      const session = await api.show(sessionId, bounds);
      setSelectedId(session.id);
      await refresh();
    },
    [api, refresh],
  );

  const startNewBrowser = useCallback(async () => {
    const previousSelectedId = selectedId;
    setSelectedId(null);
    setAddress("");
    if (previousSelectedId) {
      try {
        await api.hide(previousSelectedId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    requestAnimationFrame(() => addressInputRef.current?.focus());
  }, [api, selectedId]);

  const navigateSelected = useCallback(async () => {
    const target = address.trim();
    if (!target) return;
    try {
      setLoading(true);
      const sessionId =
        selectedId ??
        (
          await api.ensure({
            callerId: "godtool-browsers-page",
            sessionName: nextBrowserSessionName(sessions),
          })
        ).id;
      if (!selectedId) {
        setSelectedId(sessionId);
        await refresh();
        await showSession(sessionId);
      }
      const session = await api.navigate(sessionId, target);
      setAddress(session.url);
      await refresh();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [address, api, refresh, selectedId, sessions, showSession]);

  const runNavigationAction = useCallback(
    async (action: "back" | "forward" | "reload") => {
      if (!selectedId) return;
      try {
        const session = await api[action](selectedId);
        setAddress(session.url);
        await refresh();
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api, refresh, selectedId],
  );

  const archiveSession = useCallback(
    async (sessionId: string) => {
      const archivedSession = sessions.find((session) => session.id === sessionId);
      setSessions((current) => current.filter((session) => session.id !== sessionId));
      if (selectedId === sessionId) {
        setSelectedId(null);
        setAddress("");
      }
      try {
        await api.close(sessionId);
        await refresh();
        setError(null);
      } catch (cause) {
        if (archivedSession) {
          setSessions((current) =>
            current.some((session) => session.id === archivedSession.id)
              ? current
              : [archivedSession, ...current],
          );
        }
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api, refresh, selectedId, sessions],
  );

  useEffect(() => {
    void refresh();
    return api.onChanged?.((next) => setSessions(next));
  }, [api, refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    void api.activateViewport();
    return () => {
      void api.deactivateViewport();
    };
  }, [api]);

  useEffect(() => {
    if (!selected) {
      setAddress("");
      return;
    }
    setAddress(selected.url);
  }, [selected?.id, selected?.url]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !selectedId) return;
    const observer = new ResizeObserver(() => void syncBounds());
    observer.observe(element);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);
    void syncBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);
    };
  }, [selectedId, syncBounds]);

  useEffect(() => {
    return () => {
      if (selectedId) void api.hide(selectedId);
    };
  }, [api, selectedId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto border-b border-border md:border-r md:border-b-0">
          <div className="sticky top-0 z-10 flex h-12 items-center justify-between gap-3 border-b border-border bg-background px-4">
            <div className="flex min-w-0 items-baseline gap-2">
              <h1 className="truncate text-sm font-semibold tracking-normal">Browsers</h1>
              <p className="shrink-0 text-xs text-muted-foreground">{activeCount} active</p>
            </div>
            <button
              type="button"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              aria-label="New browser"
              onClick={() => void startNewBrowser()}
            >
              <PlusIcon aria-hidden className="size-4" />
            </button>
          </div>
          {sessions.length === 0 ? (
            <div className="p-5 text-sm text-muted-foreground">No browser sessions yet.</div>
          ) : (
            <div className="flex flex-col">
              {sessions.map((session) => {
                const active = isRecentlyUsedByAgent(session, now);
	                return (
	                  <div key={session.id} className="group relative border-b border-border">
	                    <button
	                      type="button"
	                      onClick={() => void showSession(session.id)}
	                      aria-current={selectedId === session.id ? "page" : undefined}
	                      className={[
	                        "relative w-full cursor-pointer px-4 py-3 pr-12 text-left transition-colors hover:bg-accent/40",
	                        selectedId === session.id
	                          ? "bg-accent/60 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"
	                          : "bg-background",
	                      ].join(" ")}
	                    >
	                      <div className="flex items-center justify-between gap-2">
	                        <span className="truncate text-sm font-medium">{session.sessionName}</span>
	                        {active ? (
	                          <Badge variant="secondary" className="shrink-0">
	                            Active
	                          </Badge>
	                        ) : null}
	                      </div>
	                      <p className="mt-1 truncate text-xs text-muted-foreground">
	                        {session.title || session.url || session.id}
	                      </p>
	                      <div className="mt-2 text-xs text-muted-foreground">
	                        <span>Used {formatAge(session.lastUsedAt)}</span>
	                      </div>
	                    </button>
	                    <button
	                      type="button"
	                      aria-label={`Archive ${session.sessionName}`}
	                      onClick={() => void archiveSession(session.id)}
	                      className="absolute top-3 right-3 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors transition-opacity hover:bg-background/80 hover:text-foreground hover:opacity-100 focus-visible:bg-background/80 focus-visible:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none group-hover:opacity-100"
	                    >
	                      <ArchiveIcon aria-hidden className="size-4" />
	                    </button>
	                  </div>
	                );
	              })}
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3">
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Back"
                disabled={!selected?.canGoBack}
                onClick={() => void runNavigationAction("back")}
              >
                <svg viewBox="0 0 16 16" className="size-4">
                  <path
                    d="M10 3L5 8l5 5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Forward"
                disabled={!selected?.canGoForward}
                onClick={() => void runNavigationAction("forward")}
              >
                <svg viewBox="0 0 16 16" className="size-4">
                  <path
                    d="M6 3l5 5-5 5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Reload"
                disabled={!selected}
                onClick={() => void runNavigationAction("reload")}
              >
                <svg viewBox="0 0 16 16" className="size-4">
                  <path
                    d="M12.5 5.2A5 5 0 1 0 13 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                  />
                  <path
                    d="M12.5 2.5v2.9h-2.9"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Button>
            </div>
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void navigateSelected();
              }}
            >
              <div className="relative min-w-0 flex-1">
                <Input
                  ref={addressInputRef}
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  className="h-8 rounded-md border-border/70 bg-background pr-8 font-mono text-xs"
                  placeholder="Search or enter address"
                />
                {selected?.isLoading && (
                  <span className="absolute top-1/2 right-2 size-3 -translate-y-1/2 animate-spin rounded-full border border-muted-foreground/40 border-t-foreground" />
                )}
              </div>
              <Button
                type="submit"
                size="icon-sm"
                aria-label="Go"
                disabled={!address.trim() || loading}
              >
                <svg viewBox="0 0 16 16" className="size-3.5">
                  <path
                    d="M6 3l5 5-5 5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Button>
            </form>
          </div>
          <div className="min-h-0 flex-1">
            <div ref={viewportRef} className="h-full min-h-[360px] overflow-hidden bg-muted/30">
              {!selected && (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Browser view
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

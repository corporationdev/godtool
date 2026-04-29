import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon } from "lucide-react";

import { Button } from "../components/button";
import { Badge } from "../components/badge";
import { Input } from "../components/input";

interface BrowserSessionSnapshot {
  readonly id: string;
  readonly agentId: string;
  readonly url: string;
  readonly title: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly isLoading: boolean;
  readonly busy: boolean;
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
    readonly agentId: string;
    readonly url?: string;
    readonly busy?: boolean;
    readonly pinned?: boolean;
  }) => Promise<BrowserSessionSnapshot>;
  readonly activateViewport: () => Promise<boolean>;
  readonly deactivateViewport: () => Promise<boolean>;
  readonly show: (sessionId: string, bounds: BrowserBounds) => Promise<BrowserSessionSnapshot>;
  readonly setBounds: (sessionId: string, bounds: BrowserBounds) => Promise<BrowserSessionSnapshot>;
  readonly hide: (sessionId: string) => Promise<BrowserSessionSnapshot>;
  readonly navigate: (sessionId: string, url: string) => Promise<BrowserSessionSnapshot>;
  readonly back: (sessionId: string) => Promise<BrowserSessionSnapshot>;
  readonly forward: (sessionId: string) => Promise<BrowserSessionSnapshot>;
  readonly reload: (sessionId: string) => Promise<BrowserSessionSnapshot>;
  readonly touch: (
    sessionId: string,
    input: { readonly busy?: boolean; readonly pinned?: boolean },
  ) => Promise<BrowserSessionSnapshot>;
  readonly close: (sessionId: string) => Promise<boolean>;
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

const boundsForElement = (element: HTMLElement): BrowserBounds => {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
};

export function BrowsersPage() {
  const api = useMemo(getBrowserApi, []);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [sessions, setSessions] = useState<readonly BrowserSessionSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("agent-main");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const selected = sessions.find((session) => session.id === selectedId) ?? null;

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
      await api.activateViewport();
      const bounds = boundsForElement(viewportRef.current);
      await api.show(sessionId, bounds);
      setSelectedId(sessionId);
      await refresh();
    },
    [api, refresh],
  );

  const createSession = useCallback(async () => {
    setLoading(true);
    try {
      const session = await api.ensure({ agentId, busy: true });
      setSelectedId(session.id);
      await refresh();
      await showSession(session.id);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [agentId, api, refresh, showSession]);

  const closeSession = useCallback(
    async (sessionId: string) => {
      await api.close(sessionId);
      if (selectedId === sessionId) setSelectedId(null);
      await refresh();
    },
    [api, refresh, selectedId],
  );

  const navigateSelected = useCallback(async () => {
    if (!selectedId || !address.trim()) return;
    try {
      const session = await api.navigate(selectedId, address);
      setAddress(session.url);
      await refresh();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [address, api, refresh, selectedId]);

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

  useEffect(() => {
    void refresh();
    return api.onChanged?.((next) => setSessions(next));
  }, [api, refresh]);

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
      <div className="shrink-0 border-b border-border px-5 py-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="truncate text-base font-semibold tracking-normal">Browsers</h1>
            <p className="shrink-0 text-sm text-muted-foreground">
              {sessions.length} active session{sessions.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              className="h-8 w-44"
              placeholder="Agent id"
            />
            <Button
              type="button"
              size="icon-sm"
              aria-label="New browser"
              onClick={createSession}
              disabled={loading || !agentId.trim()}
            >
              <PlusIcon aria-hidden className="size-4" />
            </Button>
          </div>
        </div>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto border-b border-border md:border-r md:border-b-0">
          {sessions.length === 0 ? (
            <div className="p-5 text-sm text-muted-foreground">No browser sessions yet.</div>
          ) : (
            <div className="flex flex-col">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => void showSession(session.id)}
                  className={[
                    "border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/45",
                    selectedId === session.id ? "bg-muted/70" : "bg-background",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{session.agentId}</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {session.busy ? (
                        <Badge variant="secondary">in use</Badge>
                      ) : (
                        <Badge variant="outline">idle</Badge>
                      )}
                      {session.visible && <Badge>visible</Badge>}
                    </div>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {session.title || session.url || session.id}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>Used {formatAge(session.lastUsedAt)}</span>
                    <span className="truncate font-mono">
                      {session.targetId ?? "target pending"}
                    </span>
                  </div>
                </button>
              ))}
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
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  disabled={!selected}
                  className="h-8 rounded-md border-border/70 bg-background pr-8 font-mono text-xs"
                  placeholder="Search or enter address"
                />
                {selected?.isLoading && (
                  <span className="absolute top-1/2 right-2 size-3 -translate-y-1/2 animate-spin rounded-full border border-muted-foreground/40 border-t-foreground" />
                )}
              </div>
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={!selected || !address.trim()}
              >
                Go
              </Button>
            </form>
            {selected && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void closeSession(selected.id)}
              >
                Close
              </Button>
            )}
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

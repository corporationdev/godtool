import { BrowserWindow, WebContentsView, type WebContents } from "electron";

import type { BrowserBounds, BrowserSessionSnapshot, EnsureBrowserSessionInput } from "./types";

interface DevtoolsTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly title?: string;
  readonly webSocketDebuggerUrl?: string;
}

interface BrowserSessionState {
  readonly id: string;
  readonly agentId: string;
  readonly view: WebContentsView;
  readonly createdAt: number;
  readonly markerUrl: string;
  targetId: string | null;
  webSocketDebuggerUrl: string | null;
  lastUsedAt: number;
  busy: boolean;
  pinned: boolean;
  visible: boolean;
}

export interface BrowserSessionManagerOptions {
  readonly maxSessions: number;
  readonly debuggingPort: number;
  readonly hiddenWindow: BrowserWindow;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly onSessionsChanged?: () => void;
}

const DEFAULT_BOUNDS: BrowserBounds = {
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
};

const normalizeBounds = (bounds: BrowserBounds): BrowserBounds => ({
  x: Math.max(0, Math.round(bounds.x)),
  y: Math.max(0, Math.round(bounds.y)),
  width: Math.max(1, Math.round(bounds.width)),
  height: Math.max(1, Math.round(bounds.height)),
});

const normalizeNavigationUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "about:blank";
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return trimmed;
  if (trimmed.includes(".") || trimmed.startsWith("localhost")) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
};

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSessionState>();
  private visibleSessionId: string | null = null;
  private viewportActive = false;

  constructor(private readonly options: BrowserSessionManagerOptions) {}

  async ensure(input: EnsureBrowserSessionInput): Promise<BrowserSessionSnapshot> {
    const agentId = input.agentId.trim();
    if (!agentId) throw new Error("agentId is required");

    const existing = [...this.sessions.values()].find((session) => session.agentId === agentId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      existing.busy = input.busy ?? existing.busy;
      existing.pinned = input.pinned ?? existing.pinned;
      await this.refreshTarget(existing);
      this.emitChanged();
      return this.snapshot(existing);
    }

    await this.makeRoom();

    const id = `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const markerUrl = `about:blank#executor-browser-${encodeURIComponent(id)}`;
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const state: BrowserSessionState = {
      id,
      agentId,
      view,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      busy: input.busy ?? true,
      pinned: input.pinned ?? false,
      visible: false,
      markerUrl,
      targetId: null,
      webSocketDebuggerUrl: null,
    };

    this.sessions.set(id, state);
    this.attachToHidden(state);

    view.webContents.on("destroyed", () => {
      this.sessions.delete(id);
      if (this.visibleSessionId === id) this.visibleSessionId = null;
      this.emitChanged();
    });

    view.webContents.on("did-navigate", () => this.emitChanged());
    view.webContents.on("did-navigate-in-page", () => this.emitChanged());
    view.webContents.on("page-title-updated", () => this.emitChanged());
    view.webContents.on("did-start-loading", () => this.emitChanged());
    view.webContents.on("did-stop-loading", () => this.emitChanged());

    await view.webContents.loadURL(input.url ?? markerUrl);
    await this.refreshTarget(state);
    this.emitChanged();
    return this.snapshot(state);
  }

  list(): readonly BrowserSessionSnapshot[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      .map((session) => this.snapshot(session));
  }

  async touch(
    id: string,
    options?: { readonly busy?: boolean; readonly pinned?: boolean },
  ): Promise<BrowserSessionSnapshot> {
    const session = this.get(id);
    session.lastUsedAt = Date.now();
    if (options?.busy !== undefined) session.busy = options.busy;
    if (options?.pinned !== undefined) session.pinned = options.pinned;
    await this.refreshTarget(session);
    this.emitChanged();
    return this.snapshot(session);
  }

  show(id: string, bounds: BrowserBounds): BrowserSessionSnapshot {
    this.assertViewportActive();
    const session = this.get(id);
    this.hideVisible();

    const mainWindow = this.options.getMainWindow();
    if (!mainWindow) throw new Error("Main window is not available");

    this.removeFromCurrentOwner(session);
    mainWindow.contentView.addChildView(session.view);
    session.view.setBounds(normalizeBounds(bounds));
    session.view.setVisible(true);
    session.visible = true;
    session.lastUsedAt = Date.now();
    this.visibleSessionId = id;
    this.emitChanged();
    return this.snapshot(session);
  }

  setBounds(id: string, bounds: BrowserBounds): BrowserSessionSnapshot {
    this.assertViewportActive();
    const session = this.get(id);
    session.view.setBounds(normalizeBounds(bounds));
    session.lastUsedAt = Date.now();
    this.emitChanged();
    return this.snapshot(session);
  }

  hide(id: string): BrowserSessionSnapshot {
    const session = this.get(id);
    this.moveToHidden(session);
    this.emitChanged();
    return this.snapshot(session);
  }

  close(id: string): void {
    const session = this.get(id);
    this.destroy(session);
    this.emitChanged();
  }

  async navigate(id: string, url: string): Promise<BrowserSessionSnapshot> {
    const session = this.get(id);
    session.lastUsedAt = Date.now();
    await session.view.webContents.loadURL(normalizeNavigationUrl(url));
    await this.refreshTarget(session);
    this.emitChanged();
    return this.snapshot(session);
  }

  async goBack(id: string): Promise<BrowserSessionSnapshot> {
    const session = this.get(id);
    session.lastUsedAt = Date.now();
    if (session.view.webContents.navigationHistory.canGoBack()) {
      session.view.webContents.navigationHistory.goBack();
    }
    await this.refreshTarget(session);
    this.emitChanged();
    return this.snapshot(session);
  }

  async goForward(id: string): Promise<BrowserSessionSnapshot> {
    const session = this.get(id);
    session.lastUsedAt = Date.now();
    if (session.view.webContents.navigationHistory.canGoForward()) {
      session.view.webContents.navigationHistory.goForward();
    }
    await this.refreshTarget(session);
    this.emitChanged();
    return this.snapshot(session);
  }

  async reload(id: string): Promise<BrowserSessionSnapshot> {
    const session = this.get(id);
    session.lastUsedAt = Date.now();
    session.view.webContents.reload();
    await this.refreshTarget(session);
    this.emitChanged();
    return this.snapshot(session);
  }

  closeAll(): void {
    for (const session of [...this.sessions.values()]) {
      this.destroy(session);
    }
    this.sessions.clear();
    this.visibleSessionId = null;
    this.emitChanged();
  }

  activateViewport(): void {
    this.viewportActive = true;
  }

  deactivateViewport(): void {
    this.viewportActive = false;
    this.hideVisible();
    this.emitChanged();
  }

  private async makeRoom(): Promise<void> {
    if (this.sessions.size < this.options.maxSessions) return;

    const candidate = [...this.sessions.values()]
      .filter((session) => !session.busy && !session.pinned)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];

    if (!candidate) {
      throw new Error(
        `Browser session limit reached (${this.options.maxSessions}); every session is currently in use`,
      );
    }

    this.destroy(candidate);
  }

  private get(id: string): BrowserSessionState {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Browser session not found: ${id}`);
    return session;
  }

  private attachToHidden(session: BrowserSessionState): void {
    this.options.hiddenWindow.contentView.addChildView(session.view);
    session.view.setBounds(DEFAULT_BOUNDS);
    session.view.setVisible(true);
    session.visible = false;
  }

  private hideVisible(): void {
    if (!this.visibleSessionId) return;
    const current = this.sessions.get(this.visibleSessionId);
    if (current) this.moveToHidden(current);
    this.visibleSessionId = null;
  }

  private assertViewportActive(): void {
    if (!this.viewportActive) {
      throw new Error("Browser viewport is not active");
    }
  }

  private moveToHidden(session: BrowserSessionState): void {
    this.removeFromCurrentOwner(session);
    this.options.hiddenWindow.contentView.addChildView(session.view);
    session.view.setBounds(DEFAULT_BOUNDS);
    session.view.setVisible(true);
    session.visible = false;
    if (this.visibleSessionId === session.id) this.visibleSessionId = null;
  }

  private removeFromCurrentOwner(session: BrowserSessionState): void {
    const owners = [
      this.options.getMainWindow()?.contentView,
      this.options.hiddenWindow.contentView,
    ].filter((owner): owner is NonNullable<typeof owner> => owner !== undefined && owner !== null);

    for (const owner of owners) {
      try {
        owner.removeChildView(session.view);
      } catch {}
    }
  }

  private destroy(session: BrowserSessionState): void {
    this.removeFromCurrentOwner(session);
    this.sessions.delete(session.id);
    if (this.visibleSessionId === session.id) this.visibleSessionId = null;
    const webContents: WebContents = session.view.webContents;
    if (!webContents.isDestroyed()) webContents.close();
  }

  private async refreshTarget(session: BrowserSessionState): Promise<void> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.options.debuggingPort}/json/list`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) return;
      const targets = (await response.json()) as readonly DevtoolsTarget[];
      const url = session.view.webContents.getURL();
      const target =
        targets.find((entry) => entry.type === "page" && entry.url === url) ??
        targets.find((entry) => entry.type === "page" && entry.url === session.markerUrl);
      if (!target) return;
      session.targetId = target.id;
      session.webSocketDebuggerUrl = target.webSocketDebuggerUrl ?? null;
    } catch {}
  }

  private snapshot(session: BrowserSessionState): BrowserSessionSnapshot {
    return {
      id: session.id,
      agentId: session.agentId,
      url: session.view.webContents.getURL(),
      title: session.view.webContents.getTitle(),
      canGoBack: session.view.webContents.navigationHistory.canGoBack(),
      canGoForward: session.view.webContents.navigationHistory.canGoForward(),
      isLoading: session.view.webContents.isLoading(),
      busy: session.busy,
      pinned: session.pinned,
      visible: session.visible,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      targetId: session.targetId,
      cdpUrl: `http://127.0.0.1:${this.options.debuggingPort}`,
      webSocketDebuggerUrl: session.webSocketDebuggerUrl,
    };
  }

  private emitChanged(): void {
    this.options.onSessionsChanged?.();
  }
}

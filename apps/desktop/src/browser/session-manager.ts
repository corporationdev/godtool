import {
  BrowserWindow,
  WebContentsView,
  session as electronSession,
  type WebContents,
} from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { BrowserBounds, BrowserSessionSnapshot, EnsureBrowserSessionInput } from "./types";

interface DevtoolsTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly title?: string;
  readonly webSocketDebuggerUrl?: string;
}

interface BrowserSessionMetadata {
  sessionName: string;
  createdAt: number;
  lastUsedAt: number;
  pinned: boolean;
  url: string;
  title: string;
}

interface BrowserSessionState extends BrowserSessionMetadata {
  id: string;
  markerUrl: string;
  view: WebContentsView | null;
  targetId: string | null;
  webSocketDebuggerUrl: string | null;
  restoring: boolean;
  restorePromise: Promise<void> | null;
  visible: boolean;
}

interface PersistedBrowserSessions {
  readonly sessions?: readonly BrowserSessionMetadata[];
}

export interface BrowserSessionManagerOptions {
  readonly maxSessions: number;
  readonly debuggingPort: number;
  readonly hiddenWindow: BrowserWindow;
  readonly metadataPath: string;
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

const normalizeSessionName = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "browser";
};

const normalizeCallerId = (value: string | undefined): string =>
  (value?.trim() ? value.trim() : "anonymous-browser-caller").slice(0, 120);

const createSessionId = (): string =>
  `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const AGENT_ACTIVE_WINDOW_MS = 30_000;

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSessionState>();
  private readonly callerSessions = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private visibleSessionName: string | null = null;
  private viewportActive = false;
  private autoSessionIndex = 0;

  constructor(private readonly options: BrowserSessionManagerOptions) {
    this.loadMetadata();
  }

  async ensure(input: EnsureBrowserSessionInput): Promise<BrowserSessionSnapshot> {
    const callerId = normalizeCallerId(input.callerId);
    const explicitName = input.sessionName?.trim() ? normalizeSessionName(input.sessionName) : null;

    const sessionName =
      explicitName ?? this.callerSessions.get(callerId) ?? this.createAutoSessionName(callerId);

    this.callerSessions.set(callerId, sessionName);

    return this.enqueue(sessionName, async () => {
      const session = this.getOrCreate(sessionName);
      session.lastUsedAt = Date.now();
      session.pinned = input.pinned ?? session.pinned;
      await this.ensureActive(session, { waitForLoad: false });
      if (input.url !== undefined) {
        await this.navigateActive(session, input.url);
      } else {
        await this.refreshTarget(session);
      }
      this.persistMetadata();
      this.emitChanged();
      return this.snapshot(session);
    });
  }

  list(): readonly BrowserSessionSnapshot[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      .map((session) => this.snapshot(session));
  }

  async touch(
    id: string,
    options?: { readonly pinned?: boolean },
  ): Promise<BrowserSessionSnapshot> {
    const session = this.getById(id);
    return this.enqueue(session.sessionName, async () => {
      if (options?.pinned !== undefined) session.pinned = options.pinned;
      await this.refreshTarget(session);
      this.persistMetadata();
      this.emitChanged();
      return this.snapshot(session);
    });
  }

  async show(id: string, bounds: BrowserBounds): Promise<BrowserSessionSnapshot> {
    this.assertViewportActive();
    const session = this.getById(id);
    return this.enqueue(session.sessionName, async () => {
      await this.ensureActive(session, { startRestore: false, waitForLoad: false });
      const view = this.requireView(session);
      this.hideVisible();

      const mainWindow = this.options.getMainWindow();
      if (!mainWindow) throw new Error("Main window is not available");

      this.removeFromCurrentOwner(session);
      mainWindow.contentView.addChildView(view);
      view.setBounds(normalizeBounds(bounds));
      view.setVisible(true);
      session.visible = true;
      this.visibleSessionName = session.sessionName;
      this.startRestore(session);
      this.persistMetadata();
      this.emitChanged();
      return this.snapshot(session);
    });
  }

  async setBounds(id: string, bounds: BrowserBounds): Promise<BrowserSessionSnapshot> {
    this.assertViewportActive();
    const session = this.getById(id);
    return this.enqueue(session.sessionName, async () => {
      const view = this.requireView(session);
      view.setBounds(normalizeBounds(bounds));
      this.persistMetadata();
      this.emitChanged();
      return this.snapshot(session);
    });
  }

  async hide(id: string): Promise<BrowserSessionSnapshot> {
    const session = this.getById(id);
    return this.enqueue(session.sessionName, async () => {
      this.moveToHidden(session);
      this.emitChanged();
      return this.snapshot(session);
    });
  }

  close(id: string): void {
    const session = this.getById(id);
    this.destroy(session);
    this.sessions.delete(session.sessionName);
    for (const [callerId, sessionName] of this.callerSessions) {
      if (sessionName === session.sessionName) this.callerSessions.delete(callerId);
    }
    this.persistMetadata();
    this.emitChanged();
  }

  async rename(id: string, sessionName: string): Promise<BrowserSessionSnapshot> {
    const session = this.getById(id);
    const nextName = normalizeSessionName(sessionName);
    if (nextName !== session.sessionName && this.sessions.has(nextName)) {
      throw new Error(`Browser session already exists: ${nextName}`);
    }
    this.sessions.delete(session.sessionName);
    for (const [callerId, currentName] of this.callerSessions) {
      if (currentName === session.sessionName) this.callerSessions.set(callerId, nextName);
    }
    session.sessionName = nextName;
    this.sessions.set(nextName, session);
    this.persistMetadata();
    this.emitChanged();
    return this.snapshot(session);
  }

  async clearBrowserData(): Promise<void> {
    await electronSession.defaultSession.clearStorageData();
  }

  async navigate(id: string, url: string): Promise<BrowserSessionSnapshot> {
    const session = this.getById(id);
    return this.enqueue(session.sessionName, async () => {
      await this.ensureActive(session);
      await this.navigateActive(session, url);
      this.persistMetadata();
      this.emitChanged();
      return this.snapshot(session);
    });
  }

  async goBack(id: string): Promise<BrowserSessionSnapshot> {
    const session = this.getById(id);
    return this.enqueue(session.sessionName, async () => {
      await this.ensureActive(session);
      const view = this.requireView(session);
      if (view.webContents.navigationHistory.canGoBack()) {
        await this.waitForNavigationAfter(view, () => view.webContents.navigationHistory.goBack());
      }
      await this.refreshTarget(session);
      this.persistMetadata();
      this.emitChanged();
      return this.snapshot(session);
    });
  }

  async goForward(id: string): Promise<BrowserSessionSnapshot> {
    const session = this.getById(id);
    return this.enqueue(session.sessionName, async () => {
      await this.ensureActive(session);
      const view = this.requireView(session);
      if (view.webContents.navigationHistory.canGoForward()) {
        await this.waitForNavigationAfter(view, () =>
          view.webContents.navigationHistory.goForward(),
        );
      }
      await this.refreshTarget(session);
      this.persistMetadata();
      this.emitChanged();
      return this.snapshot(session);
    });
  }

  async reload(id: string): Promise<BrowserSessionSnapshot> {
    const session = this.getById(id);
    return this.enqueue(session.sessionName, async () => {
      await this.ensureActive(session);
      const view = this.requireView(session);
      view.webContents.reload();
      await this.refreshTarget(session);
      this.persistMetadata();
      this.emitChanged();
      return this.snapshot(session);
    });
  }

  closeAll(): void {
    for (const session of [...this.sessions.values()]) {
      this.destroy(session);
    }
    this.callerSessions.clear();
    this.visibleSessionName = null;
    this.persistMetadata();
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

  private async enqueue<A>(sessionName: string, run: () => Promise<A>): Promise<A> {
    const previous = this.queues.get(sessionName) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.queues.set(sessionName, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(sessionName) === next) this.queues.delete(sessionName);
    }
  }

  private createAutoSessionName(callerId: string): string {
    const base = normalizeSessionName(callerId);
    for (;;) {
      this.autoSessionIndex += 1;
      const candidate = normalizeSessionName(`${base}-${this.autoSessionIndex}`);
      if (!this.sessions.has(candidate)) return candidate;
    }
  }

  private getOrCreate(sessionName: string): BrowserSessionState {
    const existing = this.sessions.get(sessionName);
    if (existing) return existing;

    const now = Date.now();
    const state: BrowserSessionState = {
      id: createSessionId(),
      sessionName,
      createdAt: now,
      lastUsedAt: now,
      pinned: false,
      visible: false,
      url: "about:blank",
      title: "",
      markerUrl: "",
      view: null,
      targetId: null,
      webSocketDebuggerUrl: null,
      restoring: false,
      restorePromise: null,
    };
    state.markerUrl = `about:blank#executor-browser-${encodeURIComponent(state.id)}`;
    this.sessions.set(sessionName, state);
    return state;
  }

  private async ensureActive(
    session: BrowserSessionState,
    options: { readonly startRestore?: boolean; readonly waitForLoad?: boolean } = {},
  ): Promise<void> {
    const startRestore = options.startRestore ?? true;
    const waitForLoad = options.waitForLoad ?? true;
    if (session.view && !session.view.webContents.isDestroyed()) {
      if (waitForLoad && session.restorePromise) await session.restorePromise;
      return;
    }

    await this.makeRoom();
    session.id = createSessionId();
    session.markerUrl = `about:blank#executor-browser-${encodeURIComponent(session.id)}`;
    session.targetId = null;
    session.webSocketDebuggerUrl = null;
    session.restoring = true;

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    session.view = view;

    view.webContents.on("destroyed", () => {
      if (session.view === view) {
        session.view = null;
        session.visible = false;
        session.targetId = null;
        session.webSocketDebuggerUrl = null;
        session.restoring = false;
        session.restorePromise = null;
        if (this.visibleSessionName === session.sessionName) this.visibleSessionName = null;
        this.emitChanged();
      }
    });

    view.webContents.on("did-navigate", () => {
      this.updatePageMetadata(session);
      if (session.restoring) return;
      this.persistMetadata();
      this.emitChanged();
    });
    view.webContents.on("did-navigate-in-page", () => {
      this.updatePageMetadata(session);
      if (session.restoring) return;
      this.persistMetadata();
      this.emitChanged();
    });
    view.webContents.on("page-title-updated", () => {
      this.updatePageMetadata(session);
      if (session.restoring) return;
      this.persistMetadata();
      this.emitChanged();
    });
    view.webContents.on("did-start-loading", () => {
      if (!session.restoring) this.emitChanged();
    });
    view.webContents.on("did-stop-loading", () => {
      this.updatePageMetadata(session);
      if (session.restoring) return;
      this.persistMetadata();
      this.emitChanged();
    });

    this.attachToHidden(session);

    if (startRestore) {
      this.startRestore(session);
      if (waitForLoad && session.restorePromise) {
        await session.restorePromise;
      }
    }
  }

  private startRestore(session: BrowserSessionState): void {
    if (session.restorePromise) return;
    const view = this.requireView(session);
    session.restoring = true;
    const restorePromise = (async () => {
      await view.webContents.loadURL(
        session.url === "about:blank" ? session.markerUrl : session.url,
      );
      this.updatePageMetadata(session);
      await this.refreshTarget(session);
    })();
    session.restorePromise = restorePromise.finally(() => {
      session.restoring = false;
      session.restorePromise = null;
      this.persistMetadata();
      this.emitChanged();
    });
    void session.restorePromise.catch(() => undefined);
  }

  private async makeRoom(): Promise<void> {
    const loadedSessions = [...this.sessions.values()].filter((session) => session.view !== null);
    if (loadedSessions.length < this.options.maxSessions) return;

    const candidate = loadedSessions
      .filter(
        (session) =>
          !session.pinned &&
          !session.visible &&
          !this.queues.has(session.sessionName) &&
          Date.now() - session.lastUsedAt >= AGENT_ACTIVE_WINDOW_MS,
      )
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];

    if (!candidate) {
      throw new Error(
        `Browser loaded limit reached (${this.options.maxSessions}); no inactive sessions can be unloaded`,
      );
    }

    this.unload(candidate);
  }

  private getById(id: string): BrowserSessionState {
    const session = [...this.sessions.values()].find((entry) => entry.id === id);
    if (!session) throw new Error(`Browser session not found: ${id}`);
    return session;
  }

  private attachToHidden(session: BrowserSessionState): void {
    const view = this.requireView(session);
    this.options.hiddenWindow.contentView.addChildView(view);
    view.setBounds(DEFAULT_BOUNDS);
    view.setVisible(true);
    session.visible = false;
  }

  private hideVisible(): void {
    if (!this.visibleSessionName) return;
    const current = this.sessions.get(this.visibleSessionName);
    if (current) this.moveToHidden(current);
    this.visibleSessionName = null;
  }

  private assertViewportActive(): void {
    if (!this.viewportActive) {
      throw new Error("Browser viewport is not active");
    }
  }

  private moveToHidden(session: BrowserSessionState): void {
    if (!session.view) return;
    const view = this.requireView(session);
    this.removeFromCurrentOwner(session);
    this.options.hiddenWindow.contentView.addChildView(view);
    view.setBounds(DEFAULT_BOUNDS);
    view.setVisible(true);
    session.visible = false;
    if (this.visibleSessionName === session.sessionName) this.visibleSessionName = null;
  }

  private removeFromCurrentOwner(session: BrowserSessionState): void {
    if (!session.view) return;
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

  private unload(session: BrowserSessionState): void {
    this.updatePageMetadata(session);
    this.destroy(session);
  }

  private destroy(session: BrowserSessionState): void {
    if (!session.view) return;
    const webContents: WebContents = session.view.webContents;
    this.removeFromCurrentOwner(session);
    session.view = null;
    session.visible = false;
    session.targetId = null;
    session.webSocketDebuggerUrl = null;
    session.restoring = false;
    session.restorePromise = null;
    if (this.visibleSessionName === session.sessionName) this.visibleSessionName = null;
    if (!webContents.isDestroyed()) webContents.close();
  }

  private requireView(session: BrowserSessionState): WebContentsView {
    if (!session.view) throw new Error(`Browser session is not loaded: ${session.sessionName}`);
    return session.view;
  }

  private async navigateActive(session: BrowserSessionState, url: string): Promise<void> {
    const view = this.requireView(session);
    await view.webContents.loadURL(normalizeNavigationUrl(url));
    this.updatePageMetadata(session);
    await this.refreshTarget(session);
  }

  private waitForNavigationAfter(view: WebContentsView, trigger: () => void): Promise<void> {
    const webContents = view.webContents;
    return new Promise((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let quickCheck: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        webContents.off("did-stop-loading", finish);
        webContents.off("did-fail-load", finish);
        webContents.off("did-navigate-in-page", finish);
        if (timeout) clearTimeout(timeout);
        if (quickCheck) clearTimeout(quickCheck);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      webContents.on("did-stop-loading", finish);
      webContents.on("did-fail-load", finish);
      webContents.on("did-navigate-in-page", finish);
      timeout = setTimeout(finish, 10_000);
      trigger();
      quickCheck = setTimeout(() => {
        if (!webContents.isLoading()) finish();
      }, 100);
    });
  }

  private updatePageMetadata(session: BrowserSessionState): void {
    if (!session.view || session.view.webContents.isDestroyed()) return;
    const url = session.view.webContents.getURL();
    const isTransientBlank = url === "about:blank" && session.url !== "about:blank";
    if (url && url !== session.markerUrl && !isTransientBlank) {
      session.url = url;
    }
    const title = session.view.webContents.getTitle();
    if (title || session.url === "about:blank") {
      session.title = title;
    }
  }

  private async refreshTarget(session: BrowserSessionState): Promise<void> {
    if (!session.view || session.view.webContents.isDestroyed()) return;
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
    const view = session.view && !session.view.webContents.isDestroyed() ? session.view : null;
    const viewUrl = session.restoring ? undefined : view?.webContents.getURL();
    const isTransientBlank = viewUrl === "about:blank" && session.url !== "about:blank";
    const visibleUrl =
      viewUrl && viewUrl !== session.markerUrl && !isTransientBlank
        ? viewUrl
        : session.url || "about:blank";
    const viewTitle = session.restoring ? undefined : view?.webContents.getTitle();
    return {
      id: session.id,
      sessionName: session.sessionName,
      url: visibleUrl,
      title: viewTitle || session.title,
      canGoBack: view?.webContents.navigationHistory.canGoBack() ?? false,
      canGoForward: view?.webContents.navigationHistory.canGoForward() ?? false,
      isLoading: view?.webContents.isLoading() ?? false,
      pinned: session.pinned,
      visible: session.visible,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      targetId: session.targetId,
      cdpUrl: `http://127.0.0.1:${this.options.debuggingPort}`,
      webSocketDebuggerUrl: session.webSocketDebuggerUrl,
    };
  }

  private loadMetadata(): void {
    if (!existsSync(this.options.metadataPath)) return;
    try {
      const parsed = JSON.parse(
        readFileSync(this.options.metadataPath, "utf-8"),
      ) as PersistedBrowserSessions;
      for (const item of parsed.sessions ?? []) {
        const sessionName = normalizeSessionName(item.sessionName);
        this.sessions.set(sessionName, {
          id: createSessionId(),
          sessionName,
          createdAt: item.createdAt,
          lastUsedAt: item.lastUsedAt,
          pinned: item.pinned,
          visible: false,
          url: item.url || "about:blank",
          title: item.title || "",
          markerUrl: "",
          view: null,
          targetId: null,
          webSocketDebuggerUrl: null,
          restoring: false,
          restorePromise: null,
        });
        const session = this.sessions.get(sessionName);
        if (session) {
          session.markerUrl = `about:blank#executor-browser-${encodeURIComponent(session.id)}`;
        }
      }
    } catch {}
  }

  private persistMetadata(): void {
    try {
      mkdirSync(dirname(this.options.metadataPath), { recursive: true });
      const sessions: BrowserSessionMetadata[] = [...this.sessions.values()].map((session) => ({
        sessionName: session.sessionName,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        pinned: session.pinned,
        url: session.url,
        title: session.title,
      }));
      writeFileSync(this.options.metadataPath, JSON.stringify({ sessions }, null, 2));
    } catch {}
  }

  private emitChanged(): void {
    this.options.onSessionsChanged?.();
  }
}

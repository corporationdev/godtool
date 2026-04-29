export interface BrowserSessionSnapshot {
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

export interface BrowserBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface EnsureBrowserSessionInput {
  readonly callerId?: string;
  readonly sessionName?: string;
  readonly url?: string;
  readonly pinned?: boolean;
}

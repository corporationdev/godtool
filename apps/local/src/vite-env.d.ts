/// <reference types="vite/client" />

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

interface Window {
  readonly electronAPI?: {
    readonly getCurrentScope: () => Promise<string | null>;
    readonly browsers?: {
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
      readonly setBounds: (
        sessionId: string,
        bounds: BrowserBounds,
      ) => Promise<BrowserSessionSnapshot>;
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
      readonly onChanged: (
        listener: (sessions: readonly BrowserSessionSnapshot[]) => void,
      ) => () => void;
    };
  };
}

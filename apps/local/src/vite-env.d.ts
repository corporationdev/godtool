/// <reference types="vite/client" />

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

interface Window {
  readonly electronAPI?: {
    readonly selectScope: () => Promise<string | null>;
    readonly getCurrentScope: () => Promise<string | null>;
    readonly getRecentScopes: () => Promise<readonly string[]>;
    readonly switchScope: (scopePath: string) => Promise<string | null>;
    readonly browsers?: {
      readonly list: () => Promise<readonly BrowserSessionSnapshot[]>;
      readonly ensure: (input: {
        readonly agentId: string;
        readonly url?: string;
        readonly busy?: boolean;
        readonly pinned?: boolean;
      }) => Promise<BrowserSessionSnapshot>;
      readonly show: (sessionId: string, bounds: BrowserBounds) => Promise<BrowserSessionSnapshot>;
      readonly setBounds: (
        sessionId: string,
        bounds: BrowserBounds,
      ) => Promise<BrowserSessionSnapshot>;
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
      readonly onChanged: (
        listener: (sessions: readonly BrowserSessionSnapshot[]) => void,
      ) => () => void;
    };
  };
}

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { AccountAuthState } from "@executor/react/components/account-menu";

type CloudAuthApi = {
  readonly me: () => Promise<AccountAuthState>;
  readonly signIn: () => Promise<AccountAuthState>;
  readonly signOut: () => Promise<AccountAuthState>;
  readonly getCloudUrl: () => Promise<string>;
  readonly listSources: () => Promise<readonly CloudSource[]>;
};

export type CloudSource = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly url?: string;
  readonly runtime?: boolean;
  readonly canRemove?: boolean;
  readonly canRefresh?: boolean;
  readonly canEdit?: boolean;
};

type ElectronWindow = Window & {
  readonly electronAPI?: {
    readonly cloudAuth?: CloudAuthApi;
  };
};

type LocalAuthContextValue = {
  readonly auth: AccountAuthState;
  readonly available: boolean;
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly listCloudSources: () => Promise<readonly CloudSource[]>;
};

const LocalAuthContext = createContext<LocalAuthContextValue>({
  auth: { status: "loading" },
  available: false,
  signIn: async () => {},
  signOut: async () => {},
  listCloudSources: async () => [],
});

const getCloudAuthApi = (): CloudAuthApi | null => {
  if (typeof window === "undefined") return null;
  return ((window as ElectronWindow).electronAPI?.cloudAuth ?? null) as CloudAuthApi | null;
};

export function LocalAuthProvider(props: React.PropsWithChildren) {
  const [auth, setAuth] = useState<AccountAuthState>({ status: "loading" });
  const api = useMemo(getCloudAuthApi, []);
  const available = api !== null;

  const refresh = useCallback(async () => {
    if (!api) {
      setAuth({ status: "unauthenticated" });
      return;
    }
    try {
      setAuth(await api.me());
    } catch {
      setAuth({ status: "unauthenticated" });
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async () => {
    if (!api) return;
    setAuth(await api.signIn());
  }, [api]);

  const signOut = useCallback(async () => {
    if (!api) return;
    setAuth(await api.signOut());
  }, [api]);

  const listCloudSources = useCallback(async () => {
    if (!api) return [];
    return await api.listSources();
  }, [api]);

  return (
    <LocalAuthContext.Provider value={{ auth, available, signIn, signOut, listCloudSources }}>
      {props.children}
    </LocalAuthContext.Provider>
  );
}

export const useLocalAuth = () => useContext(LocalAuthContext);

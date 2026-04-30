import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { AccountAuthState } from "@executor/react/components/account-menu";

type CloudAuthApi = {
  readonly me: () => Promise<AccountAuthState>;
  readonly signIn: () => Promise<AccountAuthState>;
  readonly signOut: () => Promise<AccountAuthState>;
  readonly getCloudUrl: () => Promise<string>;
  readonly getDeviceId: () => Promise<string>;
};

type ElectronWindow = Window & {
  readonly electronAPI?: {
    readonly cloudAuth?: CloudAuthApi;
  };
};

type LocalAuthContextValue = {
  readonly auth: AccountAuthState;
  readonly available: boolean;
  readonly deviceId: string | null;
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
};

const LocalAuthContext = createContext<LocalAuthContextValue>({
  auth: { status: "loading" },
  available: false,
  deviceId: null,
  signIn: async () => {},
  signOut: async () => {},
});

const getCloudAuthApi = (): CloudAuthApi | null => {
  if (typeof window === "undefined") return null;
  return ((window as ElectronWindow).electronAPI?.cloudAuth ?? null) as CloudAuthApi | null;
};

export function LocalAuthProvider(props: React.PropsWithChildren) {
  const [auth, setAuth] = useState<AccountAuthState>({ status: "loading" });
  const [deviceId, setDeviceId] = useState<string | null>(null);
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

  useEffect(() => {
    if (!api) return;
    api
      .getDeviceId()
      .then(setDeviceId)
      .catch(() => setDeviceId(null));
  }, [api]);

  const signIn = useCallback(async () => {
    if (!api) return;
    setAuth(await api.signIn());
  }, [api]);

  const signOut = useCallback(async () => {
    if (!api) return;
    setAuth(await api.signOut());
  }, [api]);

  return (
    <LocalAuthContext.Provider
      value={{
        auth,
        available,
        deviceId,
        signIn,
        signOut,
      }}
    >
      {props.children}
    </LocalAuthContext.Provider>
  );
}

export const useLocalAuth = () => useContext(LocalAuthContext);

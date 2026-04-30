import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { AccountAuthState } from "@executor/react/components/account-menu";

type CloudAuthApi = {
  readonly me: () => Promise<AccountAuthState>;
  readonly signIn: () => Promise<AccountAuthState>;
  readonly signOut: () => Promise<AccountAuthState>;
  readonly getCloudUrl: () => Promise<string>;
  readonly getDeviceId: () => Promise<string>;
  readonly getEntitlements?: () => Promise<CloudEntitlements>;
  readonly openBillingPlans?: () => Promise<void>;
  readonly listSources: () => Promise<readonly CloudSource[]>;
  readonly syncSourcesToCloud: (sourceIds: readonly string[]) => Promise<unknown>;
  readonly syncSourcesToLocal: (sourceIds: readonly string[]) => Promise<unknown>;
  readonly deleteSources: (
    sourceIds: readonly string[],
    placements: readonly ("local" | "cloud")[],
  ) => Promise<unknown>;
  readonly listImportCandidates: () => Promise<readonly SourceImportCandidate[]>;
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

export type SourceImportCandidate = {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly pluginId: string;
};

export type CloudEntitlements = {
  readonly managedAuth: boolean;
  readonly cloudMcp: boolean;
  readonly hostedWorkerFallback: boolean;
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
  readonly entitlements: CloudEntitlements | null;
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly refreshEntitlements: () => Promise<void>;
  readonly openBillingPlans: () => Promise<void>;
  readonly listCloudSources: () => Promise<readonly CloudSource[]>;
  readonly syncSourcesToCloud: (sourceIds: readonly string[]) => Promise<void>;
  readonly syncSourcesToLocal: (sourceIds: readonly string[]) => Promise<void>;
  readonly deleteSources: (
    sourceIds: readonly string[],
    placements: readonly ("local" | "cloud")[],
  ) => Promise<void>;
  readonly listImportCandidates: () => Promise<readonly SourceImportCandidate[]>;
};

const LocalAuthContext = createContext<LocalAuthContextValue>({
  auth: { status: "loading" },
  available: false,
  deviceId: null,
  entitlements: null,
  signIn: async () => {},
  signOut: async () => {},
  refreshEntitlements: async () => {},
  openBillingPlans: async () => {},
  listCloudSources: async () => [],
  syncSourcesToCloud: async () => {},
  syncSourcesToLocal: async () => {},
  deleteSources: async () => {},
  listImportCandidates: async () => [],
});

const getCloudAuthApi = (): CloudAuthApi | null => {
  if (typeof window === "undefined") return null;
  return ((window as ElectronWindow).electronAPI?.cloudAuth ?? null) as CloudAuthApi | null;
};

export function LocalAuthProvider(props: React.PropsWithChildren) {
  const [auth, setAuth] = useState<AccountAuthState>({ status: "loading" });
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [entitlements, setEntitlements] = useState<CloudEntitlements | null>(null);
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

  const refreshEntitlements = useCallback(async () => {
    if (!api?.getEntitlements) {
      setEntitlements(null);
      return;
    }
    try {
      setEntitlements(await api.getEntitlements());
    } catch {
      setEntitlements(null);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (auth.status !== "authenticated") {
      setEntitlements(null);
      return;
    }
    void refreshEntitlements();
  }, [auth.status, refreshEntitlements]);

  useEffect(() => {
    if (!api) return;
    api
      .getDeviceId()
      .then(setDeviceId)
      .catch(() => setDeviceId(null));
  }, [api]);

  const signIn = useCallback(async () => {
    if (!api) return;
    const nextAuth = await api.signIn();
    setAuth(nextAuth);
    if (nextAuth.status === "authenticated") {
      await refreshEntitlements();
    }
  }, [api, refreshEntitlements]);

  const signOut = useCallback(async () => {
    if (!api) return;
    setAuth(await api.signOut());
    setEntitlements(null);
  }, [api]);

  const openBillingPlans = useCallback(async () => {
    await api?.openBillingPlans?.();
  }, [api]);

  const listCloudSources = useCallback(async () => {
    if (!api) return [];
    return await api.listSources();
  }, [api]);

  const syncSourcesToCloud = useCallback(
    async (sourceIds: readonly string[]) => {
      if (!api) return;
      await api.syncSourcesToCloud(sourceIds);
    },
    [api],
  );

  const syncSourcesToLocal = useCallback(
    async (sourceIds: readonly string[]) => {
      if (!api) return;
      await api.syncSourcesToLocal(sourceIds);
    },
    [api],
  );

  const deleteSources = useCallback(
    async (sourceIds: readonly string[], placements: readonly ("local" | "cloud")[]) => {
      if (!api) return;
      await api.deleteSources(sourceIds, placements);
    },
    [api],
  );

  const listImportCandidates = useCallback(async () => {
    if (!api) return [];
    return await api.listImportCandidates();
  }, [api]);

  return (
    <LocalAuthContext.Provider
      value={{
        auth,
        available,
        deviceId,
        entitlements,
        signIn,
        signOut,
        refreshEntitlements,
        openBillingPlans,
        listCloudSources,
        syncSourcesToCloud,
        syncSourcesToLocal,
        deleteSources,
        listImportCandidates,
      }}
    >
      {props.children}
    </LocalAuthContext.Provider>
  );
}

export const useLocalAuth = () => useContext(LocalAuthContext);

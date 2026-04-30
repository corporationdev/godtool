import { useEffect, useState } from "react";

export type ManagedAuthConnectInput = {
  readonly app: string;
  readonly provider: string;
  readonly placement: "local" | "cloud";
  readonly connectionId?: string;
};

export type ManagedAuthConnectResult = {
  readonly ok: true;
  readonly managedAuth: {
    readonly kind: "composio";
    readonly app: string;
    readonly authConfigId: string | null;
    readonly connectionId: string;
  };
  readonly managedConnection: {
    readonly connectionId: string;
    readonly provider: string;
    readonly identityLabel: string | null;
    readonly connectedAccountId: string;
  };
};

type ElectronManagedAuthApi = {
  readonly startManagedAuthConnect?: (
    input: ManagedAuthConnectInput & { readonly channel: string },
  ) => Promise<ManagedAuthConnectResult>;
};

type ElectronBillingApi = {
  readonly listPlans?: () => Promise<unknown>;
};

type ElectronWindow = Window & {
  readonly electronAPI?: {
    readonly cloudAuth?: ElectronManagedAuthApi;
    readonly cloudBilling?: ElectronBillingApi;
  };
};

export const isDesktopManagedAuth = (): boolean =>
  typeof window !== "undefined" &&
  Boolean((window as ElectronWindow).electronAPI?.cloudAuth?.startManagedAuthConnect);

const cloudStart = async (input: ManagedAuthConnectInput & { readonly channel: string }) => {
  const response = await fetch("/api/managed-auth/composio/start", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as {
    readonly redirectUrl?: string;
    readonly error?: string;
  } | null;
  if (!response.ok || !body?.redirectUrl) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Sign in to use managed auth");
    }
    if (response.status === 402) {
      throw new Error("Upgrade to Pro to use managed auth");
    }
    throw new Error(body?.error ?? "Failed to start managed auth");
  }
  return { redirectUrl: body.redirectUrl };
};

export const startManagedAuthConnect = async (
  input: ManagedAuthConnectInput,
): Promise<ManagedAuthConnectResult> => {
  const channel = `godtool:composio:${crypto.randomUUID()}`;
  const electronApi = (window as ElectronWindow).electronAPI?.cloudAuth;
  if (electronApi?.startManagedAuthConnect) {
    return electronApi.startManagedAuthConnect({ ...input, channel });
  }

  const started = await cloudStart({ ...input, channel });
  const popup = window.open(started.redirectUrl, "_blank", "width=520,height=720");
  if (!popup) throw new Error("Allow popups to use managed auth");

  return await new Promise<ManagedAuthConnectResult>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => {
        window.removeEventListener("message", onMessage);
        reject(new Error("Managed auth timed out"));
      },
      5 * 60 * 1000,
    );

    const onMessage = (event: MessageEvent) => {
      const data = event.data as
        | {
            readonly channel?: unknown;
            readonly payload?: unknown;
          }
        | undefined;
      if (data?.channel !== channel) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      const payload = data.payload as ManagedAuthConnectResult | { readonly error?: string };
      if ("ok" in payload && payload.ok === true) {
        resolve(payload);
      } else {
        reject(
          new Error(
            "error" in payload ? (payload.error ?? "Managed auth failed") : "Managed auth failed",
          ),
        );
      }
    };

    window.addEventListener("message", onMessage);
  });
};

type PlanLike = {
  readonly id?: unknown;
  readonly customerEligibility?: {
    readonly status?: unknown;
  } | null;
};

export type ManagedAuthAccessStatus = "loading" | "allowed" | "signed-out" | "not-pro" | "error";

export type ManagedAuthAccess = {
  readonly loading: boolean;
  readonly allowed: boolean;
  readonly status: ManagedAuthAccessStatus;
};

const isProPlanActive = (plans: unknown): boolean => {
  const list = Array.isArray(plans)
    ? plans
    : plans && typeof plans === "object" && "list" in plans && Array.isArray(plans.list)
      ? plans.list
      : [];

  return list.some((plan: PlanLike) => {
    if (plan?.id !== "pro") return false;
    const status = plan.customerEligibility?.status;
    return status === "active" || status === "scheduled";
  });
};

const accessFromPlans = (plans: unknown): ManagedAuthAccess => {
  const allowed = isProPlanActive(plans);
  return allowed
    ? { loading: false, allowed: true, status: "allowed" }
    : { loading: false, allowed: false, status: "not-pro" };
};

const fetchManagedAuthAccess = async (): Promise<ManagedAuthAccess> => {
  const electronBilling = (window as ElectronWindow).electronAPI?.cloudBilling;
  if (electronBilling?.listPlans) {
    try {
      return accessFromPlans(await electronBilling.listPlans());
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("sign in") || message.includes("unauthorized")) {
        return { loading: false, allowed: false, status: "signed-out" };
      }
      return { loading: false, allowed: false, status: "error" };
    }
  }

  const response = await fetch("/api/autumn/listPlans", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  if (response.status === 401 || response.status === 403) {
    return { loading: false, allowed: false, status: "signed-out" };
  }
  if (!response.ok) return { loading: false, allowed: false, status: "error" };
  return accessFromPlans(await response.json());
};

export const useManagedAuthAccess = () => {
  const [state, setState] = useState<ManagedAuthAccess>({
    loading: true,
    allowed: false,
    status: "loading",
  });

  useEffect(() => {
    let alive = true;
    void fetchManagedAuthAccess()
      .then((allowed) => {
        if (alive) setState(allowed);
      })
      .catch(() => {
        if (alive) setState({ loading: false, allowed: false, status: "error" });
      });
    return () => {
      alive = false;
    };
  }, []);

  return state;
};

export const managedAuthCtaLabel = (access: ManagedAuthAccess): string => {
  if (access.loading) return "Checking...";
  if (access.allowed) return "Connect";
  if (access.status === "signed-out") return "Sign in for Pro";
  return "Upgrade to Pro";
};

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@executor/react/components/button";
import type { AttachPlanInput, BillingCustomer, BillingPlan } from "@executor/react/pages/billing";
import type { useLocalAuth } from "./auth";

type BillingApi = {
  readonly getCustomer: () => Promise<unknown>;
  readonly listPlans: () => Promise<unknown>;
  readonly attach: (input: unknown) => Promise<unknown>;
  readonly openCustomerPortal: (input: unknown) => Promise<unknown>;
};

type ElectronWindow = Window & {
  readonly electronAPI?: {
    readonly system?: {
      readonly openExternal?: (url: string) => Promise<void>;
    };
    readonly cloudBilling?: BillingApi;
  };
};

const getBillingApi = (): BillingApi | null =>
  ((window as ElectronWindow).electronAPI?.cloudBilling ?? null) as BillingApi | null;

const openExternalUrl = async (url: string) => {
  const openExternal = (window as ElectronWindow).electronAPI?.system?.openExternal;
  if (openExternal) await openExternal(url);
  else window.location.href = url;
};

export function useDesktopBilling(auth: ReturnType<typeof useLocalAuth>) {
  const api = useMemo(getBillingApi, []);
  const [customer, setCustomer] = useState<BillingCustomer | null>(null);
  const [plans, setPlans] = useState<readonly BillingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api || auth.auth.status !== "authenticated") {
      setCustomer(null);
      setPlans([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const [nextCustomer, nextPlans] = await Promise.all([api.getCustomer(), api.listPlans()]);
      setCustomer(nextCustomer as BillingCustomer);
      setPlans(Array.isArray(nextPlans) ? (nextPlans as BillingPlan[]) : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load billing");
      setCustomer(null);
      setPlans([]);
    } finally {
      setLoading(false);
    }
  }, [api, auth.auth.status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const attachPlan = useCallback(
    async (input: AttachPlanInput) => {
      if (!api) throw new Error("Billing is unavailable");
      const response = (await api.attach(input)) as { readonly paymentUrl?: string | null } | null;
      if (response?.paymentUrl) {
        await openExternalUrl(response.paymentUrl);
        return;
      }
      await refresh();
    },
    [api, refresh],
  );

  const openCustomerPortal = useCallback(async () => {
    if (!api) throw new Error("Billing is unavailable");
    const response = (await api.openCustomerPortal({
      returnUrl: window.location.href,
    })) as { readonly url?: string | null } | null;
    if (response?.url) await openExternalUrl(response.url);
  }, [api]);

  return {
    available: api !== null,
    customer,
    plans,
    loading: loading || auth.auth.status === "loading",
    error,
    refresh,
    attachPlan,
    openCustomerPortal,
  };
}

export function BillingSignInView(props: {
  readonly auth: ReturnType<typeof useLocalAuth>;
  readonly error?: string | null;
}) {
  const [signingIn, setSigningIn] = useState(false);
  const signIn = async () => {
    setSigningIn(true);
    try {
      await props.auth.signIn();
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        <h1 className="font-display text-[2rem] tracking-tight text-foreground leading-none mb-10">
          Billing
        </h1>

        <div className="flex items-center justify-between py-4">
          <div>
            <p className="text-sm font-medium text-foreground leading-none">Sign in required</p>
            <p className="mt-1 text-xs text-muted-foreground leading-none">
              Sign in to manage Pro and billing.
            </p>
            {props.error && <p className="mt-2 text-xs text-destructive">{props.error}</p>}
          </div>
          <Button
            type="button"
            onClick={signIn}
            disabled={signingIn || !props.auth.available}
            className="rounded-md px-3 py-1.5 text-xs"
          >
            {signingIn ? "Signing in..." : "Sign in"}
          </Button>
        </div>
      </div>
    </div>
  );
}

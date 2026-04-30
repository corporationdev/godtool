import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BillingPlansView, type AttachPlanInput } from "@executor/react/pages/billing";
import { BillingSignInView, useDesktopBilling } from "../web/billing";
import { useLocalAuth } from "../web/auth";

export const Route = createFileRoute("/settings/billing_/plans")({
  component: PlansPage,
});

function PlansPage() {
  const auth = useLocalAuth();
  const billing = useDesktopBilling(auth);
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);

  const attachPlan = async (input: AttachPlanInput) => {
    setLoadingPlan(input.planId);
    try {
      await billing.attachPlan(input);
    } finally {
      setLoadingPlan(null);
    }
  };

  if (auth.auth.status !== "authenticated") {
    return <BillingSignInView auth={auth} error={billing.error} />;
  }

  return (
    <BillingPlansView
      plans={billing.plans}
      isLoading={billing.loading}
      loadingPlanId={loadingPlan}
      onAttachPlan={attachPlan}
      onOpenCustomerPortal={billing.openCustomerPortal}
      billingLink={
        <Link
          to="/settings/billing"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
            <path
              d="M10 4L6 8l4 4"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Billing
        </Link>
      }
    />
  );
}

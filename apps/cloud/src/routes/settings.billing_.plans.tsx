import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAutumnClient, useCustomer, useListPlans } from "autumn-js/react";
import { BillingPlansView, type AttachPlanInput } from "@executor/react/pages/billing";

export const Route = createFileRoute("/settings/billing_/plans")({
  component: PlansPage,
});

function PlansPage() {
  const autumn = useAutumnClient({ caller: "PlansPage" });
  const { openCustomerPortal, isLoading: customerLoading } = useCustomer();
  const { data: plans, isLoading: plansLoading, isFetching } = useListPlans();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);

  const attachPlan = async (input: AttachPlanInput) => {
    setLoadingPlan(input.planId);
    try {
      const response = await autumn.attach(input);
      if (response.paymentUrl) window.location.href = response.paymentUrl;
    } finally {
      setLoadingPlan(null);
    }
  };

  return (
    <BillingPlansView
      plans={plans ?? []}
      isLoading={customerLoading || plansLoading}
      isFetching={isFetching}
      loadingPlanId={loadingPlan}
      onAttachPlan={attachPlan}
      onOpenCustomerPortal={async () => {
        await openCustomerPortal();
      }}
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

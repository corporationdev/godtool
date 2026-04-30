import { createFileRoute, Link } from "@tanstack/react-router";
import { useCustomer, useListPlans } from "autumn-js/react";
import { BillingSummaryView } from "@executor/react/pages/billing";

export const Route = createFileRoute("/settings/billing")({
  component: BillingPage,
});

function BillingPage() {
  const { data: customer, openCustomerPortal, isLoading: customerLoading } = useCustomer();
  const { data: plans, isLoading: plansLoading } = useListPlans();

  return (
    <BillingSummaryView
      customer={customer ?? null}
      plans={plans ?? []}
      isLoading={customerLoading || plansLoading}
      onOpenCustomerPortal={async () => {
        await openCustomerPortal();
      }}
      plansLink={
        <Link
          to="/settings/billing/plans"
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Manage
        </Link>
      }
    />
  );
}

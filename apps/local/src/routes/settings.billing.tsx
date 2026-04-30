import { createFileRoute, Link } from "@tanstack/react-router";
import { BillingSummaryView } from "@executor/react/pages/billing";
import { BillingSignInView, useDesktopBilling } from "../web/billing";
import { useLocalAuth } from "../web/auth";

export const Route = createFileRoute("/settings/billing")({
  component: BillingPage,
});

function BillingPage() {
  const auth = useLocalAuth();
  const billing = useDesktopBilling(auth);

  if (auth.auth.status !== "authenticated") {
    return <BillingSignInView auth={auth} error={billing.error} />;
  }

  return (
    <BillingSummaryView
      customer={billing.customer}
      plans={billing.plans}
      isLoading={billing.loading}
      onOpenCustomerPortal={billing.openCustomerPortal}
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

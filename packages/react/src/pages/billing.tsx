import type { ReactNode } from "react";
import { Badge } from "../components/badge";
import { Button } from "../components/button";

export type BillingPlan = {
  readonly id: string;
  readonly name: string;
  readonly price?: {
    readonly amount?: number | null;
    readonly interval?: string | null;
  } | null;
  readonly customerEligibility?: {
    readonly status?: string;
    readonly canceling?: boolean;
    readonly attachAction?: string;
  } | null;
};

export type BillingCustomer = {
  readonly id?: string | null;
  readonly customerId?: string | null;
  readonly subscriptions?: readonly {
    readonly planId?: string;
    readonly status?: string;
    readonly currentPeriodEnd?: string | number | Date | null;
  }[];
};

export type AttachPlanInput = {
  readonly planId: string;
  readonly redirectMode?: "always";
  readonly successUrl?: string;
};

const PLAN_TAGLINES: Record<string, string> = {
  free: "Local app usage stays free",
  pro: "Use your integrations while your Mac is closed",
};

const PLAN_META: Record<string, { tagline: string; features: string[] }> = {
  free: {
    tagline: "Local usage stays free",
    features: [
      "Unlimited local app usage",
      "Computer use and browser use",
      "Persistent workspace",
      "Bring your own OAuth client",
    ],
  },
  pro: {
    tagline: "Use your integrations while your Mac is closed",
    features: ["Use your integrations while your Mac is closed"],
  },
};

const ACTION_LABELS: Record<string, string> = {
  activate: "Subscribe",
  upgrade: "Upgrade",
  downgrade: "Downgrade",
  none: "Current plan",
  purchase: "Purchase",
};

const formatDate = (date: string | number | Date) =>
  new Date(date).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

const orderedBillingPlans = (plans: readonly BillingPlan[]) =>
  plans
    .filter((plan) => plan.id === "free" || plan.id === "pro")
    .sort((a, b) => {
      const order: Record<string, number> = { free: 0, pro: 1 };
      return (order[a.id] ?? 99) - (order[b.id] ?? 99);
    });

export function BillingSummaryView(props: {
  readonly customer: BillingCustomer | null;
  readonly plans: readonly BillingPlan[];
  readonly isLoading: boolean;
  readonly plansLink: ReactNode;
  readonly onOpenCustomerPortal: () => Promise<void> | void;
}) {
  if (props.isLoading) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
          <div className="mb-10">
            <div className="h-8 w-28 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-16 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  const activePlan = props.plans.find(
    (p) => p.customerEligibility?.status === "active" && p.id !== "free",
  );
  const scheduledPlan = props.plans.find(
    (p) => p.customerEligibility?.status === "scheduled" && p.id !== "free",
  );
  const isCanceling = activePlan?.customerEligibility?.canceling ?? false;
  const isSwitching = isCanceling && scheduledPlan != null;
  const displayPlan = isSwitching ? scheduledPlan : activePlan;
  const planId = displayPlan?.id ?? "free";
  const planName = displayPlan?.name ?? "Free";
  const tagline = PLAN_TAGLINES[planId] ?? "";

  const sub = props.customer?.subscriptions?.find(
    (subscription) =>
      subscription.planId === (activePlan?.id ?? "free") &&
      (subscription.status === "active" || subscription.status === "trialing"),
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        <h1 className="font-display text-[2rem] tracking-tight text-foreground leading-none mb-10">
          Billing
        </h1>

        <div className="flex items-center justify-between py-4">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-foreground leading-none">{planName}</p>
              {isSwitching && (
                <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  Switching
                </Badge>
              )}
              {isCanceling && !isSwitching && (
                <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  Canceling
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground leading-none">
              {isSwitching && sub?.currentPeriodEnd
                ? `Starts ${formatDate(sub.currentPeriodEnd)}`
                : isCanceling && sub?.currentPeriodEnd
                  ? `Access until ${formatDate(sub.currentPeriodEnd)}`
                  : sub?.currentPeriodEnd
                    ? `Renews ${formatDate(sub.currentPeriodEnd)}`
                    : tagline}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {activePlan && !isCanceling && (
              <Button
                variant="ghost"
                type="button"
                onClick={() => props.onOpenCustomerPortal()}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
              >
                Cancel plan
              </Button>
            )}
            {props.plansLink}
          </div>
        </div>
      </div>
    </div>
  );
}

export function BillingPlansView(props: {
  readonly plans: readonly BillingPlan[];
  readonly isLoading: boolean;
  readonly isFetching?: boolean;
  readonly loadingPlanId: string | null;
  readonly billingLink: ReactNode;
  readonly onAttachPlan: (input: AttachPlanInput) => Promise<void>;
  readonly onOpenCustomerPortal: () => Promise<void> | void;
}) {
  const displayPlans = orderedBillingPlans(props.plans);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="mb-8">
          {props.billingLink}
          <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
            Choose a plan
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Pick the plan that works for you. Upgrade or downgrade anytime.
          </p>
        </div>

        {props.isLoading ? (
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
            <div className="h-64 animate-pulse rounded-xl bg-muted" />
            <div className="h-64 animate-pulse rounded-xl bg-muted" />
          </div>
        ) : (
          <div
            className={[
              "grid gap-4 grid-cols-1 md:grid-cols-2 transition-opacity",
              props.isFetching ? "opacity-50 pointer-events-none" : "",
            ].join(" ")}
          >
            {displayPlans.map((plan) => {
              const meta = PLAN_META[plan.id];
              if (!meta) return null;

              const eligibility = plan.customerEligibility;
              const action = eligibility?.attachAction ?? "activate";
              const status = eligibility?.status;
              const isCanceling = eligibility?.canceling ?? false;
              const isCurrent = status === "active" && !isCanceling;
              const isScheduled = status === "scheduled";
              const label = isCanceling ? "Resume" : (ACTION_LABELS[action] ?? "Select");
              const isUpgradeAction = action === "upgrade" || action === "activate";

              return (
                <div
                  key={plan.id}
                  className={[
                    "flex flex-col rounded-xl border p-5",
                    isCurrent || isScheduled
                      ? "border-emerald-500/30 bg-emerald-500/[0.03]"
                      : "border-border",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-base font-semibold text-foreground leading-none">
                      {plan.name}
                    </p>
                    {isCurrent && (
                      <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                        Your plan
                      </Badge>
                    )}
                    {isCanceling && (
                      <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                        Canceling
                      </Badge>
                    )}
                    {isScheduled && (
                      <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                        Scheduled
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{meta.tagline}</p>

                  {plan.id === "free" ? (
                    <div className="mt-4 flex items-baseline gap-1.5">
                      <span className="text-2xl font-semibold text-foreground tabular-nums">
                        Free
                      </span>
                    </div>
                  ) : (
                    <div className="mt-4 flex items-baseline gap-1.5">
                      <span className="text-2xl font-semibold text-foreground tabular-nums">
                        ${plan.price?.amount ?? 0}
                      </span>
                      {plan.price?.interval && (
                        <span className="text-sm text-muted-foreground">
                          USD / {plan.price.interval}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="mt-4">
                    {(isCurrent && !isCanceling) || isScheduled ? (
                      <div className="flex h-9 items-center justify-center rounded-md border border-border bg-muted/30 text-sm font-medium text-muted-foreground">
                        {isCurrent ? "Current plan" : "Scheduled"}
                      </div>
                    ) : isCanceling ? (
                      <Button
                        type="button"
                        disabled={props.loadingPlanId !== null}
                        onClick={() => props.onOpenCustomerPortal()}
                        className="flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                      >
                        Resume
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        disabled={props.loadingPlanId !== null}
                        onClick={() =>
                          props.onAttachPlan({
                            planId: plan.id,
                            redirectMode: "always",
                            successUrl: window.location.href,
                          })
                        }
                        className={[
                          "flex h-9 w-full items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-60",
                          isUpgradeAction
                            ? "bg-primary text-primary-foreground hover:bg-primary/90"
                            : "border border-border bg-background text-foreground hover:bg-muted",
                        ].join(" ")}
                      >
                        {props.loadingPlanId === plan.id ? "Loading..." : label}
                      </Button>
                    )}
                  </div>

                  <ul role="list" className="mt-5 space-y-2">
                    {meta.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2 text-xs text-muted-foreground"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          className="mt-px size-3.5 shrink-0 text-primary/60"
                        >
                          <path
                            d="M3.5 8.5L6.5 11.5L12.5 5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

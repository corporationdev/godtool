import { feature, item, plan } from "atmn";

export const executions = feature({
  id: "executions",
  name: "Executions",
  type: "metered",
  consumable: true,
});

export const domainVerification = feature({
  id: "domain-verification",
  name: "Domain Verification",
  type: "boolean",
});

export const free = plan({
  id: "free",
  name: "Free",
  autoEnable: true,
  items: [
    item({
      featureId: executions.id,
      included: 5000,
      reset: { interval: "month" },
    }),
  ],
});

export const pro = plan({
  id: "pro",
  name: "Pro",
  price: {
    amount: 20,
    interval: "month",
  },
  items: [
    item({
      featureId: executions.id,
      included: 100000,
      reset: { interval: "month" },
    }),
  ],
});

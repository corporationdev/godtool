import { feature, item, plan } from "atmn";

export const hostedWorkerFallback = feature({
  id: "hosted-worker-fallback",
  name: "Hosted Worker Fallback",
  type: "boolean",
});

export const free = plan({
  id: "free",
  name: "Free",
  autoEnable: true,
  items: [],
});

export const pro = plan({
  id: "pro",
  name: "Pro",
  price: {
    amount: 10,
    interval: "month",
  },
  items: [
    item({ featureId: hostedWorkerFallback.id }),
  ],
});

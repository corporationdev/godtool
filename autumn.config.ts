import { feature, item, plan } from "atmn";

export const domainVerification = feature({
  id: "domain-verification",
  name: "Domain Verification",
  type: "boolean",
});

export const managedAuth = feature({
  id: "managed-auth",
  name: "Managed Auth",
  type: "boolean",
});

export const remoteMcp = feature({
  id: "remote-mcp",
  name: "Remote MCP",
  type: "boolean",
});

export const hostedWorkerFallback = feature({
  id: "hosted-worker-fallback",
  name: "Hosted Worker Fallback",
  type: "boolean",
});

// Plans
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
    item({
      featureId: managedAuth.id,
    }),
    item({
      featureId: remoteMcp.id,
    }),
    item({
      featureId: hostedWorkerFallback.id,
    }),
    item({
      featureId: domainVerification.id,
    }),
  ],
});

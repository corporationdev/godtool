import { resolveRuntimeContext } from "@executor/config/runtime";
import alchemy from "alchemy";
import {
  Assets,
  type Bindings,
  DurableObjectNamespace,
  Hyperdrive,
  Worker,
  WorkerLoader,
} from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";
import { config } from "dotenv";

config({ path: "./.env", override: false });

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const optionalEnv = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const addOptionalStringBinding = (bindings: Record<string, unknown>, name: string) => {
  const value = optionalEnv(name);
  if (value) {
    bindings[name] = value;
  }
};

const addOptionalSecretBinding = (bindings: Record<string, unknown>, name: string) => {
  const value = optionalEnv(name);
  if (value) {
    bindings[name] = alchemy.secret(value);
  }
};

const stage = requireEnv("STAGE");
const runtime = resolveRuntimeContext(stage);
const siteUrl = new URL(runtime.appUrl);
const serverUrl = new URL(runtime.serverUrl);

const app = await alchemy("godtool-cloud", {
  adopt: true,
  stateStore: process.env.CI
    ? (scope) => new CloudflareStateStore(scope, { forceUpdate: true })
    : undefined,
  stage,
});

const hyperdrive = await Hyperdrive("cloud-db", {
  name: "executor-cloud-db",
  origin: requireEnv("DATABASE_URL"),
});

const assets = await Assets({
  path: "./dist/client",
});

const mcpSession = DurableObjectNamespace("mcp-session", {
  className: "McpSessionDO",
});

const bindings: Bindings = {
  ASSETS: assets,
  HYPERDRIVE: hyperdrive,
  MCP_SESSION: mcpSession,
  LOADER: WorkerLoader(),
  WORKOS_API_KEY: alchemy.secret(requireEnv("WORKOS_API_KEY")),
  WORKOS_CLIENT_ID: requireEnv("WORKOS_CLIENT_ID"),
  WORKOS_COOKIE_PASSWORD: alchemy.secret(requireEnv("WORKOS_COOKIE_PASSWORD")),
  VITE_PUBLIC_SITE_URL: siteUrl.origin,
  VITE_SERVER_URL: serverUrl.origin,
  MCP_AUTHKIT_DOMAIN: runtime.authkitDomain,
  MCP_RESOURCE_ORIGIN: serverUrl.origin,
};

addOptionalSecretBinding(bindings, "AUTUMN_SECRET_KEY");
addOptionalSecretBinding(bindings, "SENTRY_DSN");
addOptionalSecretBinding(bindings, "AXIOM_TOKEN");
addOptionalSecretBinding(bindings, "BLAXEL_API_KEY");

addOptionalStringBinding(bindings, "VITE_PUBLIC_SENTRY_DSN");
addOptionalStringBinding(bindings, "AXIOM_DATASET");
addOptionalStringBinding(bindings, "AXIOM_TRACES_URL");
addOptionalStringBinding(bindings, "AXIOM_TRACES_SAMPLE_RATIO");
addOptionalStringBinding(bindings, "EXECUTOR_MCP_DEBUG");
addOptionalStringBinding(bindings, "BLAXEL_WORKSPACE");
addOptionalStringBinding(bindings, "BLAXEL_REGION");
addOptionalStringBinding(bindings, "BLAXEL_TEMPLATE_IMAGE");

export const cloud = await Worker("cloud", {
  name: runtime.cloudWorkerName,
  cwd: ".",
  entrypoint: "./dist/server/index.js",
  noBundle: true,
  compatibilityDate: "2025-04-01",
  compatibilityFlags: ["nodejs_compat"],
  observability: {
    enabled: true,
  },
  limits: {
    cpu_ms: 300000,
  },
  domains: runtime.appHostname ? [runtime.appHostname] : undefined,
  bindings,
});

await app.finalize();

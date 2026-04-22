import { resolve } from "node:path";

const REQUIRED_SECRET_KEYS = [
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
  "MCP_AUTHKIT_DOMAIN",
  "MCP_RESOURCE_ORIGIN",
] as const;

const OPTIONAL_SECRET_KEYS = [
  "AUTUMN_SECRET_KEY",
  "SENTRY_DSN",
  "AXIOM_TOKEN",
  "AXIOM_DATASET",
  "AXIOM_TRACES_URL",
  "AXIOM_TRACES_SAMPLE_RATIO",
  "EXECUTOR_MCP_DEBUG",
  "MCP_SESSION_REQUEST_SCOPED_RUNTIME",
] as const;

const readEnv = (name: string): string | undefined => {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const missingRequired = REQUIRED_SECRET_KEYS.filter((name) => !readEnv(name));

if (missingRequired.length > 0) {
  console.error(
    `Missing required env values: ${missingRequired.join(", ")}.\n` +
      "Load them first via the prod env file before syncing.",
  );
  process.exit(1);
}

const wranglerPath = resolve(import.meta.dirname, "../node_modules/.bin/wrangler");
const keysToSync = [...REQUIRED_SECRET_KEYS, ...OPTIONAL_SECRET_KEYS].filter((name) => readEnv(name));

for (const key of keysToSync) {
  const value = readEnv(key)!;
  console.log(`Syncing Cloudflare secret ${key}...`);

  const proc = Bun.spawn([wranglerPath, "secret", "put", key], {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });

  proc.stdin.write(value);
  proc.stdin.end();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`Failed syncing ${key} (exit ${exitCode}).`);
    process.exit(exitCode);
  }
}

console.log(`Synced ${keysToSync.length} Cloudflare secret${keysToSync.length === 1 ? "" : "s"}.`);

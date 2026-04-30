import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { resolveRuntimeContext } from "@executor/config/runtime";
import { config } from "dotenv";

const cloudflareApiBaseUrl = "https://api.cloudflare.com/client/v4";
const localOriginService = "http://127.0.0.1:3001";
const maxTunnelNameLength = 63;
const tunnelNamePrefix = "executor-cloud-";

config({ path: resolve(import.meta.dirname, "../.env"), override: false });

const stage = requireEnv("STAGE");
const runtime = resolveRuntimeContext(stage);

if (runtime.stageKind !== "dev") {
  throw new Error(
    `Local tunnels only run for dev stages, received "${stage}" (${runtime.stageKind}).`,
  );
}

const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const serverHostname = runtime.serverHostname;
const zoneId = await resolveZoneId();
const tunnelName = getTunnelName(stage);

const tunnel = await ensureTunnel(tunnelName);
await ensureTunnelConfiguration(tunnel.id, serverHostname);
await ensureDnsRecord(zoneId, serverHostname, `${tunnel.id}.cfargotunnel.com`);

console.log(`Tunnel -> ${runtime.serverUrl}`);
console.log(`MCP    -> ${new URL("/mcp", runtime.serverUrl).toString()}`);

const wrangler = spawn(process.execPath, ["x", "wrangler", "tunnel", "run", tunnel.id, "--log-level", "warn"], {
  cwd: resolve(import.meta.dirname, ".."),
  env: process.env,
  stdio: "inherit",
});

const stopChild = (signal: NodeJS.Signals) => {
  if (!wrangler.killed) {
    wrangler.kill(signal);
  }
};

process.on("SIGINT", () => stopChild("SIGINT"));
process.on("SIGTERM", () => stopChild("SIGTERM"));

wrangler.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

interface CloudflareEnvelope<Result> {
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
  result: Result;
  success: boolean;
}

interface TunnelRecord {
  deleted_at?: string | null;
  id: string;
  name: string;
}

interface DnsRecord {
  content: string;
  id: string;
  name: string;
  proxied: boolean;
  type: string;
}

async function ensureTunnel(name: string): Promise<TunnelRecord> {
  const existingTunnels = await cloudflareRequest<TunnelRecord[]>(
    `/accounts/${accountId}/cfd_tunnel?per_page=1000`,
  );
  const tunnel = existingTunnels.find(
    (candidate) => candidate.name === name && !candidate.deleted_at,
  );

  if (tunnel) {
    return tunnel;
  }

  return cloudflareRequest<TunnelRecord>(`/accounts/${accountId}/cfd_tunnel`, {
    body: {
      config_src: "cloudflare",
      name,
    },
    method: "POST",
  });
}

async function ensureTunnelConfiguration(tunnelId: string, hostname: string): Promise<void> {
  await cloudflareRequest(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
    body: {
      config: {
        ingress: [
          {
            hostname,
            originRequest: {},
            service: localOriginService,
          },
          {
            service: "http_status:404",
          },
        ],
      },
    },
    method: "PUT",
  });
}

async function ensureDnsRecord(zoneId: string, hostname: string, tunnelTarget: string): Promise<void> {
  const existingRecords = await cloudflareRequest<DnsRecord[]>(
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`,
  );
  const conflictingRecord = existingRecords.find((record) => record.type !== "CNAME");

  if (conflictingRecord) {
    throw new Error(
      `Cannot point ${hostname} at the local tunnel because Cloudflare already has a ${conflictingRecord.type} record with that name.`,
    );
  }

  const existingRecord = existingRecords.find((record) => record.type === "CNAME");
  if (existingRecord) {
    if (existingRecord.content === tunnelTarget && existingRecord.proxied) {
      return;
    }

    await cloudflareRequest(`/zones/${zoneId}/dns_records/${existingRecord.id}`, {
      body: {
        content: tunnelTarget,
        name: hostname,
        proxied: true,
        type: "CNAME",
      },
      method: "PATCH",
    });
    return;
  }

  await cloudflareRequest(`/zones/${zoneId}/dns_records`, {
    body: {
      content: tunnelTarget,
      name: hostname,
      proxied: true,
      type: "CNAME",
    },
    method: "POST",
  });
}

async function resolveZoneId(): Promise<string> {
  const configuredZoneId = normalizeEnvValue(process.env.CLOUDFLARE_ZONE_ID);
  if (configuredZoneId) {
    return configuredZoneId;
  }

  const rootDomain = normalizeEnvValue(process.env.CLOUDFLARE_ZONE_NAME) ?? "godtool.dev";
  const zones = await cloudflareRequest<Array<{ id: string; name: string }>>(
    `/zones?name=${encodeURIComponent(rootDomain)}`,
  );
  const zone = zones.find((candidate) => candidate.name === rootDomain);

  if (zone) {
    return zone.id;
  }

  throw new Error(
    `Could not find a Cloudflare zone for ${rootDomain}. ` +
      "Set CLOUDFLARE_ZONE_ID or CLOUDFLARE_ZONE_NAME in apps/cloud/.env.",
  );
}

async function cloudflareRequest<Result>(
  path: string,
  options: {
    body?: unknown;
    method?: "GET" | "PATCH" | "POST" | "PUT";
  } = {},
): Promise<Result> {
  const response = await fetch(`${cloudflareApiBaseUrl}${path}`, {
    body: options.body ? JSON.stringify(options.body) : undefined,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    method: options.method ?? "GET",
  });

  const payload = (await response.json()) as CloudflareEnvelope<Result>;
  if (response.ok && payload.success) {
    return payload.result;
  }

  const details = [...(payload.errors ?? []), ...(payload.messages ?? [])]
    .map((entry) => {
      const code = entry.code ? `[${entry.code}] ` : "";
      return `${code}${entry.message ?? "Unknown Cloudflare error"}`;
    })
    .join("\n- ");
  const formattedDetails = details ? `\n- ${details}` : "";
  const permissionHint =
    response.status === 403
      ? "\nRequired permissions: Account Cloudflare Tunnel Edit, Zone DNS Edit, and Zone Zone Read."
      : "";

  throw new Error(
    `Cloudflare API request failed (${response.status} ${response.statusText}) for ${path}.${formattedDetails}${permissionHint}`,
  );
}

function getTunnelName(stageName: string): string {
  const baseName = `${tunnelNamePrefix}${stageName}`;
  if (baseName.length <= maxTunnelNameLength) {
    return baseName;
  }

  return `${baseName.slice(0, maxTunnelNameLength - 9)}-${shortHash(stageName)}`;
}

function shortHash(input: string): string {
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) % 4_294_967_296;
  }

  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function requireEnv(name: string): string {
  const value = normalizeEnvValue(process.env[name]);
  if (value) {
    return value;
  }

  throw new Error(`Missing required environment variable: ${name}`);
}

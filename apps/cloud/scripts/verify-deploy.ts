import { resolveRuntimeContext } from "@executor/config/runtime";

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

type CloudflareResponse<Result> = {
  success: boolean;
  errors?: ReadonlyArray<{ code: number; message: string }>;
  result: Result;
};

const token = requireEnv("CLOUDFLARE_API_TOKEN");
const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const stage = requireEnv("STAGE");
const runtime = resolveRuntimeContext(stage);
const marketingWorkerName =
  runtime.stageKind === "production" ? "godtool-marketing-production" : undefined;
const marketingDomains = ["godtool.dev", "www.godtool.dev"];

const cloudflareFetch = async <Result>(path: string): Promise<Result> => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Cloudflare API ${path} failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as CloudflareResponse<Result>;
  if (!data.success) {
    const detail = data.errors?.map((error) => `${error.code}: ${error.message}`).join(", ");
    throw new Error(
      `Cloudflare API ${path} returned unsuccessful response: ${detail ?? "unknown"}`,
    );
  }

  return data.result;
};

const workerScripts = await cloudflareFetch<Array<{ id: string }>>(
  `/accounts/${accountId}/workers/scripts`,
);

if (!workerScripts.some((script) => script.id === runtime.cloudWorkerName)) {
  throw new Error(`Expected deployed worker ${runtime.cloudWorkerName} to exist in Cloudflare`);
}

if (marketingWorkerName && !workerScripts.some((script) => script.id === marketingWorkerName)) {
  throw new Error(`Expected deployed worker ${marketingWorkerName} to exist in Cloudflare`);
}

if (runtime.appHostname) {
  const domains = await cloudflareFetch<
    Array<{ hostname: string; service: string; environment?: string }>
  >(`/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(runtime.appHostname)}`);

  if (!domains.some((domain) => domain.hostname === runtime.appHostname)) {
    throw new Error(`Expected worker domain ${runtime.appHostname} to exist in Cloudflare`);
  }

  const zoneName = runtime.appHostname.split(".").slice(-2).join(".");
  const zones = await cloudflareFetch<Array<{ id: string }>>(
    `/zones?name=${encodeURIComponent(zoneName)}`,
  );
  const zoneId = zones[0]?.id;

  if (!zoneId) {
    throw new Error(`Expected Cloudflare zone ${zoneName} to exist`);
  }

  const dnsRecords = await cloudflareFetch<Array<{ type: string; name: string }>>(
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(runtime.appHostname)}`,
  );

  if (!dnsRecords.some((record) => record.name === runtime.appHostname)) {
    throw new Error(`Expected DNS record for ${runtime.appHostname} to exist in Cloudflare`);
  }
}

if (marketingWorkerName) {
  for (const hostname of marketingDomains) {
    const domains = await cloudflareFetch<
      Array<{ hostname: string; service: string; environment?: string }>
    >(`/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(hostname)}`);

    if (
      !domains.some(
        (domain) => domain.hostname === hostname && domain.service === marketingWorkerName,
      )
    ) {
      throw new Error(`Expected worker domain ${hostname} to be bound to ${marketingWorkerName}`);
    }
  }
}

console.log(
  JSON.stringify({
    ok: true,
    stage,
    worker: runtime.cloudWorkerName,
    marketingWorker: marketingWorkerName,
    appHostname: runtime.appHostname,
    marketingHostnames: marketingWorkerName ? marketingDomains : [],
  }),
);

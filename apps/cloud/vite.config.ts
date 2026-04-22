import { defineConfig, type Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const maxDnsLabelLength = 63;
const rootDomain = "godtool.dev";
const serverSubdomainPrefix = "server-";

// Dev-only: the cloudflare vite-plugin bridges outbound fetches (JWKS,
// OAuth metadata proxy, etc.) through node undici in the host process. If
// a pooled keep-alive socket gets RST'd while no listener is attached, the
// `'error'` emit is unhandled and tears down the whole dev server. Log
// enough to identify the offender and keep the server alive.
const devCrashGuard = (): Plugin => {
  let installed = false;
  const install = () => {
    if (installed) return;
    installed = true;
    process.on("uncaughtException", (err, origin) => {
      console.error(
        `[dev-crash-guard] uncaughtException (origin=${origin}):`,
        err,
      );
    });
    process.on("unhandledRejection", (reason, promise) => {
      console.error("[dev-crash-guard] unhandledRejection:", reason, promise);
    });
  };
  return {
    name: "dev-crash-guard",
    apply: "serve",
    configureServer: install,
  };
};

function shortHash(input: string): string {
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) % 4_294_967_296;
  }

  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

function getSingleLabelSubdomain(prefix: string, value: string): string {
  const baseLabel = `${prefix}${value}`;

  if (baseLabel.length <= maxDnsLabelLength) {
    return baseLabel;
  }

  const hashSuffix = `-${shortHash(value)}`;
  const maxValueLength = maxDnsLabelLength - prefix.length - hashSuffix.length;

  return `${prefix}${value.slice(0, maxValueLength)}${hashSuffix}`;
}

const getAllowedHosts = (): string[] | undefined => {
  const stage = process.env.STAGE?.trim();
  if (!stage) {
    return undefined;
  }

  if (!(stage === "dev" || stage.startsWith("dev-"))) {
    return undefined;
  }

  return [`${getSingleLabelSubdomain(serverSubdomainPrefix, stage)}.${rootDomain}`];
};

export default defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    allowedHosts: getAllowedHosts(),
  },
  plugins: [
    devCrashGuard(),
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" }, inspectorPort: false }),
    tanstackStart(),
    react(),
  ],
});

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { resolveRuntimeContext } from "@executor/config/runtime";
import { deriveEnvTier, resolveStage, type StageMode } from "@executor/config/stage";
import { parse as parseDotEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "..");
const templatePath = resolve(repoRoot, ".env.op");
const envAssignmentRegex = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;
const onePasswordReferenceMarker = "op://";
const envTierVariableRegex = /\$\{ENV_TIER\}/g;
const newlineRegex = /\r?\n/;
const stageVariableRegex = /\$\{STAGE\}/g;
const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: bun secrets:inject [--dev|--sandbox|--stage <stage>]");
  process.exit(0);
}

const useDev = argv.includes("--dev");
const useSandbox = argv.includes("--sandbox");
const stageFlagIndex = argv.indexOf("--stage");
const explicitStage = stageFlagIndex >= 0 ? argv[stageFlagIndex + 1] : undefined;

if (useDev && useSandbox) {
  throw new Error("Use only one mode flag: --dev or --sandbox");
}

if (stageFlagIndex >= 0 && !explicitStage) {
  throw new Error("Missing value for --stage");
}

if ((useDev || useSandbox) && explicitStage) {
  throw new Error("Use either --stage or a local mode flag, not both");
}

if (!existsSync(templatePath)) {
  throw new Error(`Missing ${templatePath}. Add the project secret template first.`);
}

const stageMode: StageMode = useSandbox ? "sandbox" : "dev";
const stage = explicitStage ?? resolveStage(stageMode);
const envTier = deriveEnvTier(stage);
const runtime = resolveRuntimeContext(stage);
const template = readFileSync(templatePath, "utf8")
  .replace(stageVariableRegex, stage)
  .replace(envTierVariableRegex, envTier);
const secrets = {
  ...normalizeEnvValues(parseDotEnv(injectSecretsTemplate(template))),
  VITE_PUBLIC_SITE_URL: runtime.appUrl,
  MCP_AUTHKIT_DOMAIN: runtime.authkitDomain,
  MCP_RESOURCE_ORIGIN: runtime.appUrl,
};
const envExamples = findEnvExamples(repoRoot);

if (envExamples.length === 0) {
  throw new Error("No .env.example files found.");
}

const outputPaths: string[] = [];
for (const examplePath of envExamples) {
  const outputPath = resolve(dirname(examplePath), ".env");
  const existingEnv = existsSync(outputPath) ? parseDotEnv(readFileSync(outputPath, "utf8")) : {};
  const exampleRaw = readFileSync(examplePath, "utf8");

  const renderedLines = exampleRaw.split(/\r?\n/).map((line) => {
    const match = line.match(envAssignmentRegex);
    if (!match) {
      return line;
    }

    const prefix = match[1] ?? "";
    const key = match[2];
    const equals = match[3] ?? "=";
    const exampleValue = match[4] ?? "";
    if (!key) {
      return line;
    }
    if (key === "STAGE") {
      return "";
    }

    const resolvedValue = secrets[key] ?? normalizeEnvValue(existingEnv[key]) ?? exampleValue;
    return `${prefix}${key}${equals}${resolvedValue}`;
  });

  const renderedBody = renderedLines.join("\n").trimEnd();
  const stageBlock = `# Stage\nSTAGE=${stage}`;
  const rendered = renderedBody.length > 0 ? `${stageBlock}\n\n${renderedBody}` : stageBlock;

  writeFileSync(outputPath, `${rendered}\n`, "utf8");
  outputPaths.push(outputPath);
}

console.log(`Injected environment files for stage=${stage}, tier=${envTier}:`);
for (const outputPath of outputPaths) {
  console.log(`- ${outputPath}`);
}

function findEnvExamples(directoryPath: string): string[] {
  const envExamples: string[] = [];

  for (const entry of readdirSync(directoryPath)) {
    if (entry === ".git" || entry === "node_modules") {
      continue;
    }

    const entryPath = join(directoryPath, entry);
    const entryStats = statSync(entryPath);

    if (entryStats.isDirectory()) {
      envExamples.push(...findEnvExamples(entryPath));
      continue;
    }

    if (entry === ".env.example") {
      envExamples.push(entryPath);
    }
  }

  return envExamples.sort();
}

function injectSecretsTemplate(template: string): string {
  if (!hasOnePasswordReferences(template)) {
    return template;
  }

  const tempDirectory = mkdtempSync(join(tmpdir(), "executor-op-"));
  const resolvedTemplatePath = resolve(tempDirectory, ".env.resolved");
  writeFileSync(resolvedTemplatePath, template, "utf8");

  const injectResult = spawnSync("op", ["inject", "-i", resolvedTemplatePath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  rmSync(tempDirectory, { force: true, recursive: true });

  if (injectResult.status !== 0) {
    const errorOutput =
      injectResult.error?.message ?? (injectResult.stderr.trim() || injectResult.stdout.trim());
    throw new Error(`op inject failed. ${errorOutput}`);
  }

  return injectResult.stdout;
}

function hasOnePasswordReferences(template: string): boolean {
  return template.split(newlineRegex).some((line) => {
    const match = line.match(envAssignmentRegex);
    return Boolean(match?.[4]?.includes(onePasswordReferenceMarker));
  });
}

function normalizeEnvValues(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) => {
      const normalizedValue = normalizeEnvValue(value);
      return normalizedValue === undefined ? [] : [[key, normalizedValue]];
    }),
  );
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

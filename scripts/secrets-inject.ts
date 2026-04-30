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

import {
  deriveEnvTier,
  getStageKind,
  resolveStage,
  type StageKind,
  type StageMode,
} from "@executor/config/stage";
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
  console.log("Usage: bun secrets:inject [--dev|--stage <stage>]");
  process.exit(0);
}

const useDev = argv.includes("--dev");
const stageFlagIndex = argv.indexOf("--stage");
const explicitStage = stageFlagIndex >= 0 ? argv[stageFlagIndex + 1] : undefined;

if (stageFlagIndex >= 0 && !explicitStage) {
  throw new Error("Missing value for --stage");
}

if (useDev && explicitStage) {
  throw new Error("Use either --stage or a local mode flag, not both");
}

if (!existsSync(templatePath)) {
  throw new Error(`Missing ${templatePath}. Add the project secret template first.`);
}

const stageMode: StageMode = "dev";
const stage = explicitStage ?? resolveStage(stageMode);
const envTier = deriveEnvTier(stage);
const stageKind = getStageKind(stage);
const template = readFileSync(templatePath, "utf8")
  .replace(stageVariableRegex, stage)
  .replace(envTierVariableRegex, envTier);
const envExamples = findEnvExamples(repoRoot);

if (envExamples.length === 0) {
  throw new Error("No .env.example files found.");
}

const templateKeys = collectEnvExampleKeys(envExamples);
const secrets = normalizeEnvValues(
  parseDotEnv(injectSecretsTemplate(filterSecretsTemplate(template, templateKeys))),
);
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

    const existingValue = normalizeEnvValue(existingEnv[key]);
    const resolvedValue =
      shouldPreserveExistingValue(key, stageKind) && existingValue
        ? existingValue
        : (secrets[key] ?? existingValue ?? exampleValue);
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
    if (
      entry === ".git" ||
      entry === ".reference" ||
      entry === ".turbo" ||
      entry === ".wrangler" ||
      entry === "dist" ||
      entry === "node_modules"
    ) {
      continue;
    }

    const entryPath = join(directoryPath, entry);
    let entryStats;
    try {
      entryStats = statSync(entryPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw cause;
    }

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

function collectEnvExampleKeys(examplePaths: readonly string[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const examplePath of examplePaths) {
    for (const line of readFileSync(examplePath, "utf8").split(newlineRegex)) {
      const match = line.match(envAssignmentRegex);
      const key = match?.[2];
      if (key) {
        keys.add(key);
      }
    }
  }
  return keys;
}

function filterSecretsTemplate(template: string, keys: ReadonlySet<string>): string {
  return template
    .split(newlineRegex)
    .filter((line) => {
      const match = line.match(envAssignmentRegex);
      const key = match?.[2];
      return !key || keys.has(key);
    })
    .join("\n");
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

function shouldPreserveExistingValue(key: string, stageKind: StageKind): boolean {
  return key === "DATABASE_URL" && stageKind === "dev";
}

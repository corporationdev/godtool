import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const runtimeEntryPath = resolve(repoRoot, "apps/cloud/src/sandbox-runtime/server.ts");
const generatedModulePath = resolve(
  repoRoot,
  "apps/cloud/src/services/execute-runtime.generated.ts",
);

const tempDirectory = mkdtempSync(join(tmpdir(), "executor-sandbox-runtime-"));
const outputPath = resolve(tempDirectory, "server.js");

try {
  const buildResult = spawnSync(
    "bun",
    ["build", runtimeEntryPath, "--target", "bun", "--format", "esm", "--outfile", outputPath],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    },
  );

  const buildOutput = [buildResult.stdout, buildResult.stderr]
    .filter((value) => value && value.trim().length > 0)
    .join("\n");

  if (buildOutput.length > 0) {
    console.log(buildOutput.trim());
  }

  if (buildResult.status !== 0) {
    throw new Error(buildResult.error?.message ?? "Sandbox execute runtime build failed.");
  }

  const serverRuntime = readFileSync(outputPath, "utf8");

  const generatedModule = `// @ts-nocheck
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: generated sandbox runtime bundle

export const EXECUTE_RUNTIME_ASSETS: {
  server: string;
} = {
  server: ${JSON.stringify(serverRuntime)}
};
`;

  writeFileSync(generatedModulePath, generatedModule, "utf8");
  console.log(`Generated sandbox runtime module at ${generatedModulePath.replace(`${repoRoot}/`, "")}`);
} finally {
  rmSync(tempDirectory, { force: true, recursive: true });
}

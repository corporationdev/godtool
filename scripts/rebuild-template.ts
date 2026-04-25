import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { resolveRuntimeContext } from "@executor/config/runtime";
import { resolveStage, type StageMode } from "@executor/config/stage";

const repoRoot = resolve(import.meta.dirname, "..");
const templateDirectory = resolve(repoRoot, "packages/infra/blaxel/godtool");

const getArgValue = (name: string): string | undefined => {
  const equalsArg = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (equalsArg) {
    return equalsArg.slice(name.length + 1);
  }

  const index = process.argv.indexOf(name);
  const nextArg = process.argv[index + 1];
  if (index >= 0 && nextArg && !nextArg.startsWith("-")) {
    return nextArg;
  }

  return undefined;
};

const stageMode: StageMode = "dev";
const explicitStage = getArgValue("--stage") || process.env.STAGE?.trim();
const stage = explicitStage || resolveStage(stageMode);
const runtime = resolveRuntimeContext(stage);
const dryRun = process.argv.includes("--dry-run");
const pushArgs = ["push", "--workspace", runtime.blaxelWorkspace];

console.log(
  `Pushing Blaxel template for stage "${runtime.stage}" to workspace "${runtime.blaxelWorkspace}" (${runtime.blaxelTemplateImage}).`,
);

if (dryRun) {
  console.log(`Dry run: bl ${pushArgs.join(" ")}`);
  process.exit(0);
}

const pushResult = spawnSync("bl", pushArgs, {
  cwd: templateDirectory,
  encoding: "utf8",
  env: {
    ...process.env,
    BL_REGION: runtime.blaxelRegion,
    BL_WORKSPACE: runtime.blaxelWorkspace,
    BLAXEL_REGION: runtime.blaxelRegion,
    BLAXEL_TEMPLATE_IMAGE: runtime.blaxelTemplateImage,
    BLAXEL_WORKSPACE: runtime.blaxelWorkspace,
    STAGE: runtime.stage,
  },
});

const commandOutput = [pushResult.stdout, pushResult.stderr]
  .filter((value) => value && value.trim().length > 0)
  .join("\n");

if (commandOutput.length > 0) {
  console.log(commandOutput.trim());
}

if (pushResult.status !== 0) {
  throw new Error(
    pushResult.error?.message ??
      `Blaxel template push failed for stage "${runtime.stage}" in workspace "${runtime.blaxelWorkspace}".`,
  );
}

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const templateDirectory = resolve(repoRoot, "packages/infra/blaxel/godtool");

const pushResult = spawnSync("bl", ["push"], {
  cwd: templateDirectory,
  encoding: "utf8",
  env: process.env,
});

const commandOutput = [pushResult.stdout, pushResult.stderr]
  .filter((value) => value && value.trim().length > 0)
  .join("\n");

if (commandOutput.length > 0) {
  console.log(commandOutput.trim());
}

if (pushResult.status !== 0) {
  throw new Error(pushResult.error?.message ?? "Blaxel template push failed.");
}

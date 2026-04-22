import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const repoRoot = resolve(import.meta.dirname, "..");

console.log("Installing dependencies...");
runCommand("bun", ["install"], repoRoot);

console.log("Injecting environment files...");
runCommand("bun", ["run", "secrets:inject", ...argv], repoRoot);

console.log("Setup complete.");

function runCommand(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(result.error?.message ?? `Command failed: ${command} ${args.join(" ")}`);
  }
}

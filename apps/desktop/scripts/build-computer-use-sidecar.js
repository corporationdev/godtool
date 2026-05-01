const { spawnSync } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const defaultSource = join(root, "native", "computer-use-mac", "main.swift");
const defaultResourcesDir = join(root, "resources");
const signingIdentifier = "com.executor.computer-use-mac";

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = "true";
    }
  }
  return options;
};

const normalizeArch = (arch) => {
  if (arch === "x64" || arch === "x86_64") return "x64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  throw new Error(`Unsupported Computer Use macOS arch: ${arch}`);
};

const targetForArch = (arch) =>
  arch === "arm64" ? "arm64-apple-macosx14.0" : "x86_64-apple-macosx14.0";

const binaryNameForArch = (arch) => `computer-use-darwin-${arch}`;

const run = (command, args, message) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw new Error(`${message}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${message}: exited with ${result.status}`);
  }
};

const buildComputerUseSidecar = (input = {}) => {
  if (process.platform !== "darwin") {
    return null;
  }

  const arch = normalizeArch(input.arch ?? process.arch);
  const source = input.source ?? defaultSource;
  const resourcesDir = input.resourcesDir ?? defaultResourcesDir;
  const outputDir = input.outputDir ?? join(resourcesDir, "computer-use");
  const output = input.output ?? join(outputDir, binaryNameForArch(arch));

  if (!existsSync(source)) {
    throw new Error(`Computer Use source not found at ${source}`);
  }

  mkdirSync(outputDir, { recursive: true });

  run(
    "xcrun",
    [
      "swiftc",
      source,
      "-target",
      targetForArch(arch),
      "-o",
      output,
      "-framework",
      "AppKit",
      "-framework",
      "ApplicationServices",
      "-framework",
      "CoreGraphics",
      "-framework",
      "Foundation",
      "-framework",
      "Network",
      "-framework",
      "ScreenCaptureKit",
    ],
    "computer-use mac sidecar failed to build",
  );

  run(
    "codesign",
    ["--force", "--sign", "-", "--identifier", signingIdentifier, output],
    "computer-use mac sidecar signing failed",
  );

  chmodSync(output, 0o755);
  console.log(`computer-use binary copied to ${output}`);
  return output;
};

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const output = buildComputerUseSidecar({
      arch: options.arch,
      source: options.source,
      resourcesDir: options["resources-dir"],
      outputDir: options["output-dir"],
      output: options.output,
    });
    if (!output) {
      console.log("computer-use mac sidecar skipped on non-darwin platform");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = { buildComputerUseSidecar };

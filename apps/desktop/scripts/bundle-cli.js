/**
 * Builds the executor CLI binary and copies it into the desktop app's
 * resources/ folder so electron-builder can bundle it as a sidecar.
 */
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, cpSync, chmodSync, realpathSync } = require("node:fs");
const { resolve, join, dirname } = require("node:path");

const root = resolve(__dirname, "..");
const repoRoot = resolve(root, "../..");
const cliRoot = resolve(repoRoot, "apps/cli");
const resourcesDir = resolve(root, "resources");

// Build CLI for current platform
console.log("Building executor CLI binary...");

// Resolve bun binary path explicitly
const { homedir } = require("node:os");
const resolveCommand = (name) => {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
    encoding: "utf-8",
  });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
};

const bunBin =
  resolveCommand("bun") ??
  resolve(process.env.BUN_INSTALL || join(homedir(), ".bun"), "bin", "bun");

const result = spawnSync(bunBin, ["run", "src/build.ts", "binary", "--single"], {
  cwd: cliRoot,
  stdio: "inherit",
});

if (result.error) {
  console.error("CLI build spawn error:", result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`CLI build failed with exit code ${result.status}`);
  process.exit(1);
}

// Find the built binary
const platform = process.platform === "win32" ? "windows" : process.platform;
const arch = process.arch === "arm64" ? "arm64" : "x64";
const binaryName = process.platform === "win32" ? "executor.exe" : "executor";
const targetDir = join(cliRoot, "dist", `executor-${platform}-${arch}`, "bin");
const agentBrowserPlatform = process.platform === "win32" ? "win32" : process.platform;
const agentBrowserBinaryName =
  process.platform === "win32"
    ? `agent-browser-${agentBrowserPlatform}-${arch}.exe`
    : `agent-browser-${agentBrowserPlatform}-${arch}`;
const computerUseBinaryName =
  process.platform === "win32"
    ? `computer-use-${agentBrowserPlatform}-${arch}.exe`
    : `computer-use-${agentBrowserPlatform}-${arch}`;
const computerUseSigningIdentifier = "com.executor.computer-use-mac";

const signComputerUseBinary = (binaryPath) => {
  const result = spawnSync(
    "codesign",
    ["--force", "--sign", "-", "--identifier", computerUseSigningIdentifier, binaryPath],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.warn(
      "computer-use mac sidecar signing failed; permissions may not persist across rebuilds",
    );
  }
};

if (!existsSync(join(targetDir, binaryName))) {
  console.error(`Binary not found at ${join(targetDir, binaryName)}`);
  process.exit(1);
}

// Copy to resources/
mkdirSync(resourcesDir, { recursive: true });
cpSync(join(targetDir, binaryName), join(resourcesDir, binaryName));
chmodSync(join(resourcesDir, binaryName), 0o755);

// Copy QuickJS WASM if present
const wasmPath = join(targetDir, "emscripten-module.wasm");
if (existsSync(wasmPath)) {
  cpSync(wasmPath, join(resourcesDir, "emscripten-module.wasm"));
}

const agentBrowserResolution = spawnSync("which", ["agent-browser"], {
  encoding: "utf-8",
});
if (agentBrowserResolution.status === 0) {
  const agentBrowserShim = realpathSync(agentBrowserResolution.stdout.trim());
  const agentBrowserDir = dirname(agentBrowserShim);
  const agentBrowserBinary = join(agentBrowserDir, agentBrowserBinaryName);
  const targetAgentBrowserDir = join(resourcesDir, "agent-browser");

  if (existsSync(agentBrowserBinary)) {
    mkdirSync(targetAgentBrowserDir, { recursive: true });
    cpSync(agentBrowserBinary, join(targetAgentBrowserDir, agentBrowserBinaryName));
    chmodSync(join(targetAgentBrowserDir, agentBrowserBinaryName), 0o755);
    console.log(`agent-browser binary copied to ${targetAgentBrowserDir}`);
  } else {
    console.warn(`agent-browser is installed, but ${agentBrowserBinaryName} was not found`);
  }
} else {
  console.warn(
    "agent-browser is not installed; packaged browser tools will need an external binary",
  );
}

if (process.platform === "darwin") {
  const computerUseSource = join(root, "native", "computer-use-mac", "main.swift");
  const computerUseDevBinary = join(root, "native", "computer-use-mac", "computer-use-mac");
  const targetComputerUseDir = join(resourcesDir, "computer-use");
  const computerUseResult = spawnSync(
    "swiftc",
    [
      computerUseSource,
      "-o",
      computerUseDevBinary,
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
    { stdio: "inherit" },
  );

  if (computerUseResult.status === 0) {
    signComputerUseBinary(computerUseDevBinary);
    mkdirSync(targetComputerUseDir, { recursive: true });
    cpSync(computerUseDevBinary, join(targetComputerUseDir, computerUseBinaryName));
    chmodSync(join(targetComputerUseDir, computerUseBinaryName), 0o755);
    console.log(`computer-use binary copied to ${targetComputerUseDir}`);
  } else {
    console.warn(
      "computer-use mac sidecar failed to build; packaged computer use tools will be unavailable",
    );
  }
}

console.log(`Sidecar binary copied to ${resourcesDir}`);

const { spawn, spawnSync } = require("node:child_process");
const { resolve, join } = require("node:path");

const root = resolve(__dirname, "..");
const computerUseSigningIdentifier = "com.executor.computer-use-mac";

const signComputerUseBinary = (binaryPath) => {
  const result = spawnSync(
    "codesign",
    ["--force", "--sign", "-", "--identifier", computerUseSigningIdentifier, binaryPath],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.warn("Computer Use sidecar signing failed; macOS permissions may not persist across rebuilds");
  }
};

if (process.platform === "darwin") {
  const computerUseSource = join(root, "native", "computer-use-mac", "main.swift");
  const computerUseBinary = join(root, "native", "computer-use-mac", "computer-use-mac");
  const computerUseResult = spawnSync(
    "swiftc",
    [
      computerUseSource,
      "-o",
      computerUseBinary,
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

  if (computerUseResult.status !== 0) {
    console.error("Computer Use sidecar compilation failed");
    process.exit(computerUseResult.status ?? 1);
  }

  signComputerUseBinary(computerUseBinary);
}

// First compile TypeScript
const tsc = spawn("npx", ["tsc"], { cwd: root, stdio: "inherit" });

tsc.on("exit", (code) => {
  if (code !== 0) {
    console.error("TypeScript compilation failed");
    process.exit(1);
  }

  // Then launch Electron
  const electron = spawn("npx", ["electron", "."], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
  });

  electron.on("exit", (code) => {
    process.exit(code ?? 0);
  });
});

const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");

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

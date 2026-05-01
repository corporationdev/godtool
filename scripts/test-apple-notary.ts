import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { config as loadDotEnv } from "dotenv";

type NotarySubmitResult = {
  readonly id?: string;
  readonly status?: string;
  readonly message?: string;
  readonly name?: string;
};

const repoRoot = resolve(import.meta.dirname, "..");
loadDotEnv({ path: join(repoRoot, ".env"), quiet: true });

const opVault = process.env.OP_VAULT ?? "godtool-dev";
const opItem = process.env.OP_ITEM ?? "Apple";
const notaryTimeout = process.env.APPLE_NOTARY_TIMEOUT ?? "10m";
const bundleId = process.env.APPLE_NOTARY_PROBE_BUNDLE_ID ?? "com.godtool.notary-probe";
const appName = "GODTOOL Notary Probe";

const main = () => {
  const credentials = loadCredentials();
  const tempDir = mkdtempSync(join(tmpdir(), "godtool-notary-probe-"));
  const keyPath = join(tempDir, "AuthKey.p8");
  const appPath = join(tempDir, `${appName}.app`);
  const zipPath = join(tempDir, `${appName}.zip`);

  try {
    writeFileSync(keyPath, Buffer.from(credentials.appleApiKeyBase64, "base64"), {
      mode: 0o600,
    });

    const identity = envValue("APPLE_CODESIGN_IDENTITY") ?? findDeveloperIdIdentity();
    createProbeApp(tempDir, appPath);
    signProbeApp(appPath, identity);
    zipProbeApp(appPath, zipPath);

    console.log(`Submitting local notarization probe ${zipPath}`);
    const result = run("xcrun", [
      "notarytool",
      "submit",
      zipPath,
      "--key",
      keyPath,
      "--key-id",
      credentials.appleApiKeyId,
      "--issuer",
      credentials.appleApiIssuer,
      "--wait",
      "--timeout",
      notaryTimeout,
      "--output-format",
      "json",
    ]);

    const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const parsed = parseNotaryJson(combinedOutput);

    if (result.status !== 0) {
      fail(
        `Apple notarization probe failed or timed out after ${notaryTimeout}.`,
        parsed ? formatNotaryResult(parsed) : combinedOutput,
      );
    }

    if (parsed?.status === "Accepted") {
      ok(`Apple notarization is working. Probe ${parsed.id ?? "unknown-id"} was accepted.`);
      return;
    }

    fail(
      `Apple notarization probe did not reach Accepted.`,
      parsed ? formatNotaryResult(parsed) : combinedOutput,
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
};

const createProbeApp = (tempDir: string, appPath: string) => {
  const contentsPath = join(appPath, "Contents");
  const macOsPath = join(contentsPath, "MacOS");
  const executablePath = join(macOsPath, "probe");
  const sourcePath = join(tempDir, "probe.c");

  mkdirSync(macOsPath, { recursive: true });
  writeFileSync(
    join(contentsPath, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>probe</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
</dict>
</plist>
`,
  );

  writeFileSync(
    sourcePath,
    `#include <stdio.h>
int main(void) {
  puts("GODTOOL notarization probe");
  return 0;
}
`,
  );

  mustRun("xcrun", ["clang", sourcePath, "-o", executablePath], "Failed to compile local notarization probe.");
  chmodSync(executablePath, 0o755);
};

const signProbeApp = (appPath: string, identity: string) => {
  console.log(`Signing local probe with ${identity}`);
  mustRun(
    "codesign",
    ["--force", "--sign", identity, "--timestamp", "--options", "runtime", appPath],
    "Failed to sign local notarization probe.",
  );
  mustRun(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    "Signed local notarization probe did not pass codesign verification.",
  );
};

const zipProbeApp = (appPath: string, zipPath: string) => {
  mustRun("ditto", ["-c", "-k", "--keepParent", appPath, zipPath], "Failed to zip local notarization probe.");
};

const findDeveloperIdIdentity = () => {
  const result = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  if (result.status !== 0) {
    fail("Could not list local code signing identities.", result.stderr || result.stdout);
  }

  const match = result.stdout.match(/"([^"]*Developer ID Application:[^"]+)"/);
  if (!match?.[1]) {
    fail(
      "No local Developer ID Application signing identity found. Import your .p12 into Keychain or set APPLE_CODESIGN_IDENTITY.",
      result.stdout,
    );
  }

  return match[1];
};

const loadCredentials = () => {
  const appleApiKeyBase64 =
    envValue("APPLE_API_KEY_BASE64") ?? opRead(`op://${opVault}/${opItem}/apple-api-key-base64`);
  const appleApiKeyId =
    envValue("APPLE_API_KEY_ID") ?? opRead(`op://${opVault}/${opItem}/apple-api-key-id`);
  const appleApiIssuer =
    envValue("APPLE_API_ISSUER") ?? opRead(`op://${opVault}/${opItem}/apple-api-issuer`);

  if (!appleApiKeyBase64 || !appleApiKeyId || !appleApiIssuer) {
    fail("Missing Apple notarization credentials.");
  }

  return { appleApiKeyBase64, appleApiKeyId, appleApiIssuer };
};

const envValue = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
};

const opRead = (reference: string) => {
  const result = run("op", ["read", reference]);
  if (result.status !== 0) {
    fail(`Failed to read ${reference}. Run 'op signin' and try again.`, result.stderr || result.stdout);
  }
  return result.stdout.trim();
};

const mustRun = (command: string, args: readonly string[], message: string) => {
  const result = run(command, args);
  if (result.status !== 0) {
    fail(message, result.stderr || result.stdout);
  }
};

const run = (command: string, args: readonly string[]) => {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
  });

  if (result.error) {
    fail(`Failed to run ${command}.`, result.error.message);
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

const parseNotaryJson = (output: string): NotarySubmitResult | undefined => {
  const jsonStart = output.indexOf("{");
  const jsonEnd = output.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    return undefined;
  }

  try {
    return JSON.parse(output.slice(jsonStart, jsonEnd + 1)) as NotarySubmitResult;
  } catch {
    return undefined;
  }
};

const formatNotaryResult = (result: NotarySubmitResult) => {
  return JSON.stringify(
    {
      id: result.id,
      name: result.name,
      status: result.status,
      message: result.message,
    },
    null,
    2,
  );
};

const ok = (message: string) => {
  console.log("APPLE_NOTARY_OK=true");
  console.log(message);
};

const fail = (message: string, details?: string): never => {
  console.log("APPLE_NOTARY_OK=false");
  console.error(message);
  if (details?.trim()) {
    console.error(details.trim());
  }
  process.exit(1);
};

main();

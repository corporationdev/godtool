import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join, resolve, basename, dirname, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  appendFileSync,
} from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { BrowserSessionManager } from "./browser/session-manager";
import { startBrowserHostServer } from "./browser/host-server";
import type { BrowserBounds } from "./browser/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 14788;
const DEV_SERVER_URL = process.env.GODTOOL_DEV_URL || "http://127.0.0.1:1355";
const DESKTOP_STAGE =
  process.env.STAGE ?? (process.env.NODE_ENV === "development" ? "dev" : "production");
const CLOUD_APP_URL = process.env.GODTOOL_CLOUD_URL || getStageAppUrl(DESKTOP_STAGE);
const DEEP_LINK_PROTOCOL = "godtool";
const DESKTOP_AUTH_CALLBACK_PORT = Number(
  process.env.GODTOOL_DESKTOP_AUTH_CALLBACK_PORT ?? "14791",
);
const BROWSER_HOST_PORT = Number(process.env.GODTOOL_BROWSER_HOST_PORT ?? "14789");
const BROWSER_DEBUGGING_PORT = Number(process.env.GODTOOL_BROWSER_DEBUGGING_PORT ?? "9333");
const BROWSER_MAX_SESSIONS = Number(process.env.GODTOOL_BROWSER_MAX_SESSIONS ?? "5");
const COMPUTER_USE_HOST_PORT = Number(process.env.GODTOOL_COMPUTER_USE_HOST_PORT ?? "14790");
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SETTINGS_DIR = join(homedir(), ".godtool");
const SETTINGS_PATH = join(SETTINGS_DIR, "desktop-settings.json");
const BROWSER_SESSIONS_PATH = join(SETTINGS_DIR, "browser-sessions.json");
const DEFAULT_WORKSPACE_DIR = join(SETTINGS_DIR, "workspace");
const DEVICE_CONNECTION_RECONNECT_MS = 5_000;
const DEVICE_CONNECTION_PING_MS = 25_000;
const DEVICE_CATALOG_SYNC_MS = 5_000;

const CLI_BIN_DIR = join(SETTINGS_DIR, "bin");
const CLI_BIN_PATH = join(CLI_BIN_DIR, process.platform === "win32" ? "godtool.exe" : "godtool");

app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", String(BROWSER_DEBUGGING_PORT));
app.commandLine.appendSwitch("remote-allow-origins", DEV_SERVER_URL);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "godtool-workspace",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

function getStageAppUrl(stage: string): string {
  if (stage === "dev" || stage.startsWith("dev-")) return "http://localhost:3001";
  if (stage === "preview" || stage.startsWith("preview-") || stage.startsWith("pr-")) {
    const previewLabel = stage.replace(/^(preview-|pr-)/, "");
    return `https://preview-pr-${previewLabel}.godtool.dev`;
  }
  return "https://app.godtool.dev";
}

// ---------------------------------------------------------------------------
// CLI install — copy sidecar to ~/.godtool/bin and patch shell PATH
// ---------------------------------------------------------------------------

const getInstalledCliVersion = (): string | null => {
  if (!existsSync(CLI_BIN_PATH)) return null;
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync(CLI_BIN_PATH, ["--version"], {
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
};

const installCli = (): void => {
  if (isDev) return;

  const sidecar = join(process.resourcesPath, binaryName);
  if (!existsSync(sidecar)) return;

  // Check if installed version is already same or newer
  const appVersion = app.getVersion();
  const installedVersion = getInstalledCliVersion();
  if (installedVersion) {
    const parse = (v: string) =>
      v
        .replace(/^v/, "")
        .split(/[.-]/)
        .map((s) => {
          const n = parseInt(s, 10);
          return isNaN(n) ? 0 : n;
        });
    const installed = parse(installedVersion);
    const bundled = parse(appVersion);
    const len = Math.max(installed.length, bundled.length);
    let cmp = 0;
    for (let i = 0; i < len && cmp === 0; i++) {
      cmp = (installed[i] ?? 0) - (bundled[i] ?? 0);
    }
    if (cmp >= 0) return; // Already up to date or newer
  }

  // Copy binary
  mkdirSync(CLI_BIN_DIR, { recursive: true });
  copyFileSync(sidecar, CLI_BIN_PATH);
  try {
    chmodSync(CLI_BIN_PATH, 0o755);
  } catch {}
  console.log(
    `Installed godtool CLI ${appVersion} to ${CLI_BIN_PATH}` +
      (installedVersion ? ` (was ${installedVersion})` : ""),
  );

  // Copy WASM if present
  const wasm = join(process.resourcesPath, "emscripten-module.wasm");
  if (existsSync(wasm)) {
    copyFileSync(wasm, join(CLI_BIN_DIR, "emscripten-module.wasm"));
  }

  // Patch shell profiles with PATH
  if (process.platform === "win32") {
    // Add bin dir to the user PATH via registry so new terminals pick it up
    const result = spawn("reg", ["query", "HKCU\\Environment", "/v", "Path"], { stdio: "pipe" });
    let out = "";
    result.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    result.on("close", (code) => {
      // Exit codes: 0 = value exists, 1 = value missing (treat as empty).
      // Anything else (2 = access denied, etc.) is an unexpected failure —
      // bail rather than risk writing a malformed PATH.
      if (code !== 0 && code !== 1) {
        console.warn(`godtool: reg query failed (code ${code}), skipping PATH update`);
        return;
      }
      let current = "";
      if (code === 0) {
        const match = out.match(/Path\s+REG(?:_EXPAND)?_SZ\s+(.+)/i);
        if (!match) {
          // reg query succeeded but the output didn't parse — this means the
          // format changed and we can't safely rewrite PATH. Bail.
          console.warn("godtool: could not parse reg query output, skipping PATH update");
          return;
        }
        current = match[1].trim();
      }
      if (!current.toLowerCase().includes(CLI_BIN_DIR.toLowerCase())) {
        const updated = current ? `${current};${CLI_BIN_DIR}` : CLI_BIN_DIR;
        spawn("reg", [
          "add",
          "HKCU\\Environment",
          "/v",
          "Path",
          "/t",
          "REG_EXPAND_SZ",
          "/d",
          updated,
          "/f",
        ]);
      }
    });
    return;
  }

  const pathLine = `export PATH="${CLI_BIN_DIR}:$PATH"`;
  const profiles = [
    join(homedir(), ".zshrc"),
    join(homedir(), ".bashrc"),
    join(homedir(), ".bash_profile"),
  ];

  // Fish uses a different syntax
  const fishConfig = join(homedir(), ".config", "fish", "config.fish");
  const fishLine = `fish_add_path "${CLI_BIN_DIR}"`;

  for (const profile of profiles) {
    if (!existsSync(profile)) continue;
    const content = readFileSync(profile, "utf-8");
    if (content.includes(CLI_BIN_DIR)) continue;
    appendFileSync(profile, `\n# Added by GOD TOOL desktop app\n${pathLine}\n`);
  }

  if (existsSync(fishConfig)) {
    const content = readFileSync(fishConfig, "utf-8");
    if (!content.includes(CLI_BIN_DIR)) {
      appendFileSync(fishConfig, `\n# Added by GOD TOOL desktop app\n${fishLine}\n`);
    }
  }
};

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

interface Settings {
  windowBounds?: { x: number; y: number; width: number; height: number };
  deviceId?: string;
  deviceName?: string;
}

type CloudAuthUser = {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
};

type CloudAuthOrganization = {
  readonly id: string;
  readonly name: string;
};

type CloudAuthState =
  | { readonly status: "unauthenticated" }
  | {
      readonly status: "authenticated";
      readonly user: CloudAuthUser;
      readonly organization: CloudAuthOrganization | null;
    };

type CloudSource = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly url?: string;
  readonly runtime?: boolean;
  readonly canRemove?: boolean;
  readonly canRefresh?: boolean;
  readonly canEdit?: boolean;
};

type CloudSourceImportCandidate = {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly pluginId: string;
};

type WorkspaceFileNode = {
  readonly type: "file" | "directory";
  readonly name: string;
  readonly path: string;
  readonly children?: readonly WorkspaceFileNode[];
};

type WorkspaceOpenTarget =
  | "default"
  | "file-manager"
  | "cursor"
  | "zed"
  | "vscode"
  | "vscode-insiders"
  | "vscodium";

type WorkspaceOpenTargetDefinition = {
  readonly id: WorkspaceOpenTarget;
  readonly label: string;
  readonly commands: readonly [string, ...string[]] | null;
  readonly macAppName?: string;
};

const WORKSPACE_TREE_EXCLUDED_NAMES = new Set([".DS_Store", ".git", ".hg", ".svn", "node_modules"]);

const WORKSPACE_OPEN_TARGETS: readonly WorkspaceOpenTargetDefinition[] = [
  { id: "cursor", label: "Cursor", commands: ["cursor"], macAppName: "Cursor" },
  { id: "zed", label: "Zed", commands: ["zed", "zeditor"], macAppName: "Zed" },
  { id: "vscode", label: "VS Code", commands: ["code"], macAppName: "Visual Studio Code" },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    commands: ["code-insiders"],
    macAppName: "Visual Studio Code - Insiders",
  },
  { id: "vscodium", label: "VSCodium", commands: ["codium"], macAppName: "VSCodium" },
  { id: "file-manager", label: "Finder", commands: null },
  { id: "default", label: "Default app", commands: null },
];

const resolveWorkspacePath = (workspaceRelativePath: string): string => {
  if (workspaceRelativePath.includes("\0")) {
    throw new Error("Invalid workspace path");
  }

  const normalizedInput = workspaceRelativePath.replace(/\\/g, "/");
  if (normalizedInput.startsWith("/") || /^[a-zA-Z]:\//.test(normalizedInput)) {
    throw new Error("Workspace paths must be relative");
  }

  const root = resolve(DEFAULT_WORKSPACE_DIR);
  const resolved = resolve(root, normalizedInput);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error("Workspace path escapes the workspace root");
  }
  return resolved;
};

const toWorkspaceRelativePath = (absolutePath: string): string =>
  relative(DEFAULT_WORKSPACE_DIR, absolutePath).split(sep).join("/");

const fileManagerLabel = (): string => {
  if (process.platform === "darwin") return "Finder";
  if (process.platform === "win32") return "Explorer";
  return "Files";
};

const isCommandAvailable = (command: string): boolean => {
  const pathValue = process.env.PATH ?? "";
  if (pathValue.length === 0) return false;
  return pathValue.split(process.platform === "win32" ? ";" : ":").some((pathEntry) => {
    const candidate = join(pathEntry, command);
    return existsSync(candidate);
  });
};

const isMacAppAvailable = (appName: string): boolean => {
  if (process.platform !== "darwin") return false;
  return [
    join("/Applications", `${appName}.app`),
    join(homedir(), "Applications", `${appName}.app`),
  ].some((appPath) => existsSync(appPath));
};

const availableWorkspaceOpenTargets = async (): Promise<
  readonly { id: WorkspaceOpenTarget; label: string }[]
> => {
  const available: { id: WorkspaceOpenTarget; label: string }[] = [];
  for (const target of WORKSPACE_OPEN_TARGETS) {
    if (target.id === "default") {
      available.push(target);
      continue;
    }
    if (target.id === "file-manager") {
      available.push({ ...target, label: fileManagerLabel() });
      continue;
    }
    const hasCommand = target.commands?.some((command) => isCommandAvailable(command)) ?? false;
    const hasMacApp = target.macAppName ? isMacAppAvailable(target.macAppName) : false;
    if (hasCommand || hasMacApp) available.push(target);
  }
  return available;
};

const spawnAndWait = (command: string, args: readonly string[]): Promise<void> =>
  new Promise((resolveSpawn, reject) => {
    const proc = spawn(command, [...args], { stdio: "ignore" });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      if (code === 0) resolveSpawn();
      else reject(new Error(`Failed to run ${command}`));
    });
  });

const openWorkspacePath = async (
  workspaceRelativePath: string,
  target: WorkspaceOpenTarget,
): Promise<void> => {
  const absolutePath = resolveWorkspacePath(workspaceRelativePath);

  if (target === "default") {
    const error = await shell.openPath(absolutePath);
    if (error) throw new Error(error);
    return;
  }

  if (target === "file-manager") {
    const stat = await lstat(absolutePath);
    if (process.platform === "darwin" && !stat.isDirectory()) {
      shell.showItemInFolder(absolutePath);
      return;
    }
    if (process.platform === "win32") {
      await spawnAndWait("explorer", [absolutePath]);
      return;
    }
    if (process.platform === "linux") {
      await spawnAndWait("xdg-open", [absolutePath]);
      return;
    }
    if (stat.isDirectory()) {
      const error = await shell.openPath(absolutePath);
      if (error) throw new Error(error);
    } else {
      shell.showItemInFolder(absolutePath);
    }
    return;
  }

  const targetDefinition = WORKSPACE_OPEN_TARGETS.find((definition) => definition.id === target);
  if (!targetDefinition || !targetDefinition.commands) {
    throw new Error(`Unsupported open target: ${target}`);
  }

  const command = targetDefinition.commands.find((candidate) => isCommandAvailable(candidate));
  if (command) {
    await spawnAndWait(command, [absolutePath]);
    return;
  }

  if (process.platform === "darwin" && targetDefinition.macAppName) {
    await spawnAndWait("open", ["-a", targetDefinition.macAppName, absolutePath]);
    return;
  }

  throw new Error(`Editor not found: ${targetDefinition.label}`);
};

const moveWorkspaceFile = async (
  sourceWorkspaceRelativePath: string,
  destinationDirectoryWorkspaceRelativePath: string,
): Promise<{ path: string }> => {
  const sourcePath = resolveWorkspacePath(sourceWorkspaceRelativePath);
  const destinationDirectoryPath = resolveWorkspacePath(destinationDirectoryWorkspaceRelativePath);
  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile()) throw new Error("Only files can be moved into folders");

  const destinationDirectoryStat = await lstat(destinationDirectoryPath);
  if (!destinationDirectoryStat.isDirectory()) {
    throw new Error("Drop target is not a folder");
  }

  const destinationPath = join(destinationDirectoryPath, basename(sourcePath));
  if (sourcePath === destinationPath) {
    return { path: toWorkspaceRelativePath(sourcePath) };
  }
  if (existsSync(destinationPath)) {
    throw new Error("A file with that name already exists in the folder");
  }

  await rename(sourcePath, destinationPath);
  return { path: toWorkspaceRelativePath(destinationPath) };
};

const copyExternalPath = async (sourcePath: string, destinationPath: string): Promise<void> => {
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error("Symlinks cannot be imported into the workspace");
  }

  if (sourceStat.isDirectory()) {
    const nestedDestination = relative(sourcePath, destinationPath);
    if (
      nestedDestination === "" ||
      (!nestedDestination.startsWith("..") && nestedDestination !== "")
    ) {
      throw new Error("Cannot import a folder into itself");
    }
    if (existsSync(destinationPath)) {
      throw new Error(`A folder named ${basename(destinationPath)} already exists`);
    }
    await mkdir(destinationPath);
    const entries = await readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      await copyExternalPath(join(sourcePath, entry.name), join(destinationPath, entry.name));
    }
    return;
  }

  if (!sourceStat.isFile()) {
    throw new Error("Only files and folders can be imported");
  }
  if (existsSync(destinationPath)) {
    throw new Error(`A file named ${basename(destinationPath)} already exists`);
  }
  await copyFile(sourcePath, destinationPath);
};

const importWorkspacePaths = async (
  sourcePaths: readonly string[],
  destinationDirectoryWorkspaceRelativePath: string,
): Promise<{ paths: readonly string[] }> => {
  const destinationDirectoryPath = resolveWorkspacePath(destinationDirectoryWorkspaceRelativePath);
  const destinationDirectoryStat = await lstat(destinationDirectoryPath);
  if (!destinationDirectoryStat.isDirectory()) {
    throw new Error("Drop target is not a folder");
  }

  const importedPaths: string[] = [];
  for (const sourcePath of sourcePaths) {
    if (!sourcePath || sourcePath.includes("\0")) {
      throw new Error("Invalid dropped file");
    }
    const resolvedSourcePath = resolve(sourcePath);
    const destinationPath = join(destinationDirectoryPath, basename(resolvedSourcePath));
    await copyExternalPath(resolvedSourcePath, destinationPath);
    importedPaths.push(toWorkspaceRelativePath(destinationPath));
  }

  return { paths: importedPaths };
};

const workspaceFileUrl = (workspaceRelativePath: string): string =>
  `godtool-workspace://file/${encodeURIComponent(workspaceRelativePath)}`;

const setupWorkspaceFileProtocol = (): void => {
  protocol.handle("godtool-workspace", async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "file") {
      return new Response("Not found", { status: 404 });
    }

    const workspaceRelativePath = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const absolutePath = resolveWorkspacePath(workspaceRelativePath);
    const stat = await lstat(absolutePath);
    if (!stat.isFile()) {
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(absolutePath).toString());
  });
};

const readWorkspaceTree = async (dir: string): Promise<readonly WorkspaceFileNode[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nodes = await Promise.all(
    entries
      .filter((entry) => !WORKSPACE_TREE_EXCLUDED_NAMES.has(entry.name))
      .map(async (entry): Promise<WorkspaceFileNode | null> => {
        const fullPath = join(dir, entry.name);
        if (entry.isSymbolicLink()) return null;
        if (entry.isDirectory()) {
          return {
            type: "directory",
            name: entry.name,
            path: toWorkspaceRelativePath(fullPath),
            children: await readWorkspaceTree(fullPath),
          };
        }
        if (!entry.isFile()) return null;
        return {
          type: "file",
          name: entry.name,
          path: toWorkspaceRelativePath(fullPath),
        };
      }),
  );

  return nodes
    .filter((node): node is WorkspaceFileNode => node !== null)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
};

const loadSettings = (): Settings => {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
};

const saveSettings = (settings: Settings): void => {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
};

// ---------------------------------------------------------------------------
// Server process management
// ---------------------------------------------------------------------------

let serverProcess: ChildProcess | null = null;
let currentScope: string | null = null;
let currentPort = DEFAULT_PORT;
let browserHiddenWindow: BrowserWindow | null = null;
let browserSessionManager: BrowserSessionManager | null = null;
let browserHostServer: Server | null = null;
let computerUseProcess: ChildProcess | null = null;

const isDev = !app.isPackaged;

const binaryName = process.platform === "win32" ? "executor.exe" : "executor";

const resolveAgentBrowserPath = (): string => {
  if (process.env.GODTOOL_AGENT_BROWSER_PATH) return process.env.GODTOOL_AGENT_BROWSER_PATH;
  if (isDev) return "agent-browser";

  const platform = process.platform === "win32" ? "win32" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const name =
    process.platform === "win32"
      ? `agent-browser-${platform}-${arch}.exe`
      : `agent-browser-${platform}-${arch}`;
  const bundled = join(process.resourcesPath, "agent-browser", name);
  return existsSync(bundled) ? bundled : "agent-browser";
};

const resolveComputerUsePath = (): string => {
  if (process.env.GODTOOL_COMPUTER_USE_PATH) return process.env.GODTOOL_COMPUTER_USE_PATH;
  if (isDev) return resolve(__dirname, "../native/computer-use-mac/computer-use-mac");

  const platform = process.platform === "win32" ? "win32" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const name =
    process.platform === "win32"
      ? `computer-use-${platform}-${arch}.exe`
      : `computer-use-${platform}-${arch}`;
  const bundled = join(process.resourcesPath, "computer-use", name);
  return existsSync(bundled) ? bundled : "computer-use-mac";
};

/**
 * Returns { command, args, cwd } for spawning the server.
 * - In dev mode: uses `bun run` with the CLI source
 * - In production: uses the bundled sidecar binary
 */
const resolveServerCommand = (): { command: string; args: string[] } => {
  if (isDev) {
    const cliMain = resolve(__dirname, "../../cli/src/main.ts");
    if (existsSync(cliMain)) {
      return { command: "bun", args: ["run", cliMain] };
    }
    throw new Error("Could not find executor CLI entry point for dev mode");
  }

  // Production: sidecar binary bundled via extraResources
  const sidecar = join(process.resourcesPath, binaryName);
  if (existsSync(sidecar)) {
    return { command: sidecar, args: [] };
  }

  throw new Error(`Sidecar binary not found at ${sidecar}`);
};

const isServerReady = async (port: number): Promise<boolean> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/docs`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

const stopServer = (): Promise<void> => {
  return new Promise((resolve) => {
    if (!serverProcess) {
      resolve();
      return;
    }
    const proc = serverProcess;
    serverProcess = null;

    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");

    // Force kill after 5s
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      resolve();
    }, 5000);
  });
};

const startServer = async (scopePath: string, port: number): Promise<void> => {
  await stopServer();

  currentScope = scopePath;
  currentPort = port;

  const server = resolveServerCommand();
  const args = [...server.args, "web", "--port", String(port)];

  // In dev mode, run from repo root so bun can resolve workspace deps.
  // In production, the sidecar is self-contained.
  const cwd = isDev ? resolve(__dirname, "../../..") : scopePath;

  serverProcess = spawn(server.command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GODTOOL_SCOPE_DIR: scopePath,
      GODTOOL_WORKSPACE_DIR: DEFAULT_WORKSPACE_DIR,
      GODTOOL_BROWSER_HOST_URL: `http://127.0.0.1:${BROWSER_HOST_PORT}`,
      GODTOOL_AGENT_BROWSER_PATH: resolveAgentBrowserPath(),
      GODTOOL_COMPUTER_USE_HOST_URL: `http://127.0.0.1:${COMPUTER_USE_HOST_PORT}`,
    },
  });

  serverProcess.stdout?.on("data", (data: Buffer) => {
    console.log(`[server] ${data.toString().trim()}`);
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    console.error(`[server] ${data.toString().trim()}`);
  });

  serverProcess.on("exit", (code) => {
    console.log(`[server] exited with code ${code}`);
    if (serverProcess === null) return; // intentional stop
    serverProcess = null;
    // Server died unexpectedly — quit the app
    app.quit();
  });

  // Wait for server to become ready
  const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isServerReady(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`Server failed to start within ${SERVER_STARTUP_TIMEOUT_MS / 1000}s`);
};

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let settings = loadSettings();

const createWindow = (): BrowserWindow => {
  const bounds = settings.windowBounds ?? {
    width: 1200,
    height: 800,
  };

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 600,
    title: "GOD TOOL",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
  });

  win.on("close", () => {
    const b = win.getBounds();
    settings.windowBounds = b;
    saveSettings(settings);
  });

  // Open DevTools in development
  if (process.env.NODE_ENV === "development") {
    win.webContents.openDevTools();
  }

  // Log renderer errors to main process console
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`);
  });

  // Inject CSS to account for traffic light buttons and enable scrolling
  win.webContents.on("did-finish-load", () => {
    win.webContents.insertCSS(`
      /* Drag region for the titlebar area */
      body::before {
        content: '';
        display: block;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 38px;
        -webkit-app-region: drag;
        z-index: 9999;
        pointer-events: none;
      }

      /* Make interactive elements inside the titlebar area clickable */
      a, button, input, select, textarea, [role="button"] {
        -webkit-app-region: no-drag;
      }

      /* Reserve only the titlebar row; the desktop toggle is pinned below. */
      [data-slot="sidebar-inner"] > [data-slot="sidebar-header"].desktop-sidebar-header {
        height: 44px !important;
        min-height: 44px !important;
        padding: 0 !important;
      }

      /* Pin the desktop sidebar toggle next to the macOS traffic lights. */
      [data-slot="sidebar-trigger"].desktop-sidebar-trigger {
        position: fixed !important;
        top: 5px !important;
        left: 72px !important;
        z-index: 10000 !important;
      }

      /* Keep any mobile top bar clear of the titlebar drag region */
      main > :first-child[data-mobile-titlebar] {
        margin-top: 38px !important;
      }
    `);
  });

  return win;
};

const broadcastBrowserSessionsChanged = (): void => {
  mainWindow?.webContents.send("browser-sessions-changed", browserSessionManager?.list() ?? []);
};

const startBrowserHost = async (): Promise<void> => {
  if (browserSessionManager && browserHostServer) return;

  browserHiddenWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  browserSessionManager = new BrowserSessionManager({
    maxSessions: Number.isFinite(BROWSER_MAX_SESSIONS) ? BROWSER_MAX_SESSIONS : 5,
    debuggingPort: Number.isFinite(BROWSER_DEBUGGING_PORT) ? BROWSER_DEBUGGING_PORT : 9333,
    hiddenWindow: browserHiddenWindow,
    metadataPath: BROWSER_SESSIONS_PATH,
    getMainWindow: () => mainWindow,
    onSessionsChanged: broadcastBrowserSessionsChanged,
  });

  browserHostServer = await startBrowserHostServer({
    port: Number.isFinite(BROWSER_HOST_PORT) ? BROWSER_HOST_PORT : 14789,
    manager: browserSessionManager,
  });

  console.log(
    `[browser] host listening on http://127.0.0.1:${BROWSER_HOST_PORT} ` +
      `(debugging port ${BROWSER_DEBUGGING_PORT}, max sessions ${BROWSER_MAX_SESSIONS})`,
  );
};

const stopBrowserHost = (): void => {
  browserSessionManager?.closeAll();
  browserSessionManager = null;
  if (browserHostServer) {
    browserHostServer.close();
    browserHostServer = null;
  }
  if (browserHiddenWindow && !browserHiddenWindow.isDestroyed()) {
    browserHiddenWindow.close();
  }
  browserHiddenWindow = null;
};

const startComputerUseHost = async (): Promise<void> => {
  if (computerUseProcess) return;
  if (process.platform !== "darwin") {
    console.warn("[computer-use] macOS host is only available on darwin");
    return;
  }

  const command = resolveComputerUsePath();
  if (!existsSync(command)) {
    console.warn(`[computer-use] host binary not found at ${command}`);
    return;
  }

  computerUseProcess = spawn(
    command,
    ["--port", String(Number.isFinite(COMPUTER_USE_HOST_PORT) ? COMPUTER_USE_HOST_PORT : 14790)],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  computerUseProcess.stdout?.on("data", (data: Buffer) => {
    console.log(`[computer-use] ${data.toString().trim()}`);
  });

  computerUseProcess.stderr?.on("data", (data: Buffer) => {
    console.error(`[computer-use] ${data.toString().trim()}`);
  });

  computerUseProcess.on("exit", (code) => {
    console.log(`[computer-use] exited with code ${code}`);
    computerUseProcess = null;
  });
};

const stopComputerUseHost = (): void => {
  if (computerUseProcess) {
    computerUseProcess.kill("SIGTERM");
    computerUseProcess = null;
  }
};

const loadScope = async (scopePath: string): Promise<void> => {
  if (!mainWindow) return;

  mainWindow.setTitle(`GOD TOOL — ${basename(scopePath)}`);

  if (isDev) {
    // In dev mode, the Vite dev server handles both UI and API.
    // Just set the scope env var and load the dev URL.
    currentScope = scopePath;
    process.env.GODTOOL_SCOPE_DIR = scopePath;
    process.env.GODTOOL_WORKSPACE_DIR = DEFAULT_WORKSPACE_DIR;
    buildMenu();
    mainWindow.loadURL(DEV_SERVER_URL);
    return;
  }

  // Show loading state
  mainWindow.loadURL(`data:text/html,${encodeURIComponent(loadingHTML(scopePath))}`);

  try {
    await startServer(scopePath, currentPort);
    buildMenu();
    mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);
  } catch (err) {
    mainWindow.loadURL(`data:text/html,${encodeURIComponent(errorHTML(String(err)))}`);
  }
};

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

const buildMenu = (): void => {
  const template: MenuItemConstructorOptions[] = [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [{ role: "close" as const }],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

// ---------------------------------------------------------------------------
// Cloud auth
// ---------------------------------------------------------------------------

const cloudUrl = (path: string): string => new URL(path, CLOUD_APP_URL).toString();

const cloudWebSocketUrl = (path: string): string => {
  const url = new URL(path, CLOUD_APP_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

const getCloudCookieHeader = async (): Promise<string> => {
  const cookies = await session.defaultSession.cookies.get({ url: CLOUD_APP_URL });
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
};

const getCloudSessionCookieValue = async (): Promise<string | null> => {
  const cookies = await session.defaultSession.cookies.get({
    url: CLOUD_APP_URL,
    name: "wos-session",
  });
  return cookies[0]?.value ?? null;
};

const fetchCloudAuthState = async (): Promise<CloudAuthState> => {
  const cookie = await getCloudCookieHeader();
  if (!cookie) return { status: "unauthenticated" };

  const response = await fetch(cloudUrl("/api/auth/me"), {
    headers: {
      accept: "application/json",
      cookie,
    },
  });

  if (response.status === 401 || response.status === 403) {
    return { status: "unauthenticated" };
  }
  if (!response.ok) {
    throw new Error(`Cloud auth request failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    readonly user: CloudAuthUser;
    readonly organization: CloudAuthOrganization | null;
  };

  return {
    status: "authenticated",
    user: data.user,
    organization: data.organization,
  };
};

const fetchCloudSources = async (): Promise<readonly CloudSource[]> => {
  const authState = await fetchCloudAuthState();
  if (authState.status !== "authenticated" || authState.organization === null) return [];

  const cookie = await getCloudCookieHeader();
  const headers = {
    accept: "application/json",
    cookie,
  };

  const scopeResponse = await fetch(cloudUrl("/api/scope"), { headers });
  if (scopeResponse.status === 401 || scopeResponse.status === 403) return [];
  if (!scopeResponse.ok) {
    throw new Error(`Cloud scope request failed: ${scopeResponse.status}`);
  }

  const scope = (await scopeResponse.json()) as { readonly id?: string };
  if (!scope.id) return [];

  const sourcesResponse = await fetch(
    cloudUrl(`/api/scopes/${encodeURIComponent(scope.id)}/sources`),
    { headers },
  );
  if (sourcesResponse.status === 401 || sourcesResponse.status === 403) return [];
  if (!sourcesResponse.ok) {
    throw new Error(`Cloud sources request failed: ${sourcesResponse.status}`);
  }

  return (await sourcesResponse.json()) as readonly CloudSource[];
};

const callCloudSourceSync = async <T>(
  route: "to-cloud" | "to-local" | "delete" | "import-candidates",
  payload: unknown,
): Promise<T> => {
  const cookie = await getCloudCookieHeader();
  if (!cookie) throw new Error("Not signed in");

  const response = await fetch(cloudUrl(`/api/source-sync/${route}`), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(120_000),
  });
  return readJsonResponse<T>(response);
};

const syncSourcesToCloud = async (sourceIds: readonly string[]): Promise<unknown> => {
  const exported = await callLocalSourceSync("export", { sourceIds });
  return callCloudSourceSync("to-cloud", exported);
};

const syncSourcesToLocal = async (sourceIds: readonly string[]): Promise<unknown> => {
  const result = await callCloudSourceSync("to-local", { sourceIds });
  const { deviceId } = ensureDeviceIdentity();
  await publishLocalSourceCatalog(deviceId, { force: true }).catch((error) =>
    console.warn("[devices] source catalog sync failed", error),
  );
  return result;
};

const deleteSyncedSources = async (
  sourceIds: readonly string[],
  placements: readonly ("local" | "cloud")[],
): Promise<unknown> => {
  if (placements.includes("local")) {
    await callLocalSourceSync("delete", { sourceIds });
    const { deviceId } = ensureDeviceIdentity();
    await publishLocalSourceCatalog(deviceId, { force: true }).catch((error) =>
      console.warn("[devices] source catalog sync failed", error),
    );
  }
  if (placements.includes("cloud")) {
    return callCloudSourceSync("delete", { sourceIds, placements: ["cloud"] });
  }
  return { sourceIds };
};

const fetchSourceImportCandidates = async (): Promise<readonly CloudSourceImportCandidate[]> => {
  const data = await callCloudSourceSync<{
    readonly sources?: readonly CloudSourceImportCandidate[];
  }>("import-candidates", {});
  return data.sources ?? [];
};

const pendingDesktopAuth = new Map<
  string,
  {
    readonly resolve: (state: CloudAuthState) => void;
    readonly reject: (error: unknown) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }
>();
let desktopAuthCallbackServer: Server | null = null;

const setCloudSessionCookie = async (sealedSession: string): Promise<void> => {
  await session.defaultSession.cookies.set({
    url: CLOUD_APP_URL,
    name: "wos-session",
    value: sealedSession,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  });
};

const resolveDesktopAuth = async (state: string, sealedSession: string): Promise<void> => {
  const pending = pendingDesktopAuth.get(state);
  if (!pending) return;
  pendingDesktopAuth.delete(state);
  clearTimeout(pending.timeout);

  try {
    await setCloudSessionCookie(sealedSession);
    const authState = await fetchCloudAuthState();
    pending.resolve(authState);
  } catch (error) {
    pending.reject(error);
  }
};

const handleDeepLink = (rawUrl: string): void => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }

  if (url.protocol !== `${DEEP_LINK_PROTOCOL}:`) return;
  if (url.hostname !== "auth" || url.pathname !== "/callback") return;

  const sealedSession = url.searchParams.get("session");
  const state = url.searchParams.get("state");
  if (!sealedSession || !state) return;

  void resolveDesktopAuth(state, sealedSession);
};

const desktopAuthCallbackHTML = (message: string): string => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GOD TOOL</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #0a0a0a;
      color: #f5f5f5;
    }
    main { max-width: 360px; padding: 32px; text-align: center; }
    h1 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
    p { margin: 0; color: #a1a1aa; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>${message}</h1>
    <p>You can return to GOD TOOL.</p>
  </main>
  <script>
    try { history.replaceState(null, "", "/auth/complete"); } catch {}
    setTimeout(() => window.close(), 1200);
  </script>
</body>
</html>`;

const startDesktopAuthCallbackServer = async (): Promise<void> => {
  if (desktopAuthCallbackServer) return;

  desktopAuthCallbackServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (url.pathname !== "/auth/callback") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
      return;
    }

    const sealedSession = url.searchParams.get("session");
    const state = url.searchParams.get("state");
    if (!sealedSession || !state) {
      response.writeHead(400, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(desktopAuthCallbackHTML("Sign-in failed"));
      return;
    }

    void resolveDesktopAuth(state, sealedSession);
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(desktopAuthCallbackHTML("Signed in"));
  });

  await new Promise<void>((resolve, reject) => {
    desktopAuthCallbackServer?.once("error", reject);
    desktopAuthCallbackServer?.listen(DESKTOP_AUTH_CALLBACK_PORT, "127.0.0.1", () => {
      desktopAuthCallbackServer?.off("error", reject);
      resolve();
    });
  });
};

const stopDesktopAuthCallbackServer = (): void => {
  if (!desktopAuthCallbackServer) return;
  desktopAuthCallbackServer.close();
  desktopAuthCallbackServer = null;
};

const openCloudSignIn = async (): Promise<CloudAuthState> => {
  const existing = await fetchCloudAuthState();
  if (existing.status === "authenticated") return existing;

  await startDesktopAuthCallbackServer();

  const state = randomUUID();
  const loginUrl = new URL(cloudUrl("/api/auth/login"));
  loginUrl.searchParams.set("desktop", "1");
  loginUrl.searchParams.set("desktop_state", state);

  return await new Promise<CloudAuthState>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        pendingDesktopAuth.delete(state);
        resolve({ status: "unauthenticated" });
      },
      5 * 60 * 1000,
    );

    pendingDesktopAuth.set(state, { resolve, reject, timeout });
    shell.openExternal(loginUrl.toString()).catch((error) => {
      pendingDesktopAuth.delete(state);
      clearTimeout(timeout);
      reject(error);
    });
  });
};

const signOutCloud = async (): Promise<CloudAuthState> => {
  stopDeviceConnection();
  await session.defaultSession.cookies.remove(CLOUD_APP_URL, "wos-session").catch(() => undefined);
  return { status: "unauthenticated" };
};

const registerDeepLinkProtocol = (): void => {
  if (isDev) {
    app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [
      resolve(__dirname, ".."),
    ]);
    return;
  }
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
};

// ---------------------------------------------------------------------------
// Cloud device connection
// ---------------------------------------------------------------------------

let deviceSocket: WebSocket | null = null;
let deviceReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let devicePingTimer: ReturnType<typeof setInterval> | null = null;
let deviceCatalogSyncTimer: ReturnType<typeof setInterval> | null = null;
let deviceAuthState: Extract<CloudAuthState, { status: "authenticated" }> | null = null;
let deviceConnecting = false;
let deviceCatalogSyncInFlight = false;
let lastDeviceCatalogHash: string | null = null;

type LocalDesktopRpcResponse =
  | {
      readonly status: "completed";
      readonly result: unknown;
    }
  | {
      readonly status: "error";
      readonly error: string;
    };

type LocalSourceCatalog = {
  readonly sources: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly pluginId: string;
    readonly toolCount: number;
  }[];
};

type DeviceSocketMessage = {
  readonly type?: string;
  readonly requestId?: unknown;
  readonly code?: unknown;
  readonly sourceIds?: unknown;
  readonly sources?: unknown;
};

const encodeBase64Url = (value: string): string =>
  Buffer.from(value, "utf-8").toString("base64url");

const ensureDeviceIdentity = (): { deviceId: string; deviceName: string } => {
  let changed = false;
  if (!settings.deviceId) {
    settings.deviceId = randomUUID();
    changed = true;
  }
  if (!settings.deviceName) {
    settings.deviceName = hostname() || "Desktop";
    changed = true;
  }
  if (changed) saveSettings(settings);
  return { deviceId: settings.deviceId, deviceName: settings.deviceName };
};

const localAppBaseUrl = (): string => (isDev ? DEV_SERVER_URL : `http://127.0.0.1:${currentPort}`);

const localAppUrl = (path: string): string => new URL(path, localAppBaseUrl()).toString();

const readJsonResponse = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  const data = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `Local request failed with status ${response.status}`;
    throw new Error(message);
  }
  return data as T;
};

const executeLocalDesktopRpc = async (code: string): Promise<LocalDesktopRpcResponse> => {
  const response = await fetch(localAppUrl("/api/__desktop/execute"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return readJsonResponse<LocalDesktopRpcResponse>(response);
};

const callLocalSourceSync = async (path: string, payload: unknown): Promise<unknown> => {
  const response = await fetch(localAppUrl(`/api/__desktop/sources/${path}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(60_000),
  });
  return readJsonResponse(response);
};

const fetchLocalSourceCatalog = async (): Promise<LocalSourceCatalog> => {
  const response = await fetch(localAppUrl("/api/__desktop/catalog"), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  return readJsonResponse<LocalSourceCatalog>(response);
};

const catalogHash = (catalog: LocalSourceCatalog): string =>
  JSON.stringify(
    [...catalog.sources]
      .map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.kind,
        pluginId: source.pluginId,
        toolCount: source.toolCount,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );

const publishLocalSourceCatalog = async (
  deviceId: string,
  options: { readonly force?: boolean } = {},
): Promise<void> => {
  if (deviceCatalogSyncInFlight) return;
  deviceCatalogSyncInFlight = true;
  try {
    const [cookie, catalog] = await Promise.all([
      getCloudCookieHeader(),
      fetchLocalSourceCatalog(),
    ]);
    if (!cookie) return;
    const nextHash = catalogHash(catalog);
    if (!options.force && nextHash === lastDeviceCatalogHash) return;

    const response = await fetch(cloudUrl("/api/devices/catalog"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ deviceId, sources: catalog.sources }),
      signal: AbortSignal.timeout(10_000),
    });
    await readJsonResponse(response);
    lastDeviceCatalogHash = nextHash;
    console.log(`[devices] source catalog synced (${catalog.sources.length})`);
  } finally {
    deviceCatalogSyncInFlight = false;
  }
};

const ensureLocalComputerUseSource = async (): Promise<void> => {
  try {
    const scopeResponse = await fetch(localAppUrl("/api/scope"), {
      signal: AbortSignal.timeout(10_000),
    });
    const scope = await readJsonResponse<{ readonly id?: unknown }>(scopeResponse);
    if (typeof scope.id !== "string" || !scope.id) return;

    const response = await fetch(
      localAppUrl(`/api/scopes/${encodeURIComponent(scope.id)}/computer-use/sources`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    await readJsonResponse(response);
    console.log("[devices] computer_use source ready");
  } catch (error) {
    console.warn("[devices] computer_use source not ready", error);
  }
};

const clearDeviceReconnectTimer = (): void => {
  if (!deviceReconnectTimer) return;
  clearTimeout(deviceReconnectTimer);
  deviceReconnectTimer = null;
};

const clearDevicePingTimer = (): void => {
  if (!devicePingTimer) return;
  clearInterval(devicePingTimer);
  devicePingTimer = null;
};

const clearDeviceCatalogSyncTimer = (): void => {
  if (!deviceCatalogSyncTimer) return;
  clearInterval(deviceCatalogSyncTimer);
  deviceCatalogSyncTimer = null;
};

const scheduleDeviceReconnect = (delayMs = DEVICE_CONNECTION_RECONNECT_MS): void => {
  if (!deviceAuthState?.organization) return;
  if (deviceReconnectTimer) return;
  deviceReconnectTimer = setTimeout(() => {
    deviceReconnectTimer = null;
    void connectDeviceWebSocket();
  }, delayMs);
};

const stopDeviceConnection = (): void => {
  deviceAuthState = null;
  clearDeviceReconnectTimer();
  clearDevicePingTimer();
  clearDeviceCatalogSyncTimer();
  lastDeviceCatalogHash = null;
  const socket = deviceSocket;
  deviceSocket = null;
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    socket.close(1000, "signed out");
  }
};

const sendDeviceExecutionResponse = (
  socket: WebSocket,
  requestId: string,
  response: LocalDesktopRpcResponse,
): void => {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (response.status === "completed") {
    socket.send(
      JSON.stringify({
        type: "execute.response",
        requestId,
        status: "completed",
        result: response.result,
      }),
    );
    return;
  }

  socket.send(
    JSON.stringify({
      type: "execute.response",
      requestId,
      status: "error",
      error: response.error,
    }),
  );
};

const sendDeviceRpcResponse = (
  socket: WebSocket,
  requestId: string,
  responseType: string,
  response:
    | { readonly status: "completed"; readonly result: unknown }
    | { readonly status: "error"; readonly error: string },
): void => {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: responseType, requestId, ...response }));
};

const handleDeviceSocketMessage = async (socket: WebSocket, data: unknown): Promise<void> => {
  if (typeof data !== "string") return;

  let message: DeviceSocketMessage;
  try {
    message = JSON.parse(data) as DeviceSocketMessage;
  } catch {
    return;
  }

  if (typeof message.requestId !== "string") return;

  if (message.type === "execute.request") {
    if (typeof message.code !== "string") return;
    try {
      const response = await executeLocalDesktopRpc(message.code);
      sendDeviceExecutionResponse(socket, message.requestId, response);
    } catch (error) {
      sendDeviceExecutionResponse(socket, message.requestId, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const sourceSyncRoute =
    message.type === "source.export.request"
      ? "export"
      : message.type === "source.import.request"
        ? "import"
        : message.type === "source.delete.request"
          ? "delete"
          : message.type === "source.importCandidates.request"
            ? "import-candidates"
            : null;
  if (!sourceSyncRoute) return;

  try {
    const result = await callLocalSourceSync(sourceSyncRoute, {
      sourceIds: message.sourceIds,
      sources: message.sources,
    });
    sendDeviceRpcResponse(socket, message.requestId, "source.response", {
      status: "completed",
      result,
    });
  } catch (error) {
    sendDeviceRpcResponse(socket, message.requestId, "source.response", {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const connectDeviceWebSocket = async (): Promise<void> => {
  if (!deviceAuthState?.organization || deviceConnecting) return;
  if (
    deviceSocket &&
    (deviceSocket.readyState === WebSocket.OPEN || deviceSocket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  deviceConnecting = true;
  try {
    const sealedSession = await getCloudSessionCookieValue();
    if (!sealedSession) {
      scheduleDeviceReconnect();
      return;
    }

    const { deviceId, deviceName } = ensureDeviceIdentity();
    const url = new URL(cloudWebSocketUrl("/api/devices/connect"));
    url.searchParams.set("deviceId", deviceId);
    url.searchParams.set("name", deviceName);
    url.searchParams.set("platform", process.platform);
    url.searchParams.set("appVersion", app.getVersion());

    const socket = new WebSocket(url.toString(), [
      "godtool-device",
      `godtool-auth.${encodeBase64Url(sealedSession)}`,
    ]);
    deviceSocket = socket;

    socket.addEventListener("open", () => {
      console.log(`[devices] connected ${deviceId}`);
      void ensureLocalComputerUseSource()
        .then(() => publishLocalSourceCatalog(deviceId, { force: true }))
        .catch((error) => console.warn("[devices] source catalog sync failed", error));
      clearDeviceCatalogSyncTimer();
      deviceCatalogSyncTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          void publishLocalSourceCatalog(deviceId).catch((error) =>
            console.warn("[devices] source catalog sync failed", error),
          );
        }
      }, DEVICE_CATALOG_SYNC_MS);
      clearDevicePingTimer();
      devicePingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "ping", at: Date.now() }));
        }
      }, DEVICE_CONNECTION_PING_MS);
    });

    socket.addEventListener("message", (event) => {
      void handleDeviceSocketMessage(socket, event.data);
    });

    socket.addEventListener("close", () => {
      if (deviceSocket === socket) deviceSocket = null;
      clearDevicePingTimer();
      clearDeviceCatalogSyncTimer();
      scheduleDeviceReconnect();
    });

    socket.addEventListener("error", () => {
      if (deviceSocket === socket) deviceSocket = null;
      clearDevicePingTimer();
      clearDeviceCatalogSyncTimer();
      scheduleDeviceReconnect();
    });
  } catch (error) {
    console.warn("[devices] connection failed", error);
    scheduleDeviceReconnect();
  } finally {
    deviceConnecting = false;
  }
};

const syncDeviceConnection = (authState: CloudAuthState): void => {
  if (authState.status !== "authenticated" || !authState.organization) {
    stopDeviceConnection();
    return;
  }
  deviceAuthState = authState;
  scheduleDeviceReconnect(0);
};

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

const setupIPC = (): void => {
  ipcMain.handle("get-current-scope", () => currentScope);
  ipcMain.handle("cloud-auth:me", async () => {
    const authState = await fetchCloudAuthState();
    syncDeviceConnection(authState);
    return authState;
  });
  ipcMain.handle("cloud-auth:sign-in", async () => {
    const authState = await openCloudSignIn();
    syncDeviceConnection(authState);
    return authState;
  });
  ipcMain.handle("cloud-auth:sign-out", () => signOutCloud());
  ipcMain.handle("cloud-auth:get-cloud-url", () => CLOUD_APP_URL);
  ipcMain.handle("cloud-auth:get-device-id", () => ensureDeviceIdentity().deviceId);
  ipcMain.handle("cloud-auth:list-sources", () => fetchCloudSources());
  ipcMain.handle("cloud-auth:source-sync-to-cloud", (_event, sourceIds: readonly string[]) =>
    syncSourcesToCloud(Array.isArray(sourceIds) ? sourceIds : []),
  );
  ipcMain.handle("cloud-auth:source-sync-to-local", (_event, sourceIds: readonly string[]) =>
    syncSourcesToLocal(Array.isArray(sourceIds) ? sourceIds : []),
  );
  ipcMain.handle(
    "cloud-auth:source-sync-delete",
    (_event, sourceIds: readonly string[], placements: readonly ("local" | "cloud")[]) =>
      deleteSyncedSources(
        Array.isArray(sourceIds) ? sourceIds : [],
        Array.isArray(placements) ? placements : [],
      ),
  );
  ipcMain.handle("cloud-auth:source-sync-import-candidates", () => fetchSourceImportCandidates());

  ipcMain.handle("workspace-files:list", async () => {
    mkdirSync(DEFAULT_WORKSPACE_DIR, { recursive: true });
    return {
      rootPath: DEFAULT_WORKSPACE_DIR,
      tree: await readWorkspaceTree(DEFAULT_WORKSPACE_DIR),
      openTargets: await availableWorkspaceOpenTargets(),
    };
  });

  ipcMain.handle("workspace-files:read", async (_event, workspaceRelativePath: string) => {
    const absolutePath = resolveWorkspacePath(workspaceRelativePath);
    const stat = await lstat(absolutePath);
    if (!stat.isFile()) throw new Error("Workspace path is not a file");
    return {
      path: toWorkspaceRelativePath(absolutePath),
      content: await readFile(absolutePath, "utf-8"),
    };
  });

  ipcMain.handle(
    "workspace-files:write",
    async (_event, workspaceRelativePath: string, content: string) => {
      const absolutePath = resolveWorkspacePath(workspaceRelativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      const tempPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, content, "utf-8");
      await rename(tempPath, absolutePath);
      return {
        path: toWorkspaceRelativePath(absolutePath),
      };
    },
  );

  ipcMain.handle(
    "workspace-files:create-file",
    async (_event, workspaceRelativePath: string, content = "") => {
      const absolutePath = resolveWorkspacePath(workspaceRelativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, { encoding: "utf-8", flag: "wx" });
      return {
        path: toWorkspaceRelativePath(absolutePath),
      };
    },
  );

  ipcMain.handle(
    "workspace-files:create-directory",
    async (_event, workspaceRelativePath: string) => {
      const absolutePath = resolveWorkspacePath(workspaceRelativePath);
      mkdirSync(absolutePath);
      return {
        path: toWorkspaceRelativePath(absolutePath),
      };
    },
  );

  ipcMain.handle(
    "workspace-files:move-file",
    async (
      _event,
      sourceWorkspaceRelativePath: string,
      destinationDirectoryWorkspaceRelativePath: string,
    ) => moveWorkspaceFile(sourceWorkspaceRelativePath, destinationDirectoryWorkspaceRelativePath),
  );

  ipcMain.handle(
    "workspace-files:import-paths",
    async (
      _event,
      sourcePaths: readonly string[],
      destinationDirectoryWorkspaceRelativePath: string,
    ) => importWorkspacePaths(sourcePaths, destinationDirectoryWorkspaceRelativePath),
  );

  ipcMain.handle("workspace-files:get-file-url", async (_event, workspaceRelativePath: string) => {
    const absolutePath = resolveWorkspacePath(workspaceRelativePath);
    const stat = await lstat(absolutePath);
    if (!stat.isFile()) throw new Error("Workspace path is not a file");
    return workspaceFileUrl(toWorkspaceRelativePath(absolutePath));
  });

  ipcMain.handle(
    "workspace-files:open",
    async (_event, workspaceRelativePath: string, target: WorkspaceOpenTarget) => {
      await openWorkspacePath(workspaceRelativePath, target);
      return true;
    },
  );

  ipcMain.handle("browser-sessions:list", () => browserSessionManager?.list() ?? []);

  ipcMain.handle("browser-sessions:ensure", async (_event, input) => {
    if (!browserSessionManager) throw new Error("Browser host is not running");
    return browserSessionManager.ensure(input);
  });

  ipcMain.handle("browser-sessions:activate-viewport", () => {
    if (!browserSessionManager) throw new Error("Browser host is not running");
    browserSessionManager.activateViewport();
    return true;
  });

  ipcMain.handle("browser-sessions:deactivate-viewport", () => {
    if (!browserSessionManager) throw new Error("Browser host is not running");
    browserSessionManager.deactivateViewport();
    return true;
  });

  ipcMain.handle(
    "browser-sessions:show",
    async (_event, sessionId: string, bounds: BrowserBounds) => {
      if (!browserSessionManager) throw new Error("Browser host is not running");
      return browserSessionManager.show(sessionId, bounds);
    },
  );

  ipcMain.handle(
    "browser-sessions:set-bounds",
    async (_event, sessionId: string, bounds: BrowserBounds) => {
      if (!browserSessionManager) throw new Error("Browser host is not running");
      return browserSessionManager.setBounds(sessionId, bounds);
    },
  );

  ipcMain.handle("browser-sessions:hide", async (_event, sessionId: string) => {
    if (!browserSessionManager) throw new Error("Browser host is not running");
    return browserSessionManager.hide(sessionId);
  });

  ipcMain.handle(
    "browser-sessions:rename",
    async (_event, sessionId: string, sessionName: string) => {
      if (!browserSessionManager) throw new Error("Browser host is not running");
      return browserSessionManager.rename(sessionId, sessionName);
    },
  );

  ipcMain.handle("browser-sessions:navigate", async (_event, sessionId: string, url: string) => {
    if (!browserSessionManager) throw new Error("Browser host is not running");
    return browserSessionManager.navigate(sessionId, url);
  });

  ipcMain.handle("browser-sessions:back", async (_event, sessionId: string) => {
    if (!browserSessionManager) throw new Error("Browser host is not running");
    return browserSessionManager.goBack(sessionId);
  });

  ipcMain.handle("browser-sessions:forward", async (_event, sessionId: string) => {
    if (!browserSessionManager) throw new Error("Browser host is not running");
    return browserSessionManager.goForward(sessionId);
  });

  ipcMain.handle("browser-sessions:reload", async (_event, sessionId: string) => {
    if (!browserSessionManager) throw new Error("Browser host is not running");
    return browserSessionManager.reload(sessionId);
  });

  ipcMain.handle("browser-sessions:touch", async (_event, sessionId: string, input) => {
    if (!browserSessionManager) throw new Error("Browser host is not running");
    return browserSessionManager.touch(sessionId, input);
  });

  ipcMain.handle("browser-sessions:close", (_event, sessionId: string) => {
    if (!browserSessionManager) throw new Error("Browser host is not running");
    browserSessionManager.close(sessionId);
    return true;
  });

  ipcMain.handle("browser-data:clear", async () => {
    if (!browserSessionManager) throw new Error("Browser host is not running");
    await browserSessionManager.clearBrowserData();
    return true;
  });
};

// ---------------------------------------------------------------------------
// HTML templates for loading/error states
// ---------------------------------------------------------------------------

const loadingHTML = (scopePath: string): string => {
  const isDark = nativeTheme.shouldUseDarkColors;
  const bg = isDark ? "#0a0a0a" : "#ffffff";
  const fg = isDark ? "#e5e5e5" : "#171717";
  const muted = isDark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.25)";
  const subtle = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.03)";
  const barColor = isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.4)";
  const barTrack = isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.06)";
  const folder = basename(scopePath.replace(/[/\\]+$/, "")) || scopePath;

  return `<!DOCTYPE html>
<html>
<head>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500&display=swap" rel="stylesheet" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: "Geist", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    height: 100vh;
    background: ${bg};
    color: ${fg};
    -webkit-app-region: drag;
    overflow: hidden;
  }

  .container {
    display: flex; flex-direction: column; align-items: center;
    animation: fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Wordmark */
  .wordmark {
    font-family: "Geist", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: 28px;
    font-weight: 400;
    letter-spacing: -0.01em;
    margin-bottom: 28px;
    opacity: 0.85;
  }

  /* Progress bar */
  .bar-wrap {
    width: 120px;
    height: 2px;
    border-radius: 1px;
    background: ${barTrack};
    overflow: hidden;
    margin-bottom: 24px;
  }

  .bar {
    height: 100%;
    width: 40%;
    border-radius: 1px;
    background: ${barColor};
    animation: slide 1.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }

  @keyframes slide {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
  }

  /* Scope badge */
  .scope {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px 5px 8px;
    border-radius: 6px;
    background: ${subtle};
    font-size: 12px;
    font-weight: 500;
    color: ${muted};
    letter-spacing: 0.01em;
    max-width: 280px;
  }

  .scope svg {
    width: 13px; height: 13px;
    flex-shrink: 0;
    opacity: 0.6;
  }

  .scope span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
</head>
<body>
  <div class="container">
    <div class="wordmark">godtool</div>
    <div class="bar-wrap"><div class="bar"></div></div>
    <div class="scope">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
        <path d="M2 4.5C2 3.67 2.67 3 3.5 3h3.09a1 1 0 0 1 .7.29l1.42 1.42a1 1 0 0 0 .7.29H12.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5z"/>
      </svg>
      <span>${folder}</span>
    </div>
  </div>
</body>
</html>`;
};

const errorHTML = (message: string): string => `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    height: 100vh;
    background: ${nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff"};
    color: ${nativeTheme.shouldUseDarkColors ? "#e5e5e5" : "#171717"};
    -webkit-app-region: drag;
  }
  .container { text-align: center; max-width: 500px; padding: 24px; }
  h2 { font-size: 16px; font-weight: 500; margin-bottom: 12px; color: #ef4444; }
  pre {
    font-size: 12px; background: ${nativeTheme.shouldUseDarkColors ? "#1a1a1a" : "#f5f5f5"};
    padding: 12px; border-radius: 8px; text-align: left;
    overflow-x: auto; white-space: pre-wrap; word-break: break-all;
  }
</style>
</head>
<body>
  <div class="container">
    <h2>Failed to start server</h2>
    <pre>${message.replace(/</g, "&lt;")}</pre>
  </div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", (_event, argv) => {
  const deepLink = argv.find((arg) => arg.startsWith(`${DEEP_LINK_PROTOCOL}://`));
  if (deepLink) handleDeepLink(deepLink);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

app.whenReady().then(async () => {
  registerDeepLinkProtocol();

  // Clear cached web content so we always load the latest UI
  await session.defaultSession.clearCache();

  // Install/update CLI binary to ~/.godtool/bin
  installCli();

  settings = loadSettings();
  setupWorkspaceFileProtocol();
  setupIPC();
  buildMenu();

  mainWindow = createWindow();
  await startBrowserHost();
  await startComputerUseHost();

  mkdirSync(DEFAULT_WORKSPACE_DIR, { recursive: true });
  await loadScope(DEFAULT_WORKSPACE_DIR);
  fetchCloudAuthState()
    .then(syncDeviceConnection)
    .catch((error) => console.warn("[devices] initial auth check failed", error));
});

app.on("window-all-closed", () => {
  stopBrowserHost();
  stopComputerUseHost();
  stopDeviceConnection();
  stopDesktopAuthCallbackServer();
  // Synchronously kill the server process before quitting
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
  app.quit();
});

app.on("before-quit", () => {
  stopBrowserHost();
  stopComputerUseHost();
  stopDeviceConnection();
  stopDesktopAuthCallbackServer();
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
});

// Last resort: kill server on exit
process.on("exit", () => {
  stopComputerUseHost();
  stopDeviceConnection();
  stopDesktopAuthCallbackServer();
  if (serverProcess) {
    serverProcess.kill("SIGKILL");
    serverProcess = null;
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    mkdirSync(DEFAULT_WORKSPACE_DIR, { recursive: true });
    void loadScope(DEFAULT_WORKSPACE_DIR);
  }
});

// Locating the `nodecode` CLI, its version, and the three things the extension
// does through it: turn the web cell on, start the gateway, open the page.

import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { NodecodeDiscovery, Notifications } from "./discovery";

export const NODECODE_CLI_UNKNOWN_VERSION = "unknown";
export const NODECODE_SITE_URL = "https://nodecode.ai";
export const NODECODE_DOCS_URL = "https://nodecode.ai/docs";
export const NODECODE_INSTALL_URL = "https://nodecode.ai/install.sh";
export const NODECODE_INSTALL_COMMAND = "curl -fsSL https://nodecode.ai/install.sh | sh";
export const NODECODE_WINDOWS_INSTALL_COMMAND = "irm https://nodecode.ai/install.ps1 | iex";
/** The cell that serves the gateway's own page at /web/. */
export const NODECODE_WEB_CELL = "web";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function installCommand(platform: string = process.platform): string {
  return platform === "win32" ? NODECODE_WINDOWS_INSTALL_COMMAND : NODECODE_INSTALL_COMMAND;
}

export function resolveCliBinary(
  configured: string,
  options: { pathEnv: string; home: string; platform: string; localAppData?: string } = {
    pathEnv: process.env.PATH ?? "",
    home: os.homedir(),
    platform: process.platform,
    localAppData: process.env.LOCALAPPDATA,
  },
): string | undefined {
  const executable = (file: string): boolean => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      fs.accessSync(file, options.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (configured.includes("/") || configured.includes("\\")) return executable(configured) ? configured : undefined;
  const extensions = options.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of options.pathEnv.split(options.platform === "win32" ? ";" : path.delimiter)) {
    if (!directory) continue;
    for (const ext of extensions) {
      const candidate = path.join(directory, configured + ext);
      if (executable(candidate)) return candidate;
    }
  }
  // A GUI-launched VS Code often misses the installer's ~/.local/bin PATH entry.
  if (configured === "nodecode") {
    const candidates =
      options.platform === "win32"
        ? [path.join(options.localAppData ?? path.join(options.home, "AppData", "Local"), "Programs", "nodecode", "current", "nodecode.exe")]
        : [path.join(options.home, ".local", "bin", "nodecode"), path.join(options.home, ".local", "share", "nodecode", "current", "nodecode")];
    for (const candidate of candidates) if (executable(candidate)) return candidate;
  }
  return undefined;
}

export class NodecodeCli {
  version: string = NODECODE_CLI_UNKNOWN_VERSION;
  private versionFailure = "";
  private versionBinary: string | undefined;

  constructor(
    private readonly discovery: NodecodeDiscovery,
    private readonly notes: Notifications,
  ) {}

  configuredPath(): string {
    return vscode.workspace.getConfiguration("nodecode").get<string>("cliPath")?.trim() || "nodecode";
  }

  resolve(): string | undefined {
    return resolveCliBinary(this.configuredPath());
  }

  /** Read `nodecode --version`; a failure leaves version unknown and its reason set. */
  /**
   * Read `nodecode --version`, cached per binary: the view's poll cannot afford a
   * process on every tick, and the version only changes when the binary does. A
   * failed read is not cached, so the screen after an install keeps retrying.
   */
  readVersion(binary: string): string {
    if (this.versionBinary === binary && !this.versionFailure) return this.version;
    this.versionBinary = binary;
    this.versionFailure = "";
    try {
      const out = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
      this.version = out || NODECODE_CLI_UNKNOWN_VERSION;
    } catch (error) {
      this.version = NODECODE_CLI_UNKNOWN_VERSION;
      this.versionFailure = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
    return this.version;
  }

  /** Why the last readVersion failed, when it did. */
  versionError(): string {
    return this.versionFailure;
  }

  /** One CLI command; never throws. */
  run(args: string[], timeoutMs = 120000): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      const binary = this.resolve();
      if (!binary) {
        resolve({ code: -1, stdout: "", stderr: "nodecode is not installed or not on PATH", timedOut: false });
        return;
      }
      const child = execFile(
        binary,
        args,
        { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const timedOut = (error as { killed?: boolean } | null)?.killed === true;
          const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut });
        },
      );
      this.notes.log(`nodecode ${args.join(" ")} (pid ${child.pid ?? "?"})`);
    });
  }

  /** The link `nodecode web --print` prints, or undefined when the page is not served. */
  async webLink(): Promise<string | undefined> {
    const result = await this.run(["web", "--print"], 25000);
    if (result.code !== 0) {
      this.notes.log(`nodecode web --print failed: ${result.stderr.trim() || result.code}`);
      return undefined;
    }
    const link = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^http:\/\/127\.0\.0\.1:\d+\/web\//.test(line));
    return link;
  }

  /** Turn the web cell on (installs the shipped cell when it is missing, and starts it live). */
  enableWebCell(): Promise<CommandResult> {
    return this.run(["add", `nc://${NODECODE_WEB_CELL}`, "--yes", "--wait", "120"], 180000);
  }

  /** Keep the gateway running in the background, and at login. */
  startGateway(): Promise<CommandResult> {
    return this.run(["gateway", "on"], 90000);
  }

  /** Open this home's page in the operator's own browser. */
  openInBrowser(): void {
    const binary = this.resolve();
    if (!binary) {
      void vscode.window.showErrorMessage("Nodecode is not installed — install it first, then try again.");
      return;
    }
    execFile(binary, ["web"], { timeout: 30000 }, (error) => {
      if (error) this.notes.log(`nodecode web failed: ${error.message.split("\n")[0]}`);
    });
  }

  /** Run the official installer in a terminal the operator can watch. */
  installInTerminal(): void {
    const terminal = vscode.window.createTerminal({
      name: "Install Nodecode",
      ...(process.platform === "win32" ? { shellPath: "powershell.exe" } : {}),
    });
    terminal.show();
    terminal.sendText(installCommand());
  }
}

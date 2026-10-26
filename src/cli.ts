// Locating and health-checking the `nodecode` CLI, and respawning the
// gateway when it is restorable but down.

import { ChildProcess, execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { NodecodeDiscovery, Notifications } from "./discovery";
import { NODECODE_CLI_UNKNOWN_VERSION } from "./protocol";

export const NODECODE_INSTALL_URL = "https://nodecode.ai/install.sh";
export const NODECODE_INSTALL_COMMAND = "curl -fsSL https://nodecode.ai/install.sh | sh";
export const NODECODE_WINDOWS_INSTALL_COMMAND = "irm https://nodecode.ai/install.ps1 | iex";
export type RuntimeFailureReason = "missing-cli" | "unusable-cli" | "gateway-unavailable";
export type EnsureReadyResult = "ok" | { failure: string; reason: RuntimeFailureReason; fixableByDaemon: boolean };
export interface RuntimeStatus {
  state: "ready" | RuntimeFailureReason;
  message: string;
  binary?: string;
  installCommand?: string;
  installUrl: string;
  canRestart: boolean;
}

export function resolveCliBinary(configured: string, options: {pathEnv:string;home:string;platform:string;localAppData?:string} = {pathEnv:process.env.PATH ?? "", home:os.homedir(), platform:process.platform,localAppData:process.env.LOCALAPPDATA}): string | undefined {
  const executable = (file: string): boolean => {
    try { if (!fs.statSync(file).isFile()) return false; fs.accessSync(file, options.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return true; }
    catch { return false; }
  };
  if (configured.includes("/") || configured.includes("\\")) return executable(configured) ? configured : undefined;
  const extensions = options.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of options.pathEnv.split(options.platform === "win32" ? ";" : path.delimiter)) {
    if (!directory) continue;
    for (const ext of extensions) { const candidate = path.join(directory, configured + ext); if (executable(candidate)) return candidate; }
  }
  // GUI-launched VS Code often misses the installer's ~/.local/bin PATH entry.
  if (configured === "nodecode") {
    const candidates = options.platform === "win32"
      ? [path.join(options.localAppData ?? path.join(options.home,"AppData","Local"),"Programs","nodecode","current","nodecode.exe")]
      : [path.join(options.home,".local","bin","nodecode"),path.join(options.home,".local","share","nodecode","current","nodecode")];
    for (const candidate of candidates) if (executable(candidate)) return candidate;
  }
  return undefined;
}

export class NodecodeCli {
  private readonly discovery: NodecodeDiscovery;
  private readonly notes: Notifications;
  version: string = NODECODE_CLI_UNKNOWN_VERSION;
  private versionFailure = "";

  constructor(discovery: NodecodeDiscovery, notes: Notifications) {
    this.discovery = discovery;
    this.notes = notes;
  }

  configuredPath(): string {
    return (
      vscode.workspace.getConfiguration("nodecode").get<string>("cliPath")?.trim() ||
      "nodecode"
    );
  }

  resolve(): string | undefined {
    return resolveCliBinary(this.configuredPath());
  }

  readVersion(binary: string): string {
    this.versionFailure = "";
    try {
      const out = execFileSync(binary, ["--version"], {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      this.version = out || NODECODE_CLI_UNKNOWN_VERSION;
    } catch (error) {
      this.version = NODECODE_CLI_UNKNOWN_VERSION;
      this.versionFailure = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
    return this.version;
  }

  /** CLI resolvable + gateway answering. Never throws. */
  async ensureReady(): Promise<EnsureReadyResult> {
    const binary = this.resolve();
    if (!binary) {
      const configured = this.configuredPath();
      const failure =
        configured === "nodecode"
          ? "`nodecode` is not on PATH. Install Nodecode or set nodecode.cliPath to the binary."
          : `nodecode.cliPath points at ${configured}, which does not exist.`;
      return { failure, reason: "missing-cli", fixableByDaemon: false };
    }
    this.readVersion(binary);
    if (this.versionFailure) return {failure:`Nodecode was found at ${binary}, but could not start: ${this.versionFailure}`,reason:"unusable-cli",fixableByDaemon:false};
    let endpoint = this.discovery.current();
    if (!endpoint) endpoint = await this.discovery.probe();
    if (!endpoint) {
      const fixable = this.discovery.canRestore;
      const failure = fixable
        ? "The Nodecode gateway is not answering, but its store is still present — it can be restarted."
        : "No Nodecode gateway is running in this home (no history.db.owner). Start one (nodecode serve) and retry.";
      return { failure, reason:"gateway-unavailable", fixableByDaemon: fixable };
    }
    return "ok";
  }

  /** Restart the gateway when ensureReady flagged it fixable. */
  ensureDaemon(fixable: boolean): void {
    if (!fixable) return;
    const binary = this.resolve();
    if (!binary) return;
    try {
      const store = path.join(NodecodeDiscovery.nodecodeHome(), "history.db");
      const child = spawn(binary, ["serve", "--store", store], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      this.notes.log(`Respawned gateway: ${binary} serve --store ${store} (pid ${child.pid})`);
    } catch (error) {
      this.notes.log(`Failed to respawn gateway: ${String(error)}`);
    }
  }

  spawnRpc(sessionId: string | undefined, cwd: string, cursor?: number): ChildProcess | undefined {
    const binary = this.resolve();
    if (!binary) return undefined;
    const args = sessionId ? ["rpc", sessionId] : ["rpc"];
    if (sessionId && cursor !== undefined) args.push("--cursor", String(cursor));
    return spawn(binary, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  }
}

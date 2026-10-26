// Locating and health-checking the `nodecode` CLI, and respawning the
// gateway when it is restorable but down.

import { ChildProcess, execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { NodecodeDiscovery, Notifications } from "./discovery";
import { NODECODE_CLI_UNKNOWN_VERSION } from "./protocol";

export type EnsureReadyResult = "ok" | { failure: string; fixableByDaemon: boolean };

export class NodecodeCli {
  private readonly discovery: NodecodeDiscovery;
  private readonly notes: Notifications;
  version: string = NODECODE_CLI_UNKNOWN_VERSION;

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
    const configured = this.configuredPath();
    if (configured.includes("/")) {
      return fs.existsSync(configured) ? configured : undefined;
    }
    const pathEnv = process.env.PATH ?? "";
    const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    for (const dir of pathEnv.split(path.delimiter)) {
      if (!dir) continue;
      for (const ext of exts) {
        const candidate = path.join(dir, configured + ext);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  }

  readVersion(binary: string): string {
    try {
      const out = execFileSync(binary, ["--version"], {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      this.version = out || NODECODE_CLI_UNKNOWN_VERSION;
    } catch {
      this.version = NODECODE_CLI_UNKNOWN_VERSION;
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
      return { failure, fixableByDaemon: false };
    }
    this.readVersion(binary);
    let endpoint = this.discovery.current();
    if (!endpoint) endpoint = await this.discovery.probe();
    if (!endpoint) {
      const fixable = this.discovery.canRestore;
      const failure = fixable
        ? "The Nodecode gateway is not answering, but its store is still present — it can be restarted."
        : "No Nodecode gateway is running in this home (no history.db.owner). Start one (nodecode serve) and retry.";
      return { failure, fixableByDaemon: fixable };
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

  spawnRpc(sessionId: string | undefined, cwd: string): ChildProcess | undefined {
    const binary = this.resolve();
    if (!binary) return undefined;
    const args = sessionId ? ["rpc", sessionId] : ["rpc"];
    return spawn(binary, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
  }
}

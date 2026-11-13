// Discovery of the running Nodecode gateway: the API port is published in
// ~/.nodecode/history.db.owner ({"pid": ..., "port": ...}) while that file
// exists, and the operator bearer token lives in ~/.nodecode/operator-token.

import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export interface GatewayEndpoint {
  baseUrl: string;
  token: string;
  port: number;
  pid: number;
}

interface OwnerFile {
  pid?: number;
  port?: number;
}

export class Notifications {
  private output: vscode.OutputChannel | undefined;
  private activationLog: string[] = [];

  constructor(private readonly name: string) {}

  private channel(): vscode.OutputChannel {
    if (!this.output) this.output = vscode.window.createOutputChannel(this.name);
    return this.output;
  }

  log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.activationLog.push(line);
    if (this.activationLog.length > 500) this.activationLog.shift();
    if (vscode.workspace.getConfiguration("nodecode").get<boolean>("diagnostics")) {
      this.channel().appendLine(line);
    }
  }

  show(): void {
    this.channel().show(true);
    this.channel().appendLine(this.activationLog.join("\n"));
  }

  dispose(): void {
    this.output?.dispose();
    this.output = undefined;
  }
}

export class NodecodeDiscovery {
  private lastEndpoint: GatewayEndpoint | null = null;
  private changes = 0;
  private probeGeneration = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly emitter = new vscode.EventEmitter<GatewayEndpoint | null>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly notes: Notifications) {}

  static nodecodeHome(): string {
    return process.env.NODECODE_HOME || path.join(os.homedir(), ".nodecode");
  }

  static ownerPath(): string {
    return path.join(NodecodeDiscovery.nodecodeHome(), "history.db.owner");
  }

  static tokenPath(): string {
    return path.join(NodecodeDiscovery.nodecodeHome(), "operator-token");
  }

  current(): GatewayEndpoint | null {
    return this.lastEndpoint;
  }

  /** How many times the endpoint has changed; a frame carries it so a restart is framed afresh. */
  get revision(): number {
    return this.changes;
  }

  private readOwner(): OwnerFile | null {
    try {
      const raw = fs.readFileSync(NodecodeDiscovery.ownerPath(), "utf8");
      return JSON.parse(raw) as OwnerFile;
    } catch {
      return null;
    }
  }

  private readToken(): string {
    try {
      return fs.readFileSync(NodecodeDiscovery.tokenPath(), "utf8").trim();
    } catch {
      return "";
    }
  }

  /** Single probe pass. Never throws. */
  async probe(): Promise<GatewayEndpoint | null> {
    const generation = ++this.probeGeneration;
    const owner = this.readOwner();
    if (!owner || typeof owner.port !== "number" || !Number.isInteger(owner.port) || owner.port < 1 || owner.port > 65535) {
      this.setEndpoint(null);
      return null;
    }
    const endpoint: GatewayEndpoint = {
      baseUrl: `http://127.0.0.1:${owner.port}`,
      token: this.readToken(),
      port: owner.port,
      pid: typeof owner.pid === "number" ? owner.pid : 0,
    };
    const ok = await this.ping(endpoint);
    if (generation !== this.probeGeneration) return this.lastEndpoint;
    if (ok) {
      this.setEndpoint(endpoint);
      return endpoint;
    }
    this.setEndpoint(null);
    return null;
  }

  private ping(endpoint: GatewayEndpoint): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const req = http.request(
        `${endpoint.baseUrl}/api/gateway/target`,
        {
          method: "GET",
          timeout: 3000,
          headers: endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {},
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    }).catch(() => false);
  }

  /**
   * Hold the endpoint the page is framed from. A change in the port, in the
   * operator token or in the gateway's own pid is a change the operator must
   * see: a rotated token leaves the framed page holding one the gateway no
   * longer accepts, and a gateway restarted on the same port has left the
   * framed page talking to a socket that closed.
   */
  private setEndpoint(next: GatewayEndpoint | null): void {
    const prev = this.lastEndpoint;
    const changed = prev?.baseUrl !== next?.baseUrl || prev?.token !== next?.token || prev?.pid !== next?.pid;
    this.lastEndpoint = next;
    if (!changed) return;
    this.changes += 1;
    this.emitter.fire(next);
  }

  /** Watch the owner + token files and re-probe; call once at activation. */
  watch(context: vscode.ExtensionContext, intervalMs = 15000): void {
    void this.probe();
    const onFs = () => void this.probe();
    for (const file of [NodecodeDiscovery.ownerPath(), NodecodeDiscovery.tokenPath()]) {
      fs.watchFile(file, { interval: 2000 }, onFs);
      context.subscriptions.push({ dispose: () => fs.unwatchFile(file, onFs) });
    }
    this.timer = setInterval(() => void this.probe(), intervalMs);
    context.subscriptions.push({ dispose: () => clearInterval(this.timer) });
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.emitter.dispose();
  }
}

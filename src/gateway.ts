// What the view needs to know before it can show anything: is nodecode
// installed, is its gateway running, is the web cell on — and, once all three
// hold, which page to frame.

import * as http from "http";
import * as vscode from "vscode";

import { NodecodeCli, installCommand, NODECODE_DOCS_URL, NODECODE_INSTALL_URL } from "./cli";
import { GatewayEndpoint, NodecodeDiscovery, Notifications } from "./discovery";
import { GatewayProxy, startGatewayProxy } from "./proxy";

export type GatewayState = "ready" | "missing-cli" | "unusable-cli" | "gateway-down" | "web-cell-off";

export interface GatewayStatus {
  state: GatewayState;
  /** One line the view shows for anything but ready. */
  message: string;
  version: string;
  binary?: string;
  installCommand: string;
  installUrl: string;
  docsUrl: string;
  /** Where the gateway is, when one answered. */
  baseUrl?: string;
}

/** True when the gateway answers its own page at /web/. */
export function servesWebPage(baseUrl: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request = http.request(`${baseUrl}/web/`, { method: "GET", timeout: timeoutMs }, (response) => {
      const type = String(response.headers["content-type"] ?? "");
      response.resume();
      resolve(response.statusCode === 200 && type.includes("text/html"));
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
    request.end();
  });
}

/** The page's own link: the operator token rides in the fragment, which no server sees. */
export function pageLink(endpoint: GatewayEndpoint): string {
  return `${endpoint.baseUrl}/web/#t=${encodeURIComponent(endpoint.token)}`;
}

export function pageUrl(base: string, endpoint: GatewayEndpoint): string {
  return `${base.replace(/\/+$/, "")}/web/#t=${encodeURIComponent(endpoint.token)}`;
}

export class Gateway {
  private proxy: GatewayProxy | undefined;
  private proxyPort: number | undefined;
  private inflight: Promise<GatewayStatus> | undefined;
  private readonly emitter = new vscode.EventEmitter<GatewayStatus>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly cli: NodecodeCli,
    private readonly discovery: NodecodeDiscovery,
    private readonly notes: Notifications,
  ) {}

  /** Install / gateway / web cell, in the order they gate one another. Never throws. */
  status(): Promise<GatewayStatus> {
    if (!this.inflight) {
      this.inflight = this.inspect().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private base(): Pick<GatewayStatus, "installCommand" | "installUrl" | "docsUrl"> {
    return { installCommand: installCommand(), installUrl: NODECODE_INSTALL_URL, docsUrl: NODECODE_DOCS_URL };
  }

  private async inspect(): Promise<GatewayStatus> {
    const binary = this.cli.resolve();
    const version = this.cli.version;
    const common = { version, binary, ...this.base() };
    if (!binary) {
      return {
        ...common,
        state: "missing-cli",
        message: "Nodecode is not installed, or not on this machine's PATH. Install it, then check again.",
      };
    }
    this.cli.readVersion(binary);
    if (this.cli.versionError()) {
      return {
        ...common,
        version: this.cli.version,
        state: "unusable-cli",
        message: `Nodecode was found at ${binary} but would not start: ${this.cli.versionError()}`,
      };
    }
    const endpoint = this.discovery.current() ?? (await this.discovery.probe());
    if (!endpoint) {
      return {
        ...common,
        version: this.cli.version,
        state: "gateway-down",
        message: "The Nodecode gateway is not running in this home. Start it, and it stays up in the background.",
      };
    }
    if (!(await servesWebPage(endpoint.baseUrl))) {
      return {
        ...common,
        version: this.cli.version,
        state: "web-cell-off",
        baseUrl: endpoint.baseUrl,
        message: `The gateway is running at ${endpoint.baseUrl} without the web cell, which serves the page this view shows. Turn it on.`,
      };
    }
    return { ...common, version: this.cli.version, state: "ready", message: "Nodecode is ready.", baseUrl: endpoint.baseUrl };
  }

  /** A proxy in front of the gateway's port, reused until the port changes. */
  private async ensureProxy(endpoint: GatewayEndpoint): Promise<GatewayProxy> {
    if (this.proxy && this.proxyPort === endpoint.port) return this.proxy;
    this.proxy?.dispose();
    this.proxy = undefined;
    this.proxyPort = undefined;
    const proxy = await startGatewayProxy({ host: "127.0.0.1", port: endpoint.port }, (line) => this.notes.log(line));
    this.proxy = proxy;
    this.proxyPort = endpoint.port;
    this.notes.log(`page proxy ${proxy.origin} -> ${endpoint.baseUrl}`);
    return proxy;
  }

  /** The link a webview frames, and the origin its CSP must allow. */
  async frame(): Promise<{ status: GatewayStatus; pageUrl?: string; pageOrigin?: string }> {
    const status = await this.status();
    if (status.state !== "ready") return { status };
    const endpoint = this.discovery.current();
    if (!endpoint) return { status: { ...status, state: "gateway-down", message: "The Nodecode gateway stopped answering." } };
    try {
      const proxy = await this.ensureProxy(endpoint);
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(proxy.origin));
      const base = external.toString();
      const origin = new URL(base).origin;
      return { status, pageUrl: pageUrl(base, endpoint), pageOrigin: origin };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.notes.log(`page proxy failed: ${message}`);
      return { status: { ...status, state: "gateway-down", message: `The page proxy could not start: ${message}` } };
    }
  }

  /** The gateway's own link, for opening in a browser. */
  async link(): Promise<string | undefined> {
    const endpoint = this.discovery.current() ?? (await this.discovery.probe());
    return endpoint ? pageLink(endpoint) : undefined;
  }

  async enableWebCell(): Promise<GatewayStatus> {
    const result = await this.cli.enableWebCell();
    if (result.code !== 0) this.notes.log(`add nc://web failed: ${(result.stderr || result.stdout).trim()}`);
    await this.discovery.probe();
    return this.refresh();
  }

  async startGateway(): Promise<GatewayStatus> {
    const binary = this.cli.resolve();
    const version = this.cli.version;
    if (!binary) return { ...this.base(), state: "missing-cli", version, message: "Nodecode is not installed yet." };
    this.cli.readVersion(binary);
    const result = await this.cli.startGateway();
    if (result.code !== 0) this.notes.log(`gateway on failed: ${(result.stderr || result.stdout).trim()}`);
    // The unit starts its own process: give it a moment to publish its port.
    const deadline = Date.now() + 25000;
    const current = this.cli.version;
    while (Date.now() < deadline) {
      if (await this.discovery.probe()) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return this.status();
  }

  refresh(): Promise<GatewayStatus> {
    return this.status();
  }

  notify(status: GatewayStatus): void {
    this.emitter.fire(status);
  }

  dispose(): void {
    this.proxy?.dispose();
    this.proxy = undefined;
    this.proxyPort = undefined;
    this.emitter.dispose();
  }
}

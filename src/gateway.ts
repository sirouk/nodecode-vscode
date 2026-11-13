// What the view needs to know before it can show anything: is nodecode
// installed, is its gateway running, is the web cell on — and, once all three
// hold, which page to frame.

import * as http from "http";
import * as vscode from "vscode";

import { CommandResult, NodecodeCli, installCommand, NODECODE_DOCS_URL, NODECODE_INSTALL_URL } from "./cli";
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
  private starting: { port: number; proxy: Promise<GatewayProxy> } | undefined;
  private inflight: Promise<GatewayStatus> | undefined;

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
    if (!binary) {
      return {
        ...this.base(),
        version: this.cli.version,
        state: "missing-cli",
        message: "Nodecode is not installed, or not on this machine's PATH. Install it, then check again.",
      };
    }
    this.cli.readVersion(binary);
    const common = { ...this.base(), version: this.cli.version, binary };
    if (this.cli.versionError()) {
      return {
        ...common,
        state: "unusable-cli",
        message: `Nodecode was found at ${binary} but would not start: ${this.cli.versionError()}`,
      };
    }
    // Ask rather than remember: a cached endpoint outlives the gateway that published
    // it, and a stopped gateway would then be reported as one missing its web cell.
    const endpoint = await this.discovery.probe();
    if (!endpoint) {
      return {
        ...common,
        state: "gateway-down",
        message: "The Nodecode gateway is not running in this home. Start it, and it stays up in the background.",
      };
    }
    if (!(await servesWebPage(endpoint.baseUrl))) {
      return {
        ...common,
        state: "web-cell-off",
        baseUrl: endpoint.baseUrl,
        message: `The gateway is running at ${endpoint.baseUrl} without the web cell, which serves the page this view shows. Turn it on.`,
      };
    }
    return { ...common, state: "ready", message: "Nodecode is ready.", baseUrl: endpoint.baseUrl };
  }

  /**
   * A proxy in front of the gateway's port, reused until the port changes or it
   * stops listening. Two surfaces render at once (sidebar and an editor tab),
   * so one start is shared rather than racing a second listener into existence.
   */
  private ensureProxy(endpoint: GatewayEndpoint): Promise<GatewayProxy> {
    if (this.proxy && this.proxyPort === endpoint.port && this.proxy.listening()) return Promise.resolve(this.proxy);
    if (this.starting && this.starting.port === endpoint.port) return this.starting.proxy;
    this.dropProxy();
    const port = endpoint.port;
    const proxy = startGatewayProxy({ host: "127.0.0.1", port }, (line) => this.notes.log(line)).then(
      (started) => {
        this.proxy = started;
        this.proxyPort = port;
        this.notes.log(`page proxy ${started.origin} -> http://127.0.0.1:${port}`);
        return started;
      },
      (error: unknown) => {
        this.notes.log(`page proxy failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      },
    );
    const entry = { port, proxy };
    this.starting = entry;
    void proxy
      .catch(() => undefined)
      .finally(() => {
        if (this.starting === entry) this.starting = undefined;
      });
    return proxy;
  }

  private dropProxy(): void {
    this.proxy?.dispose();
    this.proxy = undefined;
    this.proxyPort = undefined;
    this.starting = undefined;
  }

  /** The link a webview frames, and the origin its CSP must allow. */
  async frame(): Promise<{ status: GatewayStatus; pageUrl?: string; pageOrigin?: string; revision?: number }> {
    const status = await this.status();
    if (status.state !== "ready") return { status };
    const endpoint = this.discovery.current();
    if (!endpoint) return { status: { ...status, state: "gateway-down", message: "The Nodecode gateway stopped answering." } };
    try {
      const proxy = await this.ensureProxy(endpoint);
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(proxy.origin));
      const base = external.toString();
      const origin = new URL(base).origin;
      return { status, pageUrl: pageUrl(base, endpoint), pageOrigin: origin, revision: this.discovery.revision };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
    this.report("turning on the web cell", result);
    await this.discovery.probe();
    return this.status();
  }

  async startGateway(): Promise<GatewayStatus> {
    const binary = this.cli.resolve();
    if (!binary) {
      return { ...this.base(), state: "missing-cli", version: this.cli.version, message: "Nodecode is not installed yet." };
    }
    this.cli.readVersion(binary);
    const result = await this.cli.startGateway();
    this.report("starting the gateway", result);
    // The unit starts its own process: give it a moment to publish its port.
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (await this.discovery.probe()) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return this.status();
  }

  /**
   * A command that failed leaves the same screen behind, so say why in the
   * gateway's own words: a click that changes nothing and explains nothing is
   * the one outcome this view must never produce.
   */
  private report(what: string, result: CommandResult): void {
    if (result.code === 0) return;
    this.notes.log(`${what} failed: ${(result.stderr || result.stdout).trim().split("\n")[0] || `exit ${result.code}`}`);
    // The gateway's own words, minus the operator token if it appears in them.
    const token = this.discovery.current()?.token;
    const spoken = (result.stderr || result.stdout).trim().split("\n")[0] || `exit ${result.code}`;
    const reason = token ? spoken.split(token).join("<token>") : spoken;
    void vscode.window.showErrorMessage(`Nodecode: ${what} failed — ${reason}`);
  }

  dispose(): void {
    this.dropProxy();
  }
}

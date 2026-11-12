// The view: the gateway's own page, framed, and nothing else. Until nodecode is
// installed, its gateway is up and the web cell is on, the same view says what
// is missing and offers the one step that fixes it.

import * as vscode from "vscode";

import { Gateway, GatewayState, GatewayStatus } from "./gateway";
import { Notifications } from "./discovery";

export interface Frame {
  url: string;
  origin: string;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ACTIONS: Record<string, string> = {
  install: "Install Nodecode",
  start: "Start the gateway",
  enable: "Turn on the web cell",
  recheck: "Check again",
};

function buttons(status: GatewayStatus, working: boolean): string {
  const actions: string[] = [];
  if (status.state === "missing-cli" || status.state === "unusable-cli") actions.push("install");
  if (status.state === "gateway-down") actions.push("start");
  if (status.state === "web-cell-off") actions.push("enable");
  actions.push("recheck");
  const rows = actions
    .map(
      (action, index) =>
        `<button class="action${index === 0 ? " primary" : ""}" data-action="${action}"${working ? " disabled" : ""}>${escapeHtml(ACTIONS[action])}</button>`,
    )
    .join("");
  return `<div class="actions">${rows}<button class="action link" data-action="docs"${working ? " disabled" : ""}>Read the docs</button></div>`;
}

/** One page of HTML for one state of the extension. */
export function renderHtml(options: { status: GatewayStatus; frame?: Frame; nonce: string; cspSource: string; working?: string }): string {
  const { status, frame, nonce } = options;
  const frameSource = frame ? frame.origin : "http://127.0.0.1:*";
  const style = `
      html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
      body { background: var(--vscode-sideBar-background, var(--vscode-editor-background)); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
      iframe { border: 0; display: block; width: 100%; height: 100%; background: transparent; }
      .setup { box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; padding: 20px 18px; max-width: 460px; }
      .mark { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; opacity: .55; }
      h1 { font-size: 15px; font-weight: 600; margin: 0; line-height: 1.35; }
      p { margin: 0; font-size: 12px; line-height: 1.55; opacity: .82; }
      code { display: block; font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 1.6;
             background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12)); border-radius: 4px; padding: 8px 10px;
             overflow-x: auto; white-space: pre; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .action { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 3px; cursor: pointer;
                color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid transparent; }
      .action:hover { background: var(--vscode-button-secondaryHoverBackground); }
      .action.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
      .action.primary:hover { background: var(--vscode-button-hoverBackground); }
      .action.link { background: none; color: var(--vscode-textLink-foreground); padding-left: 2px; }
      .action[disabled] { opacity: .5; cursor: default; }
      .meta { font-size: 11px; line-height: 1.5; opacity: .55; }
    `;

  const script = `
      const api = acquireVsCodeApi();
      for (const button of document.querySelectorAll("[data-action]")) {
        button.addEventListener("click", () => api.postMessage({ type: button.dataset.action }));
      }
    `;
  const csp = `default-src 'none'; frame-src ${frameSource}; img-src ${frameSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;

  const body = frame
    ? `<iframe id="page" src="${escapeHtml(frame.url)}" allow="clipboard-read; clipboard-write" title="Nodecode"></iframe>`
    : options.working
      ? `<div class="setup"><div class="mark">Nodecode</div><h1>${escapeHtml(options.working)}</h1></div>`
      : `<div class="setup">
      <div class="mark">Nodecode</div>
      <h1>${escapeHtml(status.message)}</h1>
      ${
        status.state === "missing-cli" || status.state === "unusable-cli"
          ? `<p>Nodecode runs as one process on this machine, and this view is its own page. Install it, then check again.</p><code>${escapeHtml(status.installCommand)}</code>`
          : ""
      }
      ${status.state === "gateway-down" ? `<p>The gateway is the background process the page talks to. Starting it here also keeps it running at login.</p>` : ""}
      ${status.state === "web-cell-off" ? `<p>The web cell ships with Nodecode and serves the page at <code class="inline">/web/</code>. Turning it on adds it to your cells folder, where Nodecode keeps it up to date.</p>` : ""}
      ${buttons(status, false)}
      <div class="meta">${escapeHtml(status.binary ?? "nodecode")}${status.version && status.version !== "unknown" ? ` · ${escapeHtml(status.version)}` : ""} · <a href="${escapeHtml(status.docsUrl)}">docs</a></div>
    </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">${style}</style>
</head>
<body>
${body}
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

interface Surface {
  webview: vscode.Webview;
  /** What this surface was last given, so an unchanged poll writes nothing. */
  shown?: string;
}

/** A framed page is a whole application: poll slowly while it is up, quickly while setting up. */
const READY_POLL_MS = 20000;
const SETUP_POLL_MS = 5000;

/** Keeps every surface (sidebar view, editor tabs) on the same page. */
export class NodecodeView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly surfaces = new Set<Surface>();
  private readonly panels = new Set<vscode.WebviewPanel>();
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private state: GatewayState | undefined;

  constructor(
    private readonly gateway: Gateway,
    private readonly notes: Notifications,
    private readonly actions: { install: () => void },
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    const surface: Surface = { webview: view.webview };
    view.webview.onDidReceiveMessage((message: { type?: string }) => void this.act(message?.type ?? "", surface));
    view.onDidDispose(() => {
      this.surfaces.delete(surface);
      if (this.surfaces.size === 0) this.stop();
    });
    this.surfaces.add(surface);
    this.start();
    void this.render(surface);
  }

  /** A second copy of the same page, in an editor tab: room for the wide layout. */
  async openInEditor(): Promise<void> {
    const panel = vscode.window.createWebviewPanel("nodecodePage", "Nodecode", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    const surface: Surface = { webview: panel.webview };
    panel.webview.onDidReceiveMessage((message: { type?: string }) => void this.act(message?.type ?? "", surface));
    panel.onDidDispose(() => {
      this.panels.delete(panel);
      this.surfaces.delete(surface);
      if (this.surfaces.size === 0) this.stop();
    });
    this.panels.add(panel);
    this.surfaces.add(surface);
    this.start();
    await this.render(surface);
  }

  private start(): void {
    if (this.timer || this.disposed || this.surfaces.size === 0) return;
    const wait = this.state === "ready" ? READY_POLL_MS : SETUP_POLL_MS;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().finally(() => this.start());
    }, wait);
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async refresh(): Promise<void> {
    for (const surface of [...this.surfaces]) await this.render(surface);
  }

  /**
   * Show the current state. Writing the webview's html again reloads the page
   * inside the frame, and that page carries the operator's own state — so a poll
   * that finds nothing new writes nothing and the page is left alone.
   */
  private async render(surface: Surface, working?: string): Promise<void> {
    if (!this.surfaces.has(surface) || this.disposed) return;
    const frame = working ? undefined : await this.gateway.frame();
    const status = working ? await this.gateway.status() : frame!.status;
    this.state = status.state;
    const page = frame?.pageUrl && frame?.pageOrigin ? { url: frame.pageUrl, origin: frame.pageOrigin } : undefined;
    const shown = [working ?? "", status.state, status.message, page?.url ?? "", page?.origin ?? ""].join("\u0000");
    if (surface.shown === shown) return;
    surface.shown = shown;
    surface.webview.html = renderHtml({ status, frame: page, nonce: nonce(), cspSource: surface.webview.cspSource, working });
  }

  private async act(action: string, surface: Surface): Promise<void> {
    switch (action) {
      case "install":
        this.gatewayInstall();
        return;
      case "docs":
        void vscode.env.openExternal(vscode.Uri.parse("https://nodecode.ai/docs"));
        return;
      case "start": {
        await this.render(surface, "Starting the gateway…");
        const status = await this.gateway.startGateway();
        this.gateway.notify(status);
        await this.refresh();
        return;
      }
      case "enable": {
        await this.render(surface, "Turning the web cell on…");
        const status = await this.gateway.enableWebCell();
        this.gateway.notify(status);
        await this.refresh();
        return;
      }
      case "recheck":
      default:
        await this.refresh();
        return;
    }
  }

  private gatewayInstall(): void {
    this.notes.log("install requested from the view");
    this.actions.install();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    for (const panel of this.panels) panel.dispose();
    this.panels.clear();
    this.surfaces.clear();
  }
}

function nonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 24; index += 1) text += alphabet[Math.floor(Math.random() * alphabet.length)];
  return text;
}

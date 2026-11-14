// The view: the gateway's own page, framed, and nothing else. Until nodecode is
// installed, its gateway is up and the web cell is on, the same view says what
// is missing and offers the one step that fixes it.

import * as crypto from "crypto";
import * as vscode from "vscode";

import { hostScript } from "./bridge";
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

function buttons(status: GatewayStatus): string {
  const actions: string[] = [];
  if (status.state === "missing-cli" || status.state === "unusable-cli") actions.push("install");
  if (status.state === "gateway-down") actions.push("start");
  if (status.state === "web-cell-off") actions.push("enable");
  actions.push("recheck");
  const rows = actions
    .map(
      (action, index) => `<button class="action${index === 0 ? " primary" : ""}" data-action="${action}">${escapeHtml(ACTIONS[action])}</button>`,
    )
    .join("");
  return `<div class="actions">${rows}<button class="action link" data-action="docs">Read the docs</button></div>`;
}

/** One page of HTML for one state of the extension. */
export function renderHtml(options: { status: GatewayStatus; frame?: Frame; nonce: string; working?: string }): string {
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
      p code { display: inline; padding: 1px 4px; white-space: normal; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .action { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 3px; cursor: pointer;
                color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid transparent; }
      .action:hover { background: var(--vscode-button-secondaryHoverBackground); }
      .action.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
      .action.primary:hover { background: var(--vscode-button-hoverBackground); }
      .action.link { background: none; color: var(--vscode-textLink-foreground); padding-left: 2px; }
      .meta { font-size: 11px; line-height: 1.5; opacity: .55; }
      #tailnet { position: absolute; right: 10px; top: 8px; z-index: 10; font-family: var(--vscode-font-family); }
      #tailnet-mark { font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 10px; cursor: pointer;
        color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
        border: 1px solid var(--vscode-widget-border, transparent); opacity: .78; }
      #tailnet-mark:hover, #tailnet-mark.on { opacity: 1; }
      #tailnet-mark .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 6px;
        background: var(--vscode-disabledForeground); vertical-align: middle; }
      #tailnet-mark .dot.live { background: var(--vscode-testing-iconPassed, #3fb950); }
      #tailnet-panel { position: absolute; right: 10px; top: 32px; width: 300px; max-height: 70%; overflow: auto;
        padding: 10px 12px; border-radius: 6px; z-index: 11; font-size: 11px; line-height: 1.5;
        background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35));
        box-shadow: 0 4px 16px rgba(0,0,0,.28); }
      #tailnet-panel h2 { margin: 0 0 8px; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; opacity: .6; font-weight: 600; }
      #tailnet-panel .row { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; }
      #tailnet-panel .grow { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #tailnet-panel .addr { color: var(--vscode-textLink-foreground); cursor: pointer; font-family: var(--vscode-editor-font-family); }
      #tailnet-panel .addr:hover { text-decoration: underline; }
      #tailnet-panel code { display: inline; padding: 0; background: none; font-family: var(--vscode-editor-font-family); letter-spacing: .12em; }
      #tailnet-panel button { font: inherit; font-size: 11px; padding: 1px 7px; border-radius: 3px; cursor: pointer; border: 0;
        color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
      #tailnet-panel button:hover { background: var(--vscode-button-secondaryHoverBackground); }
      #tailnet-panel button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
      #tailnet-panel .why { margin: 0 0 8px; opacity: .7; }
      #tailnet-panel .sep { margin: 10px 0 6px; border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.25)); padding-top: 8px; }
      body { position: relative; }
    `;

  const script = `
      const api = acquireVsCodeApi();
      for (const button of document.querySelectorAll("[data-action]")) {
        button.addEventListener("click", () => api.postMessage({ type: button.dataset.action }));
      }
      ${frame ? hostScript(frame.origin) : ""}
      ${frame ? tailnetScript() : ""}
    `;
  // A machine switch inside the page moves the frame to another loopback forward
  // (the page's machines panel), so loopback is admitted beside this gateway's own
  // origin -- and nothing else is.
  const csp = `default-src 'none'; frame-src ${frameSource} http://127.0.0.1:*; img-src ${frameSource} http://127.0.0.1:* data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;

  const tailnet = frame
    ? `<div id="tailnet"><button id="tailnet-mark" type="button" title="Tailnet access"><span class="dot"></span>Tailnet</button>
       <div id="tailnet-panel" hidden><h2>Tailnet access</h2><div id="tailnet-body"><p class="why">Reading…</p></div></div></div>`
    : "";
  const body = frame
    ? `${tailnet}<iframe id="page" src="${escapeHtml(frame.url)}" allow="clipboard-read; clipboard-write" title="Nodecode"></iframe>`
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
      ${buttons(status)}
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
  /** A page at another loopback port this surface was switched to, if any. */
  target?: string;
}

/** A framed page is a whole application: poll slowly while it is up, quickly while setting up. */
const READY_POLL_MS = 20000;
const SETUP_POLL_MS = 5000;

/** Keeps every surface (sidebar view, editor tab) on the same page. */
export class NodecodeView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly surfaces = new Set<Surface>();
  private panel: vscode.WebviewPanel | undefined;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private state: GatewayState | undefined;

  constructor(
    private readonly gateway: Gateway,
    private readonly notes: Notifications,
    private readonly actions: { install: () => void },
    private readonly tailnet: {
      state: () => Promise<Record<string, unknown>>;
      act: (body: { action: string; index?: number }) => Promise<Record<string, unknown>>;
      install: () => Promise<Record<string, unknown>>;
    },
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    const surface: Surface = { webview: view.webview };
    view.webview.onDidReceiveMessage(
      (message: { type?: string; url?: string; text?: string; index?: number; action?: string }) =>
        void this.act(message?.type ?? "", surface, message?.url, message),
    );
    view.onDidDispose(() => {
      this.surfaces.delete(surface);
      if (this.surfaces.size === 0) this.stop();
    });
    this.surfaces.add(surface);
    this.start();
    void this.render(surface);
  }

  /** The same page in an editor tab, where there is room for the wide layout. */
  async openInEditor(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel("nodecodePage", "Nodecode", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    const surface: Surface = { webview: panel.webview };
    panel.webview.onDidReceiveMessage((message: { type?: string; url?: string }) =>
      void this.act(message?.type ?? "", surface, message?.url),
    );
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
      this.surfaces.delete(surface);
      if (this.surfaces.size === 0) this.stop();
    });
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

  /** Bring every surface up to date; forced, the page is written again even when nothing changed. */
  async refresh(force = false): Promise<void> {
    if (force) for (const surface of this.surfaces) surface.shown = undefined;
    for (const surface of [...this.surfaces]) await this.render(surface);
  }

  /**
   * Show the current state. Writing the webview's html again reloads the page
   * inside the frame, and that page carries the operator's own state — so a poll
   * that finds nothing new writes nothing and the page is left alone.
   */
  private async render(surface: Surface, working?: string): Promise<void> {
    if (!this.surfaces.has(surface) || this.disposed) return;
    const frame = working
      ? undefined
      : surface.target
        ? await this.gateway.frameFor(surface.target)
        : await this.gateway.frame();
    const status = working ? await this.gateway.status() : frame!.status;
    this.state = status.state;
    const page = frame?.pageUrl && frame?.pageOrigin ? { url: frame.pageUrl, origin: frame.pageOrigin } : undefined;
    const shown = [working ?? "", status.state, status.message, page?.url ?? "", page?.origin ?? "", String(frame?.revision ?? "")].join("\u0000");
    if (surface.shown === shown) return;
    try {
      surface.webview.html = renderHtml({ status, frame: page, nonce: nonce(), working });
      surface.shown = shown;
    } catch (error) {
      // A view disposed between the check above and this write: the page that
      // would have been written is gone with it, and the next poll redraws.
      this.notes.log(`could not write the view: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Hand the panel what it asked for: only the surface that asked hears it. */
  private tailnetPanel(surface: Surface, view: Record<string, unknown>): void {
    void surface.webview.postMessage({ type: "tailnet-state", view });
  }

  private async act(
    action: string,
    surface: Surface,
    url?: string,
    message?: { type?: string; url?: string; text?: string; index?: number; action?: string },
  ): Promise<void> {
    try {
      switch (action) {
        case "install":
          this.notes.log("install requested from the view");
          this.actions.install();
          return;
        case "docs":
          void vscode.env.openExternal(vscode.Uri.parse("https://nodecode.ai/docs"));
          return;
        case "start":
          await this.render(surface, "Starting the gateway…");
          await this.gateway.startGateway();
          await this.refresh();
          return;
        case "enable":
          await this.render(surface, "Turning the web cell on…");
          await this.gateway.enableWebCell();
          await this.refresh();
          return;
        case "tailnet":
          return this.tailnetPanel(surface, await this.tailnet.state());
        case "tailnet-act":
          return this.tailnetPanel(
            surface,
            await this.tailnet.act({ action: String(message?.action ?? ""), index: message?.index }),
          );
        case "tailnet-install":
          return this.tailnetPanel(surface, await this.tailnet.install());
        case "tailnet-copy":
          await vscode.env.clipboard.writeText(String(message?.text ?? ""));
          return;
        case "tailnet-open":
          if (message?.url) await vscode.env.openExternal(vscode.Uri.parse(String(message.url)));
          return;
        case "tailnet-switch": {
          if (!message?.url) return;
          surface.target = String(message.url);
          surface.shown = undefined;
          await this.render(surface);
          return;
        }
        case "switch": {
          // The page chose another organism: this surface shows that one from now
          // on, through a proxy of its own, and a poll keeps it there.
          if (!url) return;
          surface.target = url;
          surface.shown = undefined;
          await this.render(surface);
          return;
        }
        case "recheck":
        default:
          await this.refresh();
          return;
      }
    } catch (error) {
      this.notes.log(`action ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.refresh();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.panel?.dispose();
    this.panel = undefined;
    this.surfaces.clear();
  }
}

function nonce(): string {
  return crypto.randomBytes(18).toString("base64url");
}

/**
 * Tailnet access, drawn over the page rather than in a view of its own: the
 * mark sits in the corner of the frame, and the panel under it says what this
 * machine is serving, which code a new device types, and which machines on the
 * tailnet answered the handshake. Every action goes to the extension host,
 * which owns the operator token and the cell's install; nothing here holds a
 * secret or talks to Tailscale.
 */
export function tailnetScript(): string {
  return `(() => {
  const mark = document.getElementById('tailnet-mark');
  const panel = document.getElementById('tailnet-panel');
  const body = document.getElementById('tailnet-body');
  if (!mark || !panel || !body) return;
  // The shell above this already holds the one API object this webview gets:
  // asking for a second throws, and the panel would never draw.
  let view = null;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(label, act, extra) {
    const node = el('button', extra || '', label);
    node.dataset.tn = act;
    return node;
  }
  function copyButton(what, text) {
    const node = button('Copy', 'copy');
    node.dataset.what = what;
    node.dataset.text = text;
    return node;
  }

  function draw() {
    body.replaceChildren();
    if (!view) { body.append(el('p', 'why', 'Reading…')); return; }
    if (view.problem) {
      body.append(el('p', 'why', view.problem));
      if (view.installable) body.append(button('Install the tailnet access cell', 'install', 'primary'));
      return;
    }
    const state = view.state;
    if (!state) return;
    if (!state.available) {
      const advice = state.advice || {};
      body.append(el('p', 'why', advice.text || 'This machine cannot be reached over a tailnet yet.'));
      if (advice.step) body.append(el('p', 'why', advice.step));
      if (advice.url) { const go = button(advice.label || 'Open', 'open'); go.dataset.url = advice.url; body.append(go); }
      return;
    }

    const row = el('div', 'row');
    row.append(el('span', 'grow', 'This machine'));
    row.append(button(state.running ? 'Turn off' : 'Turn on', state.running ? 'stop' : 'start', state.running ? '' : 'primary'));
    body.append(row);

    if (state.running) {
      const addr = el('div', 'row');
      const link = el('span', 'addr grow', state.address || '');
      link.dataset.tn = 'open'; link.dataset.url = state.address || '';
      addr.append(link, copyButton('address', state.address || ''));
      body.append(addr);

      const code = el('div', 'row');
      if (state.code) {
        code.append(el('code', '', state.code), copyButton('code', state.code), button('New code', 'code'));
        body.append(code, el('p', 'why', 'expires in ' + state.codeMinutes + ' minutes'));
      } else {
        code.append(el('span', 'grow', 'No code standing.'), button('New code', 'code'));
        body.append(code);
      }
    }

    const machines = state.machines || [];
    if (machines.length > 1) {
      body.append(el('div', 'sep'));
      body.append(el('h2', '', 'Machines on your tailnet'));
      for (const machine of machines) {
        const line = el('div', 'row');
        line.append(el('span', 'grow', machine.name + (machine.current ? ' (this one)' : '')));
        if (!machine.current && machine.address) {
          const go = button('Switch', 'switch');
          go.dataset.url = machine.address;
          line.append(go);
        }
        body.append(line);
      }
    }

    for (const device of state.devices || []) {
      const line = el('div', 'row');
      line.append(el('span', 'grow', device.name + (device.login ? ' — ' + device.login : '')));
      const forget = button('Forget', 'forget');
      forget.dataset.index = String(device.index);
      line.append(forget);
      body.append(line);
    }
    if (state.refusal) body.append(el('p', 'why', state.refusal));
  }

  mark.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    mark.classList.toggle('on', !panel.hidden);
    if (!panel.hidden) api.postMessage({ type: 'tailnet' });
  });

  panel.addEventListener('click', (event) => {
    const target = event.target.closest('[data-tn]');
    if (!target) return;
    const act = target.dataset.tn;
    if (act === 'copy') return api.postMessage({ type: 'tailnet-copy', text: target.dataset.text || '' });
    if (act === 'switch') return api.postMessage({ type: 'tailnet-switch', url: target.dataset.url || '' });
    if (act === 'open') return api.postMessage({ type: 'tailnet-open', url: target.dataset.url || '' });
    if (act === 'install') {
      view = { problem: 'Installing the cell and restarting the gateway…' };
      draw();
      return api.postMessage({ type: 'tailnet-install' });
    }
    api.postMessage({
      type: 'tailnet-act',
      action: act,
      index: target.dataset.index === undefined ? undefined : Number(target.dataset.index),
    });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'tailnet-state') return;
    view = message.view;
    const live = !!(view && view.state && view.state.running);
    const dot = mark.querySelector('.dot');
    if (dot) dot.classList.toggle('live', live);
    draw();
  });
})();`;
}

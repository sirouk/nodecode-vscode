// The Remote Access panel: this home's organism, reached from the rest of the
// tailnet over https.
//
// The panel is a view of the nodecode-web-remote cell and nothing more. It
// reads `GET /api/remote` on the gateway this home runs, and drives the same
// route to turn remote access on and off, to mint a pairing code, and to forget
// a device. The cell does the work -- the loopback proxy, the pairing, the
// https port of its own that keeps 443 alone -- so nothing here talks to
// Tailscale and nothing here holds a secret of its own.

import * as vscode from "vscode";

import { GatewayEndpoint, NodecodeDiscovery, Notifications } from "./discovery";
import { NodecodeCli } from "./cli";
import { REMOTE_CELL, installBundledCell, nodecodeHome } from "./cells";

export interface RemoteDevice {
  index: number;
  name: string;
  login?: string;
}

export interface RemoteState {
  available: boolean;
  running: boolean;
  address?: string;
  httpsPort?: number;
  code?: string;
  codeMinutes?: number;
  devices: RemoteDevice[];
  refusal?: string;
  advice?: { reason?: string; text?: string; step?: string; label?: string; url?: string };
}

/** What a read of the route came to: the state, no cell, or a gateway that would not answer. */
export type RemoteRead =
  | { kind: "ok"; state: RemoteState }
  | { kind: "missing" }
  | { kind: "unreachable"; why: string };

type Fetch = typeof fetch;

function normalise(raw: Record<string, unknown>): RemoteState {
  const devices = Array.isArray(raw.devices) ? raw.devices : [];
  return {
    available: raw.available === true,
    running: raw.running === true,
    address: typeof raw.address === "string" ? raw.address : undefined,
    httpsPort: typeof raw.https_port === "number" ? (raw.https_port as number) : undefined,
    code: typeof raw.code === "string" ? raw.code : undefined,
    codeMinutes: typeof raw.code_minutes === "number" ? (raw.code_minutes as number) : undefined,
    devices: devices.map((device, at) => {
      const entry = device as Record<string, unknown>;
      return {
        index: typeof entry.index === "number" ? entry.index : at,
        name: typeof entry.name === "string" ? entry.name : "a device",
        login: typeof entry.login === "string" ? entry.login : undefined,
      };
    }),
    refusal: typeof raw.refusal === "string" ? raw.refusal : undefined,
    advice: raw.advice && typeof raw.advice === "object" ? (raw.advice as RemoteState["advice"]) : undefined,
  };
}

/** Read remote access from the gateway at ENDPOINT. */
export async function readRemote(endpoint: GatewayEndpoint, doFetch: Fetch = fetch): Promise<RemoteRead> {
  let response: Response;
  try {
    response = await doFetch(`${endpoint.baseUrl}/api/remote`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
    });
  } catch (error) {
    return { kind: "unreachable", why: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 404) return { kind: "missing" };
  if (!response.ok) return { kind: "unreachable", why: `the gateway answered ${response.status}` };
  try {
    return { kind: "ok", state: normalise((await response.json()) as Record<string, unknown>) };
  } catch {
    return { kind: "unreachable", why: "the gateway's answer was not JSON" };
  }
}

/** Act on remote access: start, stop, mint a code, forget a device. */
export async function actRemote(
  endpoint: GatewayEndpoint,
  body: { action: string; index?: number },
  doFetch: Fetch = fetch,
): Promise<RemoteRead> {
  let response: Response;
  try {
    response = await doFetch(`${endpoint.baseUrl}/api/remote`, {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { kind: "unreachable", why: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 404) return { kind: "missing" };
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const said = text.replace(/\s+/g, " ").slice(0, 200);
    return { kind: "unreachable", why: said || `the gateway answered ${response.status}` };
  }
  try {
    return { kind: "ok", state: normalise((await response.json()) as Record<string, unknown>) };
  } catch {
    return { kind: "unreachable", why: "the gateway's answer was not JSON" };
  }
}

/** The panel's page: a shell the extension host feeds state to. */
export function renderRemoteHtml(options: { nonce: string; cell: string }): string {
  const { nonce, cell } = options;
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
  body { margin: 0; padding: 10px 12px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .muted { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; margin: 6px 0 0; }
  .row { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--vscode-disabledForeground); }
  .dot.on { background: var(--vscode-testing-iconPassed, #3fb950); }
  .name { flex: 1 1 auto; }
  .field { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; }
  .addr { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-textLink-foreground); cursor: pointer; }
  .addr:hover { text-decoration: underline; }
  code { font-family: var(--vscode-editor-font-family); letter-spacing: .12em; }
  button { border: 0; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-textLink-foreground)); font: inherit; font-size: 11px; padding: 2px 6px; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .device { display: flex; align-items: center; gap: 8px; margin: 2px 0; font-size: 11px; }
  .device .who { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .device .login { color: var(--vscode-descriptionForeground); }
  .problem { border-left: 3px solid var(--vscode-inputValidation-errorBorder, #f85149); padding: 6px 8px; margin: 0 0 10px; font-size: 11px; line-height: 1.5; }
</style>
</head>
<body>
<div id="root"><p class="muted">Reading remote access…</p></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const CELL = ${JSON.stringify(cell)};
  let view = null;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(label, act, extra) {
    const node = el('button', extra || '', label);
    node.dataset.act = act;
    return node;
  }
  function copyRow(what, text) {
    const row = el('div', 'field');
    const b = button('Copy', 'copy');
    b.dataset.what = what;
    b.dataset.text = text;
    return { row, b };
  }

  function draw() {
    root.replaceChildren();
    if (!view) { root.append(el('p', 'muted', 'Reading remote access…')); return; }

    if (view.problem) {
      const box = el('div', 'problem');
      box.append(el('div', '', view.problem));
      if (view.installable) box.append(button('Install the remote access cell', 'install', 'primary'));
      root.append(box);
      return;
    }

    const state = view.state;
    if (!state) return;

    if (!state.available) {
      const advice = state.advice || {};
      root.append(el('p', 'muted', advice.text || 'This machine cannot be reached over a tailnet yet.'));
      if (advice.step) root.append(el('p', 'muted', advice.step));
      if (advice.url) {
        const go = button(advice.label || 'Open', 'open');
        go.dataset.url = advice.url;
        root.append(go);
      }
      return;
    }

    const toggle = el('div', 'row');
    const dot = el('span', state.running ? 'dot on' : 'dot');
    toggle.append(dot, el('span', 'name', 'Remote access'), button(state.running ? 'Turn off' : 'Turn on', state.running ? 'stop' : 'start', state.running ? '' : 'primary'));
    root.append(toggle);

    if (!state.running) {
      root.append(el('p', 'muted', 'Off. Nothing is served, and no device can reach this machine.'));
      return;
    }

    const addr = el('div', 'field');
    const link = el('span', 'addr', state.address || '');
    link.dataset.act = 'open';
    link.dataset.url = state.address || '';
    const copyAddr = button('Copy', 'copy');
    copyAddr.dataset.what = 'address';
    copyAddr.dataset.text = state.address || '';
    addr.append(link, copyAddr);
    root.append(addr);

    if (state.code) {
      const row = el('div', 'field');
      row.append(el('code', '', state.code));
      const copyCode = button('Copy', 'copy');
      copyCode.dataset.what = 'code';
      copyCode.dataset.text = state.code;
      row.append(copyCode, button('New code', 'code'));
      row.append(el('span', 'muted', 'expires in ' + state.codeMinutes + ' minutes'));
      root.append(row);
    } else {
      const row = el('div', 'field');
      row.append(el('span', 'muted', 'No code standing.'), button('New code', 'code'));
      root.append(row);
    }

    for (const device of state.devices) {
      const row = el('div', 'device');
      row.append(el('span', 'who', device.name), el('span', 'login', device.login || ''));
      const forget = button('Forget', 'forget');
      forget.dataset.index = String(device.index);
      row.append(forget);
      root.append(row);
    }

    if (state.refusal) root.append(el('p', 'muted', state.refusal));
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-act]');
    if (!target) return;
    const act = target.dataset.act;
    if (act === 'copy') {
      vscode.postMessage({ type: 'copy', text: target.dataset.text || '', what: target.dataset.what || '' });
      return;
    }
    if (act === 'open') {
      vscode.postMessage({ type: 'open', url: target.dataset.url || '' });
      return;
    }
    vscode.postMessage({
      type: 'act',
      action: act,
      index: target.dataset.index === undefined ? undefined : Number(target.dataset.index),
    });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'view') { view = message.view; draw(); }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

/** The view: what the route says, and the four things it can be told to do. */
export class RemoteView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly discovery: NodecodeDiscovery,
    private readonly cli: NodecodeCli,
    private readonly notes: Notifications,
    private readonly extensionPath: string,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = renderRemoteHtml({ nonce: nonce(), cell: REMOTE_CELL });
    view.webview.onDidReceiveMessage((message: Record<string, unknown>) => void this.handle(message));
  }

  /** Read the route again and hand the view what it says. */
  async refresh(): Promise<void> {
    if (!this.view) return;
    const endpoint = this.discovery.current();
    if (!endpoint) {
      this.post({ problem: "This home's gateway is not answering. Start it, then look again.", installable: false });
      return;
    }
    const read = await readRemote(endpoint);
    if (read.kind === "ok") this.post({ state: read.state });
    else if (read.kind === "missing")
      this.post({
        problem: `Remote access is the ${REMOTE_CELL} cell, and this home does not have it.`,
        installable: true,
      });
    else this.post({ problem: `Could not read remote access: ${read.why}`, installable: false });
  }

  private post(view: Record<string, unknown>): void {
    void this.view?.webview.postMessage({ type: "view", view });
  }

  private async handle(message: Record<string, unknown>): Promise<void> {
    const type = String(message.type || "");
    if (type === "ready") return this.refresh();
    if (type === "copy") {
      await vscode.env.clipboard.writeText(String(message.text || ""));
      return;
    }
    if (type === "open") {
      const url = String(message.url || "");
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    if (type === "install") return this.install();
    if (type !== "act") return;

    const endpoint = this.discovery.current();
    if (!endpoint) return this.refresh();
    const body: { action: string; index?: number } = { action: String(message.action || "") };
    if (typeof message.index === "number") body.index = message.index;
    const read = await actRemote(endpoint, body);
    if (read.kind === "ok") this.post({ state: read.state });
    else if (read.kind === "missing") this.post({ problem: `Remote access is the ${REMOTE_CELL} cell, which this home does not have.`, installable: true });
    else this.post({ problem: read.why, installable: false });
  }

  /**
   * Put the cell this extension carries into this home and have the gateway
   * load it. A home that already has the cell is left as it is: the hub's copy,
   * or an earlier install of this bundle, is the one that stays.
   */
  private async install(): Promise<void> {
    const home = nodecodeHome();
    let install;
    try {
      install = installBundledCell(this.extensionPath, home);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return this.post({ problem: `The cell could not be written to ${home}: ${why}`, installable: false });
    }
    this.notes.log(`remote: cell ${install.copied ? "installed" : "already present"} at ${install.path}`);
    const restarted = await this.cli.restartGateway();
    if (restarted.code !== 0) {
      this.notes.log(`remote: gateway restart failed: ${restarted.stderr.trim() || restarted.code}`);
    }
    await this.refresh();
  }
}

function nonce(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let text = "";
  for (let at = 0; at < 32; at += 1) text += alphabet[Math.floor(Math.random() * alphabet.length)];
  return text;
}

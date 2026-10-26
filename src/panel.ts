// The session webview: transcript, composer, queue and background-process
// controls. All markup/styles/client JS are inlined (no web assets); the
// script tag carries a per-load nonce.

import * as vscode from "vscode";
import { Notifications } from "./discovery";
import { SessionController } from "./manager";
import { StoreView } from "./store";
import { ConnectionState } from "./protocol";

export interface PanelCallbacks {
  forkSession(sessionId: string): void;
  renameSession(sessionId: string): void;
  exportSession(sessionId: string): void;
  revealTerminal(sessionId: string): void;
  deleteSession(sessionId: string): void;
  showCheckpointHistory(sessionId: string, controller: SessionController): void;
  pickModel(sessionId: string, controller: SessionController): void;
  pickEffort(sessionId: string, controller: SessionController): void;
  revealSessionsView(): void;
}

export class SessionPanel {
  static readonly viewType = "nodecode.session";
  private static readonly panels = new Map<string, SessionPanel>();

  static createOrShow(
    extensionUri: vscode.Uri,
    controller: SessionController,
    callbacks: PanelCallbacks,
    notes: Notifications,
  ): void {
    const existing = SessionPanel.panels.get(controller.sessionId);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const label = controller.store.view().title;
    const panel = vscode.window.createWebviewPanel(
      SessionPanel.viewType,
      label ? `Nodecode: ${label}` : `Nodecode ${controller.sessionId}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    new SessionPanel(panel, extensionUri, controller, callbacks, notes);
  }

  static get(sessionId: string): SessionPanel | undefined {
    return SessionPanel.panels.get(sessionId);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private connection: ConnectionState = "connecting";
  private connectionAttempts = 0;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly controller: SessionController,
    private readonly callbacks: PanelCallbacks,
    private readonly notes: Notifications,
  ) {
    void extensionUri;
    SessionPanel.panels.set(controller.sessionId, this);
    panel.webview.html = this.html();

    controller.store.onDidChange = () => this.postState();
    controller.onConnectionChanged = (state, attempts) => {
      this.connection = state;
      this.connectionAttempts = attempts;
      this.postState();
    };

    this.disposables.push(
      panel.onDidDispose(() => {
        SessionPanel.panels.delete(controller.sessionId);
        controller.dispose();
        this.disposables.forEach((d) => d.dispose());
      }),
      panel.webview.onDidReceiveMessage((message) => void this.onMessage(message)),
      panel.onDidChangeViewState(() => {
        if (panel.visible) this.postState();
      }),
    );
    this.postState();
  }

  private postState(): void {
    const view = this.controller.store.view();
    const title = view.title;
    if (title) this.panel.title = `Nodecode: ${title}`;
    void this.panel.webview.postMessage({
      type: "state",
      view,
      connection: this.connection,
      attempts: this.connectionAttempts,
      history: this.controller.store.userPrompts(),
    });
  }

  private async onMessage(message: { type?: string; [key: string]: unknown }): Promise<void> {
    const id = this.controller.sessionId;
    try {
      switch (message.type) {
        case "send": {
          const text = typeof message.text === "string" ? message.text.trim() : "";
          if (!text) return;
          if (message.mode === "steer" && typeof message.turnId === "string") {
            this.controller.steer(message.turnId, text);
          } else {
            this.controller.sendPrompt(text);
          }
          return;
        }
        case "withdraw":
          if (typeof message.promptId === "string") this.controller.withdraw(message.promptId);
          return;
        case "cancel":
          this.controller.cancelActive(typeof message.turnId === "string" ? message.turnId : undefined);
          return;
        case "interrupt":
          if (typeof message.execId !== "undefined") this.controller.interruptExec(message.execId as string | number);
          return;
        case "navigateUndo":
          await this.controller.navigateCheckpoint({ direction: "undo", restoreFiles: true });
          return;
        case "navigateRedo":
          await this.controller.navigateCheckpoint({ direction: "redo", restoreFiles: true });
          return;
        case "checkpointHistory":
          this.callbacks.showCheckpointHistory(id, this.controller);
          return;
        case "fork":
          this.callbacks.forkSession(id);
          return;
        case "rename":
          this.callbacks.renameSession(id);
          return;
        case "export":
          this.callbacks.exportSession(id);
          return;
        case "revealTerminal":
          this.callbacks.revealTerminal(id);
          return;
        case "delete":
          this.callbacks.deleteSession(id);
          return;
        case "pickModel":
          this.callbacks.pickModel(id, this.controller);
          return;
        case "pickEffort":
          this.callbacks.pickEffort(id, this.controller);
          return;
        case "revealSessions":
          this.callbacks.revealSessionsView();
          return;
        case "refresh":
          this.controller.refreshHeader();
          this.controller.refreshTarget();
          return;
        default:
          return;
      }
    } catch (error) {
      this.notes.log(`panel message ${String(message.type)} failed: ${String(error)}`);
      void vscode.window.showWarningMessage(`Nodecode: ${String(error)}`);
    }
  }

  private html(): string {
    const nonce = String(Math.floor(Math.random() * 1e15));
    return [
      "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\">",
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src https: http://127.0.0.1:* data:">`,
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">",
      `<style>${PANEL_CSS}</style></head><body>${PANEL_BODY}`,
      `<script nonce="${nonce}">${CLIENT_JS}</script>`,
      "</body></html>",
    ].join("\n");
  }
}

const PANEL_CSS = `
:root{--bg:var(--vscode-editor-background,#1e1e1e);--fg:var(--vscode-editor-foreground,#d4d4d4);--dim:var(--vscode-descriptionForeground,#8b8b8b);--border:var(--vscode-panel-border,#3c3c3c);--accent:var(--vscode-button-background,#0e639c);--accentfg:var(--vscode-button-foreground,#fff);--user:var(--vscode-inputValidation-infoBackground,#253048);--err:var(--vscode-errorForeground,#f48771);--warn:var(--vscode-editorWarning-foreground,#cca700);--ok:var(--vscode-testing-iconPassed,#73c991)}
*{box-sizing:border-box}
html,body{height:100%;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font-family:var(--vscode-font-family,sans-serif);font-size:var(--vscode-font-size,13px)}
#app{display:flex;flex-direction:column;height:100vh}
header#topbar{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);flex:0 0 auto}
.grow{flex:1 1 auto;min-width:0}
.title{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub{color:var(--dim);font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btns{flex:0 0 auto;display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
button{background:transparent;color:var(--fg);border:1px solid var(--border);border-radius:4px;padding:3px 8px;cursor:pointer;font-size:12px;line-height:1.4}
button:hover{background:var(--accent);color:var(--accentfg);border-color:var(--accent)}
button.danger:hover{background:var(--err);border-color:var(--err)}
button.primary{background:var(--accent);color:var(--accentfg);border-color:var(--accent)}
.hidden{display:none !important}
#procBar,#queueBar{display:flex;flex-wrap:wrap;gap:6px;padding:4px 10px}
#procBar:empty,#queueBar:empty{display:none;padding:0}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:10px;padding:2px 8px;font-size:11px;color:var(--dim);max-width:100%}
.chip .cmd{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px;color:var(--fg)}
.chip button{padding:0 6px;font-size:11px;border:none}
#scroll{flex:1 1 auto;overflow-y:auto;padding:12px 14px}
#transcript{max-width:900px;margin:0 auto}
.msg{margin:0 0 14px 0;display:flex}
.msg.user{justify-content:flex-end}
.bubble{max-width:82%;border:1px solid var(--border);border-radius:8px;padding:8px 12px;overflow-wrap:anywhere}
.msg.user .bubble{background:var(--user)}
.msg.assistant .bubble{background:transparent;border-color:transparent;padding-left:0;max-width:100%}
.msg p{margin:6px 0}
.msg p:first-child{margin-top:0}.msg p:last-child{margin-bottom:0}
pre.code,pre.tool-io{background:var(--vscode-textCodeBlock-background,#111);border:1px solid var(--border);border-radius:6px;padding:8px 10px;overflow-x:auto;font-family:var(--vscode-editor-font-family,monospace);font-size:12px}
code.inline{background:var(--vscode-textCodeBlock-background,#111);border-radius:3px;padding:1px 4px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px}
strong.h{font-size:14px}.li{margin:2px 0 2px 8px}
.reasoning{color:var(--dim);border-left:2px solid var(--border);margin:4px 0}
.reasoning summary{cursor:pointer;color:var(--dim);font-style:italic;padding:2px 0 2px 8px}
.reasoning .rbody{padding:2px 0 6px 10px;white-space:pre-wrap}
.caret{display:inline-block;width:8px;height:14px;background:var(--fg);opacity:.7;animation:blink 1s steps(1) infinite;vertical-align:text-bottom}
@keyframes blink{50%{opacity:0}}
.tool{border:1px solid var(--border);border-radius:8px;margin:6px 0;overflow:hidden}
.tool-head{padding:6px 10px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;border-bottom:1px solid var(--border);background:var(--vscode-sideBar-background,rgba(127,127,127,.06))}
.tool-head.running{color:var(--warn)}.tool-head.done{color:var(--ok)}.tool-head.failed{color:var(--err)}
.tool-sec{padding:6px 10px}
.tool-label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin-bottom:4px}
.tool-sec pre{margin:0;max-height:320px;overflow:auto}
.sys{color:var(--dim);font-size:11px;text-align:center;margin:10px 0}
.sys.warn{color:var(--warn)}.sys.error{color:var(--err)}
#statusLine{flex:0 0 auto;color:var(--dim);font-size:11px;padding:4px 12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;gap:10px}
#statusLine:empty{display:none;padding:0;border:none}
footer#composerBar{flex:0 0 auto;display:flex;gap:6px;padding:8px 10px;border-top:1px solid var(--border);align-items:flex-end}
#composer{flex:1 1 auto;resize:none;background:var(--vscode-input-background,#252526);color:var(--vscode-input-foreground,var(--fg));border:1px solid var(--vscode-input-border,var(--border));border-radius:6px;padding:8px 10px;font:inherit;max-height:180px;overflow-y:auto}
#composer:focus{outline:1px solid var(--accent)}
button.mode.steering{background:var(--warn);color:#000;border-color:var(--warn)}
a{color:var(--vscode-textLink-foreground,#3794ff)}
`;

const PANEL_BODY = `
<div id="app">
  <header id="topbar">
    <div class="grow">
      <div id="title" class="title">Nodecode</div>
      <div id="modelLine" class="sub"></div>
    </div>
    <div class="btns">
      <button id="sessBtn" title="Sessions view">&#9776;</button>
      <button id="termBtn" title="Reveal terminal">&gt;_</button>
      <button id="forkBtn" title="Fork session">&#9088;</button>
      <button id="undoBtn" title="Undo last turn (checkpoint)">&#8630;</button>
      <button id="redoBtn" title="Redo (checkpoint)">&#8631;</button>
      <button id="histBtn" title="Checkpoint history">&#9719;</button>
      <button id="modelBtn" title="Choose model">&#9671;</button>
      <button id="effortBtn" title="Choose effort">&#9881;</button>
      <button id="renameBtn" title="Rename session">&#9998;</button>
      <button id="exportBtn" title="Export history (JSONL)">&#8681;</button>
      <button id="refreshBtn" title="Refresh">&#10227;</button>
      <button id="delBtn" title="Delete session" class="danger">&#10005;</button>
    </div>
  </header>
  <div id="procBar"></div>
  <div id="scroll"><div id="transcript"></div></div>
  <div id="queueBar"></div>
  <div id="statusLine"></div>
  <footer id="composerBar">
    <textarea id="composer" rows="1" placeholder="Message Nodecode&#8230; (Enter to send, Shift+Enter for a newline)"></textarea>
    <button id="steerBtn" class="mode hidden" title="Next message steers the active turn">&#8626; steer</button>
    <button id="cancelBtn" class="hidden" title="Cancel the active turn">&#9632;</button>
    <button id="sendBtn" class="primary" title="Send">&#10148;</button>
  </footer>
</div>
`;

const CLIENT_JS = `
(function(){
  var vscode = acquireVsCodeApi();
  var state = { view: null, connection: 'connecting', attempts: 0, history: [] };
  var steerMode = false;
  var histIdx = -1;
  function E(id){ return document.getElementById(id); }
  var transcript = E('transcript'), scrollBox = E('scroll'), composer = E('composer'),
      sendBtn = E('sendBtn'), cancelBtn = E('cancelBtn'), steerBtn = E('steerBtn'),
      statusLine = E('statusLine'), titleEl = E('title'), modelEl = E('modelLine'),
      queueBar = E('queueBar'), procBar = E('procBar');
  window.addEventListener('message', function(ev){
    var m = ev.data;
    if (!m || m.type !== 'state') return;
    var wasNearBottom = nearBottom();
    state = m;
    renderAll(wasNearBottom);
  });
  function nearBottom(){
    return scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight < 120;
  }
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  function md(src){
    var s = esc(src == null ? '' : src);
    var blocks = [];
    s = s.replace(/\`\`\`(\w*)\n?([\s\S]*?)(\`\`\`|$)/g, function(_, lang, code){
      blocks.push('<pre class="code"><code>' + code.replace(/\n$/, '') + '</code></pre>');
      return '\u0001' + (blocks.length - 1) + '\u0002';
    });
    s = s.replace(/\`([^\`\n]+)\`/g, '<code class="inline">$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|\s)\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
    s = s.replace(/^####?#? (.+)$/gm, '<strong class="h">$1</strong>');
    s = s.replace(/^[-*] (.+)$/gm, '<div class="li">&#8226; $1</div>');
    var out = s.split(/\n{2,}/).map(function(p){
      return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('');
    return out.replace(/\u0001(\d+)\u0002/g, function(_, i){ return blocks[+i]; });
  }
  function truncate(s, n){
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '\n...(' + (s.length - n) + ' more chars)' : s;
  }

  function toolHtml(call){
    var status = call.done ? (call.failed ? 'failed' : 'done') : 'running';
    var head = '<div class="tool-head ' + status + '">' + (status === 'running' ? '&#9711;' : '&#9679;') + ' ' + esc(call.name) + (call.durationMs != null ? ' &middot; ' + call.durationMs + 'ms' : '') + '</div>';
    var body = '';
    if (call.arguments) body += '<div class="tool-sec"><div class="tool-label">call</div><pre class="tool-io">' + esc(truncate(call.arguments, 2000)) + '</pre></div>';
    if (call.result) body += '<div class="tool-sec"><div class="tool-label">result' + (call.failed ? ' (failed)' : '') + '</div><pre class="tool-io">' + esc(truncate(call.result, 4000)) + '</pre></div>';
    return '<div class="tool">' + head + body + '</div>';
  }
  function partHtml(part){
    if (part.kind === 'user') {
      return '<div class="msg user"><div class="bubble">' + md(part.text) + '</div></div>';
    }
    if (part.kind === 'assistant') {
      var r = part.reasoning ? '<details class="reasoning"><summary>reasoning&hellip;</summary><div class="rbody">' + esc(part.reasoning) + '</div></details>' : '';
      var caret = part.streaming ? '<span class="caret"></span>' : '';
      var body = (part.text ? md(part.text) : '') + caret;
      if (!part.text && part.reasoning && part.streaming) body = r ? '<span class="sub">thinking&hellip;</span>' + caret : caret;
      return '<div class="msg assistant"><div class="bubble">' + r + body + '</div></div>';
    }
    if (part.kind === 'tool') return toolHtml(part.call);
    if (part.kind === 'system') return '<div class="sys ' + esc(part.level || 'info') + '">' + esc(part.text) + '</div>';
    return '';
  }
  function chip(label, action, payload, actionLabel){
    return '<span class="chip"><span class="cmd">' + esc(label) + '</span><button data-a="' + action + '" data-p="' + esc(payload) + '">' + actionLabel + '</button></span>';
  }
  function renderAll(stick){
    var view = state.view || {};
    var parts = view.parts || [];
    titleEl.textContent = view.title || (view.sessionId ? 'Nodecode ' + view.sessionId : 'Nodecode');
    var line = [];
    if (view.provider || view.model) line.push([view.provider, view.model].filter(Boolean).join('/'));
    if (view.effort) line.push('effort ' + view.effort);
    if (state.connection !== 'connected') line.push(state.connection === 'failed' ? 'connection failed' : 'reconnecting (' + state.attempts + ')');
    else line.push('connected');
    modelEl.textContent = line.join(' · ');
    transcript.innerHTML = parts.map(partHtml).join('') || '<div class="sys">No messages yet. Say something below.</div>';
    var q = view.queue || [];
    queueBar.innerHTML = q.map(function(p){
      var label = (p.content || p.prompt_id || '').slice(0, 120);
      return chip(label, 'withdraw', p.prompt_id, '&#10005; withdraw');
    }).join('');
    var procs = view.processes || [];
    procBar.innerHTML = procs.map(function(p){
      var running = /run|start|exec|poll|wait/i.test(String(p.status || '')) && !/not|stop|exit|done|fail/i.test(String(p.status || ''));
      var label = p.command + ' [' + p.status + ']';
      return running && p.execId != null ? chip(label, 'interrupt', String(p.execId), '&#9632; interrupt')
        : '<span class="chip"><span class="cmd">' + esc(label) + '</span></span>';
    }).join('');
    var sline = [];
    if (view.running) sline.push('Working…');
    if (view.activeTurnId) sline.push('turn ' + view.activeTurnId);
    var t = view.totals || {};
    if (t.costKnown) sline.push('$' + (t.costUsd || 0).toFixed(4));
    if (t.output) sline.push((t.output || 0) + ' out / ctx ' + (t.input || 0));
    statusLine.textContent = sline.join('  ·  ');
    var steerable = view.activeTurnSteerable && view.activeTurnId;
    steerBtn.className = steerable ? ('mode' + (steerMode ? ' steering' : '')) : 'mode hidden';
    cancelBtn.className = view.running ? '' : 'hidden';
    if (!steerable) steerMode = false;
    if (stick) scrollBox.scrollTop = scrollBox.scrollHeight;
  }

  function send(){
    var text = composer.value.trim();
    if (!text) return;
    var view = state.view || {};
    var msg = { type: 'send', text: text };
    if (steerMode && view.activeTurnSteerable && view.activeTurnId) {
      msg.mode = 'steer';
      msg.turnId = view.activeTurnId;
    }
    composer.value = '';
    grow();
    histIdx = -1;
    steerMode = false;
    vscode.postMessage(msg);
  }
  function grow(){
    composer.style.height = 'auto';
    composer.style.height = Math.min(180, composer.scrollHeight) + 'px';
  }
  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', function(){ vscode.postMessage({ type: 'cancel' }); });
  steerBtn.addEventListener('click', function(){ steerMode = !steerMode; renderAll(nearBottom()); composer.focus(); });
  composer.addEventListener('input', grow);
  composer.addEventListener('keydown', function(ev){
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); return; }
    if (ev.key === 'ArrowUp' && composer.value === '') {
      var h = state.history || [];
      if (!h.length) return;
      ev.preventDefault();
      histIdx = histIdx < 0 ? h.length - 1 : Math.max(0, histIdx - 1);
      composer.value = h[histIdx];
      grow();
    } else if (ev.key === 'ArrowDown' && histIdx >= 0) {
      ev.preventDefault();
      histIdx += 1;
      var hh = state.history || [];
      if (histIdx >= hh.length) { histIdx = -1; composer.value = ''; }
      else composer.value = hh[histIdx];
      grow();
    }
  });
  document.body.addEventListener('click', function(ev){
    var el = ev.target;
    if (!el || !el.getAttribute) return;
    var action = el.getAttribute('data-a');
    if (!action) return;
    var payload = el.getAttribute('data-p');
    if (action === 'withdraw') vscode.postMessage({ type: 'withdraw', promptId: payload });
    else if (action === 'interrupt') vscode.postMessage({ type: 'interrupt', execId: payload });
  });
  function wire(id, msg){
    E(id).addEventListener('click', function(){ vscode.postMessage({ type: msg }); });
  }
  wire('sessBtn', 'revealSessions');
  wire('termBtn', 'revealTerminal');
  wire('forkBtn', 'fork');
  wire('undoBtn', 'navigateUndo');
  wire('redoBtn', 'navigateRedo');
  wire('histBtn', 'checkpointHistory');
  wire('modelBtn', 'pickModel');
  wire('effortBtn', 'pickEffort');
  wire('renameBtn', 'rename');
  wire('exportBtn', 'export');
  wire('refreshBtn', 'refresh');
  wire('delBtn', 'delete');
  grow();
  composer.focus();
})();
`;

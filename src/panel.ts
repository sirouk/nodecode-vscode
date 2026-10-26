// The session webview: transcript, composer, queue and background-process
// controls. All markup/styles/client JS are inlined (no web assets); the
// script tag carries a per-load nonce.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { INLINE_REFERENCE_JS } from "./inline-references";
import { ATTACHMENT_MENU, ATTACHMENT_CSS, ATTACHMENT_CLIENT_JS } from "./attachment-controls";
import { MODEL_CLIENT_JS } from "./model-controls";
import { HISTORY_MODES, HISTORY_CSS, HISTORY_TREE_JS } from "./history-controls";
import { RUNTIME_MARKUP, RUNTIME_CLIENT_JS } from "./runtime-controls";
import { SLASH_MARKUP, SLASH_CLIENT_JS } from "./slash-controls";
import { ACTIVITY_CSS, ACTIVITY_CLIENT_JS } from "./activity-controls";
import { Notifications } from "./discovery";
import { SessionController } from "./manager";
import { StoreView } from "./store";
import { ConnectionState, ImageAttachment } from "./protocol";

export interface ModelFavorite { provider: string; model: string }
export interface ModelOptions {
  models: import("./api").ModelRow[];
  auxiliary?: import("./api").AuxiliaryModel;
  decider?: import("./api").DeciderModel;
  failover?: import("./api").FailoverState;
  target: import("./api").GatewayTarget;
  favorites: ModelFavorite[];
  context?: { used?: number; limit?: number };
}

export interface PanelCallbacks {
  pickLocalAttachments(): Promise<import("./file-browser").SelectedFileInput[]>;
  runtimeMetadata(): Promise<{version:string;releaseUrl:string;releaseTag?:string;releasePublishedAt?:string;binaryUpdatedAt?:string}>;
  runtimeStatus(): Promise<import("./cli").RuntimeStatus>;
  retryRuntime(): Promise<import("./cli").RuntimeStatus>;
  restartRuntime(): Promise<import("./cli").RuntimeStatus>;
  installRuntime(): void;
  selectAuxiliary(provider: string | null, model: string | null, effort?: string | null): Promise<import("./api").AuxiliaryModel>;
  selectDecider(provider: string | null, model?: string | null): Promise<import("./api").DeciderModel>;
  updateBackups(update: {chain?: Array<{provider:string;model:string}>;on?:string[]}): Promise<import("./api").FailoverState>;
  testBackups(): Promise<{results:Array<{provider:string;model:string;ok:boolean;reason:string|null;seconds:number}>}>;
  newSession(): void;
  listSessions(query?: string): Promise<import("./api").SessionRow[]>;
  modelOptions(sessionId: string): Promise<ModelOptions>;
  selectModel(sessionId: string, provider: string, model: string): Promise<void | string>;
  selectEffort(sessionId: string, effort: string): Promise<void>;
  favoriteModel(provider: string, model: string, starred: boolean): Promise<ModelFavorite[]>;
  searchFiles(query: string): Promise<Array<{ path: string; isDir: false }>>;
  openInEditor(sessionId: string): void;
  openSession(sessionId: string): void;
  forkSession(sessionId: string): void;
  forkAtMessage(sessionId:string,turnId:string):Promise<void>;
  toggleCheckpointBookmark(sessionId:string,turnId:string):Promise<string[]>;
  renameSession(sessionId: string, name?: string): void | Promise<void | string>;
  exportSession(sessionId: string): void;
  revealTerminal(sessionId: string): void;
  deleteSession(sessionId: string): void | Promise<void>;
  showCheckpointHistory(sessionId: string, controller: SessionController): void;
  pickModel(sessionId: string, controller: SessionController): void;
  pickEffort(sessionId: string, controller: SessionController): void;
  revealSessionsView(): void;
}

export class SessionPanel {
  static readonly viewType = "nodecode.session";
  private static readonly panels = new Map<string, SessionPanel>();
  private static readonly instances = new Set<SessionPanel>();

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
    return SessionPanel.panels.get(sessionId) ?? [...SessionPanel.instances].find((entry) => entry.controller.sessionId === sessionId);
  }

  showHistory(): void {
    if (this.ready) this.postMessage({type:"showSessions"});
    else this.pendingHistory = true;
  }

  static closeSessions(sessionIds: string[]): void {
    const deleted = new Set(sessionIds);
    for (const entry of [...SessionPanel.instances]) {
      if (!entry.sidebar && deleted.has(entry.controller.sessionId)) entry.panel.dispose();
    }
  }

  static active(): SessionPanel | undefined {
    return [...SessionPanel.instances].find((entry) => entry.panel.active)
      ?? [...SessionPanel.instances].find((entry) => entry.panel.visible)
      ?? [...SessionPanel.instances].at(-1);
  }

  addContext(text: string): void {
    this.panel.reveal(vscode.ViewColumn.Active);
    if (this.ready) this.postMessage({ type: "addContext", text });
    else this.pendingContext.push(text);
  }

  static forSidebar(view: vscode.WebviewView, extensionUri: vscode.Uri, controller: SessionController,
    callbacks: PanelCallbacks, notes: Notifications): SessionPanel {
    const surface = {
      webview: view.webview,
      get title() { return view.title ?? "Nodecode"; },
      set title(value: string) { view.title = value; },
      get visible() { return view.visible; },
      get active() { return false; },
      reveal() { view.show(true); },
      onDidDispose: view.onDidDispose.bind(view),
      onDidChangeViewState: (listener: () => void) => view.onDidChangeVisibility(listener),
    } as unknown as vscode.WebviewPanel;
    return new SessionPanel(surface, extensionUri, controller, callbacks, notes, true);
  }

  dispose(): void {
    this.disposed = true;
    this.controller.closeTextAttachments(this.attachmentSource);
    SessionPanel.instances.delete(this);
    if (SessionPanel.panels.get(this.controller.sessionId) === this) SessionPanel.panels.delete(this.controller.sessionId);
    this.disposables.splice(0).forEach((entry) => entry.dispose());
  }

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private readonly attachmentSource = {};
  private connection: ConnectionState = "connecting";
  private connectionAttempts = 0;
  private readonly markUri: string;
  private readonly markdownUri: string;
  private ready = false;
  private pendingContext: string[] = [];
  private pendingHistory = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly controller: SessionController,
    private readonly callbacks: PanelCallbacks,
    private readonly notes: Notifications,
    private readonly sidebar = false,
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
    this.markdownUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "out", "markdown.js")).toString();
    this.markUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "icon.svg")).toString();
    this.connection = controller.rpc.connectionState;
    this.connectionAttempts = controller.rpc.attempts;
    SessionPanel.instances.add(this);
    if (!sidebar) SessionPanel.panels.set(controller.sessionId, this);
    panel.webview.html = this.html();

    this.disposables.push(controller.store.subscribe(() => this.postState()));
    this.disposables.push(controller.subscribeConnection((state, attempts) => {
      this.connection = state;
      this.connectionAttempts = attempts;
      this.postState();
    }));

    this.disposables.push(
      panel.onDidDispose(() => {
        this.dispose();
      }),
      panel.webview.onDidReceiveMessage((message) => void this.onMessage(message)),
      panel.onDidChangeViewState(() => {
        if (panel.visible) this.postState();
      }),
    );
    this.postState();
  }

  private postMessage(message: unknown): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  private toolImageUrl(call: { metadata?: Record<string, unknown>; result?: string }, cwd: string): string | undefined {
    const image = call.metadata?.image as Record<string, unknown> | undefined;
    if (!image || typeof image !== "object") return undefined;
    const text = call.result?.trim() ?? "";
    const base64 = text.replace(/^data:image\/png[^,]*;base64[^,]*,/, "");
    if (text.length <= 8 * 1024 * 1024 && /^[A-Za-z0-9+/=]{8,}$/.test(base64)) return `data:image/png;base64,${base64}`;
    const file = typeof image.png_path === "string" ? image.png_path : image.path;
    if (!cwd || typeof file !== "string" || !/\.(png|jpe?g|gif|webp)$/i.test(file)) return undefined;
    try {
      const root = fs.realpathSync(cwd);
      const resolved = fs.realpathSync(path.resolve(cwd, file));
      const relative = path.relative(root, resolved);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
      const roots = (this.panel.webview.options ?? {}).localResourceRoots ?? [];
      if (!roots.some((uri) => uri.fsPath === root)) this.panel.webview.options = { ...this.panel.webview.options, localResourceRoots: [...roots, vscode.Uri.file(root)] };
      return this.panel.webview.asWebviewUri(vscode.Uri.file(resolved)).toString();
    } catch { return undefined; }
  }

  private postState(): void {
    if (this.disposed) return;
    const view = this.controller.store.view();
    const title = view.title;
    if (title && !this.sidebar) this.panel.title = `Nodecode: ${title}`;
    this.postMessage({
      type: "state",
      view: { ...view, parts: view.parts.map((part) => part.kind === "tool" ? { ...part, call: { ...part.call, imageUrl: this.toolImageUrl(part.call, view.cwd) } } : (part.kind === "user" || part.kind === "assistant") && part.images?.length ? { ...part, images: part.images.map((image) => ({ ...image, url: this.controller.imageUrl(image.id) })) } : part) },
      connection: this.connection,
      attempts: this.connectionAttempts,
      history: this.controller.store.userPrompts(),
    });
  }

  private async onMessage(message: { type?: string; [key: string]: unknown }): Promise<void> {
    if (this.disposed) return;
    const id = this.controller.sessionId;
    try {
      switch (message.type) {
        case "runtimeMetadata":
          this.postMessage({type:"runtimeMetadata",data:await this.callbacks.runtimeMetadata(),requestId:message.requestId});return;
        case "runtimeStatus":
        case "retryRuntime":
        case "restartRuntime": {
          const status=await this.callbacks[message.type]();
          this.postMessage({type:"runtimeStatus",status,requestId:message.requestId});
          return;
        }
        case "installRuntime":
          this.callbacks.installRuntime();
          return;
        case "slashCatalog":
          this.postMessage({type:"slashCatalog",requestId:message.requestId,commands:await this.controller.slashCommands()});
          return;
        case "slashCompletions":
          if(typeof message.name==='string'&&typeof message.text==='string')this.postMessage({type:"slashCompletions",requestId:message.requestId,choices:await this.controller.slashCompletions(message.name,message.text)});
          return;
        case "slashCheckpoint": {
          if(message.direction!=="undo"&&message.direction!=="redo")return;
          const result=await this.controller.navigateCheckpoint({direction:message.direction,restoreFiles:true});
          if(!result||result.status==="rejected")throw new Error(result?.message||"Checkpoint change was not accepted");
          this.postMessage({type:"slashResult",line:message.line,result:{text:result.message||"Checkpoint restored."}});
          return;
        }
        case "runSlash":
          if(typeof message.line==='string')this.postMessage({type:"slashResult",line:message.line,result:await this.controller.runSlash(message.line)});
          return;
        case "stageTextChunk": {
          const result = await this.controller.stageTextAttachmentChunk(message as unknown as import("./text-attachments").TextAttachmentChunk, this.attachmentSource);
          this.postMessage({type:"textAttachmentChunk",...result});
          return;
        }
        case "cancelTextAttachment":
          if(typeof message.requestId === "number") this.controller.cancelTextAttachment(message.requestId,this.attachmentSource);
          return;
        case "releaseTextAttachment":
          if(typeof message.ref === "string") this.controller.releaseTextAttachment(message.ref,this.attachmentSource);
          return;
        case "openTextAttachment":
          if(typeof message.ref === "string") {
            const file=await this.controller.openTextAttachment(message.ref,this.attachmentSource);
            const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            await vscode.window.showTextDocument(document,{preview:true});
          }
          return;
        case "browseRuntimeFiles": {
          const result=await this.controller.browseRuntimeFiles(message.options as {path?:string;query?:string;offset?:number;showHidden?:boolean},this.attachmentSource);
          this.postMessage({type:"runtimeFiles",result,requestId:message.requestId});return;
        }
        case "attachRuntimeFiles": {
          if(!Array.isArray(message.paths)||message.paths.some(path=>typeof path!=="string"))throw new Error("Invalid file selection");
          const result=await this.controller.attachRuntimeFiles(message.paths as string[],this.attachmentSource);
          this.postMessage({type:"attachmentsSelected",result,requestId:message.requestId});return;
        }
        case "attachComputerFiles": {
          const selected=await this.callbacks.pickLocalAttachments();
          if(this.disposed)return;
          const result=await this.controller.attachSelectedFiles(selected,this.attachmentSource,"computer");
          this.postMessage({type:"attachmentsSelected",result,requestId:message.requestId});return;
        }
        case "modelOptions": {
          const options = await this.callbacks.modelOptions(id);
          this.postMessage({type:"modelOptions",requestId:message.requestId,...options});
          return;
        }
        case "selectAuxiliary": {
          if (message.provider != null && typeof message.provider !== "string" || message.model != null && typeof message.model !== "string" || message.effort != null && typeof message.effort !== "string") throw new Error("Invalid auxiliary selection");
          const data = await this.callbacks.selectAuxiliary(message.provider as string | null ?? null,message.model as string | null ?? null,message.effort as string | null | undefined);
          this.postMessage({type:"roleApplied",role:"aux",data,requestId:message.requestId});return;
        }
        case "selectDecider": {
          if (message.provider != null && typeof message.provider !== "string" || message.model != null && typeof message.model !== "string") throw new Error("Invalid decider selection");
          const data = await this.callbacks.selectDecider(message.provider as string | null ?? null,message.model as string | null | undefined);
          this.postMessage({type:"roleApplied",role:"decider",data,requestId:message.requestId});return;
        }
        case "updateBackups": {
          const update=message.update as {chain?:Array<{provider:string;model:string}>;on?:string[]};
          if (!update || typeof update !== "object" || update.chain !== undefined && (!Array.isArray(update.chain) || update.chain.some(row=>!row||typeof row.provider!=="string"||typeof row.model!=="string")) || update.on !== undefined && (!Array.isArray(update.on)||update.on.some(id=>typeof id!=="string"))) throw new Error("Invalid backup configuration");
          const data = await this.callbacks.updateBackups(update);
          this.postMessage({type:"roleApplied",role:"backup",data,requestId:message.requestId});return;
        }
        case "testBackups": {
          const data = await this.callbacks.testBackups();
          this.postMessage({type:"backupTested",data,requestId:message.requestId});return;
        }
        case "selectModel":
          if (typeof message.provider === "string" && typeof message.model === "string") {
            const warning = await this.callbacks.selectModel(id,message.provider,message.model);
            this.controller.refreshTarget();
            this.postMessage({type:"optionApplied",warning,requestId:message.requestId});
          }
          return;
        case "selectEffort":
          if (typeof message.effort === "string") {
            await this.callbacks.selectEffort(id,message.effort);
            this.controller.refreshTarget();
            this.postMessage({type:"optionApplied",requestId:message.requestId});
          }
          return;
        case "favoriteModel":
          if (typeof message.provider === "string" && typeof message.model === "string" && typeof message.starred === "boolean") {
            const favorites = await this.callbacks.favoriteModel(message.provider,message.model,message.starred);
            this.postMessage({type:"modelFavorites",favorites,requestId:message.requestId});
          }
          return;
        case "searchFiles": {
          if (typeof message.query !== "string") return;
          try {
            const files = await this.callbacks.searchFiles(message.query);
            this.postMessage({type:"fileSearchResults",requestId:message.requestId,files});
          } catch (error) {
            this.postMessage({type:"fileSearchResults",requestId:message.requestId,error:String(error),files:[]});
          }
          return;
        }
        case "openExternal": {
          if (typeof message.url !== "string") return;
          const uri = vscode.Uri.parse(message.url);
          if (["https", "http", "mailto"].includes(uri.scheme)) await vscode.env.openExternal(uri);
          return;
        }
        case "openFile": {
          if (typeof message.path !== "string") return;
          const cwd = this.controller.store.view().cwd;
          if (!cwd) throw new Error("Open a workspace before opening file references.");
          const root = fs.realpathSync(cwd);
          const file = fs.realpathSync(path.resolve(cwd, message.path));
          const relative = path.relative(root, file);
          if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("File references must stay inside the workspace.");
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
          const line = typeof message.line === "number" ? Math.max(0, Math.min(document.lineCount - 1, message.line - 1)) : 0;
          const endLine = typeof message.endLine === "number" ? Math.max(line, Math.min(document.lineCount - 1, message.endLine - 1)) : line;
          await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, 0, endLine, 0), preview: true });
          return;
        }
        case "openInEditor":
          this.callbacks.openInEditor(id);
          return;
        case "newSession":
          this.callbacks.newSession();
          return;
        case "ready":
          this.ready = true;
          if (this.pendingHistory) { this.pendingHistory = false; this.postMessage({type:"showSessions"}); }
          for (const text of this.pendingContext.splice(0)) this.postMessage({ type: "addContext", text });
          this.postState();
          return;
        case "openThread":
          if (typeof message.sessionId === "string") this.callbacks.openSession(message.sessionId);
          return;
        case "send": {
          const text = typeof message.text === "string" ? message.text.trim() : "";
          const images: ImageAttachment[] = Array.isArray(message.images) ? message.images.map((image: unknown) => {
            if (!image || typeof image !== "object" || typeof (image as ImageAttachment).mediaType !== "string" || typeof (image as ImageAttachment).data !== "string") throw new Error("Invalid image attachment");
            return image as ImageAttachment;
          }) : [];
          if (!text && !images.length && !(Array.isArray(message.files) && message.files.length) && !(Array.isArray(message.textFiles) && message.textFiles.length)) return;
          const prompt = await this.controller.withAttachments(text, message.files, message.textFiles, this.attachmentSource);
          if (message.mode === "steer" && typeof message.turnId === "string") {
            const sent = this.controller.steer(message.turnId, prompt, images);
            if (!sent) throw new Error("Session is not connected");
            const result = await sent.done;
            if (result.status === "rejected") throw new Error(result.message || "Message rejected");
          } else {
            const sent = this.controller.sendPrompt(prompt, images);
            if (!sent) throw new Error("Session is not connected");
            const result = await sent.done;
            if (result.status === "rejected") throw new Error(result.message || "Message rejected");
          }
          for(const ref of Array.isArray(message.textFiles)?message.textFiles:[]) if(typeof ref === "string") this.controller.releaseTextAttachment(ref,this.attachmentSource);
          this.postMessage({ type: "sendAccepted", text, textFiles:message.textFiles });
          return;
        }
        case "withdraw":
          if (typeof message.promptId === "string") this.controller.withdraw(message.promptId);
          return;
        case "cancel":
          this.controller.cancelActive(typeof message.turnId === "string" ? message.turnId : undefined);
          return;
        case "interrupt":
          const execId=Number(message.execId);
          if (Number.isSafeInteger(execId)) this.controller.interruptExec(execId);
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
        case "toggleCheckpointBookmark":
          if(typeof message.turnId==="string") {
            const ids=await this.callbacks.toggleCheckpointBookmark(id,message.turnId);
            this.postMessage({type:"bookmarkFinished",turnId:message.turnId,ids});
          }
          return;
        case "forkAtMessage":
          if(typeof message.turnId === "string") {
            await this.callbacks.forkAtMessage(id,message.turnId);
            this.postMessage({type:"forkFinished",turnId:message.turnId});
          }
          return;
        case "fork":
          this.callbacks.forkSession(id);
          return;
        case "renameSession":
          if (typeof message.sessionId === "string" && typeof message.name === "string" && message.name.trim()) {
            const name = await this.callbacks.renameSession(message.sessionId, message.name.trim());
            if (typeof name === "string") this.postMessage({ type: "renamed", sessionId: message.sessionId, name });
            this.postMessage({ type: "sessionsChanged" });
          }
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
        case "deleteSession":
          if (typeof message.sessionId === "string") {
            await this.callbacks.deleteSession(message.sessionId);
            this.postMessage({ type: "sessionsChanged" });
          }
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
        case "requestSessions": {
          const query = typeof message.query === "string" ? message.query : "";
          const sessions = await this.callbacks.listSessions(query);
          this.postMessage({ type: "sessions", sessions, query, requestId: message.requestId });
          return;
        }
        case "revealSessions":
          this.callbacks.revealSessionsView();
          return;
        case "refresh":
          this.controller.refreshHeader();
          this.controller.refreshTarget();
          this.controller.refreshThreads();
          return;
        default:
          return;
      }
    } catch (error) {
      if(message.type==="toggleCheckpointBookmark")this.postMessage({type:"bookmarkFinished",turnId:message.turnId,error:String(error)});
      if(message.type==="forkAtMessage")this.postMessage({type:"forkFinished",turnId:message.turnId,error:String(error)});
      if(message.type==="runtimeMetadata"){this.postMessage({type:"runtimeMetadata",error:String(error),requestId:message.requestId});return;}
      if(message.type==="browseRuntimeFiles"){this.postMessage({type:"runtimeFiles",error:String(error),requestId:message.requestId});return;}
      if(message.type==="attachRuntimeFiles"||message.type==="attachComputerFiles"){this.postMessage({type:"attachmentsSelected",error:String(error),requestId:message.requestId});return;}
      if(["runtimeStatus","retryRuntime","restartRuntime","installRuntime"].includes(message.type??"")){this.postMessage({type:"runtimeError",message:String(error),requestId:message.requestId});return;}
      if(["slashCatalog","slashCompletions"].includes(message.type??"")){this.postMessage({type:"slashError",requestId:message.requestId,message:String(error)});return;}
      if(message.type === "runSlash"||message.type==="slashCheckpoint"){this.postMessage({type:"slashResult",line:message.line,error:String(error)});return;}
      if(message.type === "stageTextChunk") { this.postMessage({type:"textAttachmentChunk",requestId:message.requestId,index:message.index,error:String(error)}); return; }
      if (["modelOptions","selectModel","selectEffort","favoriteModel","selectAuxiliary","selectDecider","updateBackups","testBackups"].includes(message.type ?? "")) this.postMessage({type:"optionError",message:String(error),requestId:message.requestId});
      if (message.type === "requestSessions") this.postMessage({ type: "sessions", error: String(error), requestId: message.requestId });
      if (message.type === "send") this.postMessage({ type: "sendRejected" });
      this.notes.log(`panel message ${String(message.type)} failed: ${String(error)}`);
      void vscode.window.showWarningMessage(`Nodecode: ${String(error)}`);
    }
  }

  private html(): string {
    const nonce = String(Math.floor(Math.random() * 1e15));
    return [
      "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\">",
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${this.panel.webview.cspSource} https: http://127.0.0.1:* data:">`,
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">",
      `<style>${PANEL_CSS}${HISTORY_CSS}${ATTACHMENT_CSS}${MESSAGE_CSS}</style></head><body>${PANEL_BODY.replaceAll("__MARK_URI__", this.markUri)}`,
      `<script nonce="${nonce}" src="${this.markdownUri}"></script>`,
      `<script nonce="${nonce}">${CLIENT_JS.replaceAll("__MARK_URI__", this.markUri).replace("__SESSION_ID__", JSON.stringify(this.controller.sessionId))}</script>`,
      "</body></html>",
    ].join("\n");
  }
}

/** The sidebar and editor use the same conversation renderer and controllers. */
export class SessionSidebar implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private attached: SessionPanel | undefined;
  private controller: SessionController | undefined;
  private pendingContext: string[] = [];
  private pendingHistory = false;
  private welcomeReady = false;
  private welcomeGeneration = 0;
  private historyBrowserState: unknown;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri, private readonly callbacks: PanelCallbacks,
    private readonly notes: Notifications) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    this.subscriptions.push(view.onDidDispose(() => { this.attached?.dispose(); this.attached = undefined; this.view = undefined; }));
    this.subscriptions.push(view.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === "historyBrowserState") { this.historyBrowserState = message.state; return; }
      if (this.attached) {
        if (message?.type === "ready" && this.historyBrowserState) void view.webview.postMessage({type:"historyRestore",state:this.historyBrowserState});
        return;
      }
      const generation = this.welcomeGeneration;
      if (message?.type === "ready") { this.welcomeReady = true; if (this.historyBrowserState) void view.webview.postMessage({type:"historyRestore",state:this.historyBrowserState}); if (this.pendingHistory) { this.pendingHistory = false; void view.webview.postMessage({type:"showSessions"}); } return; }
      if (message?.type === "installRuntime") { this.callbacks.installRuntime();return; }
      if (["runtimeStatus","retryRuntime","restartRuntime"].includes(message?.type)) {
        try { const status=await this.callbacks[message.type as "runtimeStatus"|"retryRuntime"|"restartRuntime"](); if(!this.attached&&this.view===view&&generation===this.welcomeGeneration)void view.webview.postMessage({type:"runtimeStatus",status,requestId:message.requestId}); }
        catch(error){if(!this.attached&&this.view===view&&generation===this.welcomeGeneration)void view.webview.postMessage({type:"runtimeError",message:String(error),requestId:message.requestId});}
        return;
      }
      if (message?.type === "newSession") this.callbacks.newSession();
      if (message?.type === "openThread" && typeof message.sessionId === "string") this.callbacks.openSession(message.sessionId);
      try {
        if (message?.type === "deleteSession" && typeof message.sessionId === "string") await this.callbacks.deleteSession(message.sessionId);
        if (message?.type === "renameSession" && typeof message.sessionId === "string" && typeof message.name === "string" && message.name.trim()) await this.callbacks.renameSession(message.sessionId, message.name.trim());
        if (["requestSessions", "deleteSession", "renameSession"].includes(message?.type)) {
          if (message.type !== "requestSessions") { if (!this.attached && this.view === view && generation === this.welcomeGeneration) void view.webview.postMessage({type:"sessionsChanged"}); return; }
          const query = typeof message.query === "string" ? message.query : "";
          const sessions = await this.callbacks.listSessions(query);
          if (!this.attached && this.view === view && generation === this.welcomeGeneration) void view.webview.postMessage({type:"sessions",sessions,query,requestId:message.requestId});
        }
      } catch(error) { if (!this.attached && this.view === view && generation === this.welcomeGeneration) void view.webview.postMessage({type:"sessions",error:String(error),requestId:message.requestId}); }
    }));
    if (this.controller) this.attach();
    else this.showWelcome(view);
  }

  private showWelcome(view: vscode.WebviewView): void {
      this.welcomeReady = false;
      this.welcomeGeneration++;
      const mark = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "icon.svg"));
      const nonce = String(Math.floor(Math.random() * 1e15));
      view.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>${PANEL_CSS}${HISTORY_CSS}${ATTACHMENT_CSS}${MESSAGE_CSS}</style></head><body>${RUNTIME_MARKUP}<div class="welcome" style="padding:24px;min-height:85vh"><img src="${mark}" alt="Nodecode axolotl"><h1>Build with nodecode.</h1><p>Your workspace, a conversation, and room to think.</p><button class="primary" id="new">New conversation</button><div id="sessionPickerWrap"><button id="browse" aria-expanded="false" aria-controls="sessionPicker">Browse sessions</button><div id="sessionPicker" class="hidden" role="dialog" aria-label="Sessions"><div class="picker-heading"><strong>Sessions</strong><button id="closeSessions" aria-label="Close sessions">×</button></div>${HISTORY_MODES}<input id="sessionSearch" class="history-search" type="search" aria-label="Search sessions" placeholder="Search names or messages…" autocomplete="off"><div id="sessionSearchStatus" class="history-status" role="status"></div><div id="sessionChoices"></div></div></div></div><script nonce="${nonce}">
      const vscode=acquireVsCodeApi(),button=document.getElementById('browse'),picker=document.getElementById('sessionPicker'),choices=document.getElementById('sessionChoices'),search=document.getElementById('sessionSearch'),status=document.getElementById('sessionSearchStatus');let generation=0,timer,roster=[],lastRows=[],historyMode='lineage',restoreScroll=0;
      ${HISTORY_TREE_JS}
      function saveHistory(){const state={open:!picker.classList.contains('hidden'),query:search.value,mode:historyMode,scroll:choices.scrollTop};const saved=vscode.getState()||{};saved.historyBrowser=state;vscode.setState(saved);vscode.postMessage({type:'historyBrowserState',state});}
      function restoreHistory(state){if(!state)return;if(state.open&&!picker.classList.contains('hidden')&&generation>0&&search.value===state.query&&historyMode===state.mode)return;historyMode=state.mode==='recent'?'recent':'lineage';search.value=state.query||'';restoreScroll=Number(state.scroll)||0;document.querySelectorAll('[data-history-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.historyMode===historyMode)));if(state.open){picker.classList.remove('hidden');button.setAttribute('aria-expanded','true');request();}else{picker.classList.add('hidden');button.setAttribute('aria-expanded','false');}}
      function close(){generation++;clearTimeout(timer);picker.classList.add('hidden');button.setAttribute('aria-expanded','false');saveHistory();}
      function request(){if(picker.classList.contains('hidden'))return;status.textContent=search.value.trim()?'Searching messages…':'Loading sessions…';vscode.postMessage({type:'requestSessions',query:search.value.trim(),requestId:++generation});}
      document.getElementById('new').onclick=()=>vscode.postMessage({type:'newSession'});
      button.onclick=()=>{if(!picker.classList.contains('hidden')){close();return;}picker.classList.remove('hidden');button.setAttribute('aria-expanded','true');choices.textContent='';saveHistory();request();search.focus();};
      document.getElementById('closeSessions').onclick=()=>{close();button.focus();};
      document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!picker.classList.contains('hidden')){e.preventDefault();close();button.focus();}});
      document.addEventListener('click',e=>{if(!e.composedPath().includes(document.getElementById('sessionPickerWrap')))close();});
      function render(rows){lastRows=rows;choices.replaceChildren();for(const entry of historyTree(rows,historyMode)){const row=entry.row;
        const group=document.createElement('div');group.className='session-row';if(historyMode==='lineage'){group.dataset.depth=entry.depth;group.style.setProperty('--history-depth',entry.depth);}
        const item=document.createElement('button');item.className='session-choice';const original=row.title||row.semanticTitle||'Untitled conversation';item.textContent=original;item.onclick=()=>{saveHistory();vscode.postMessage({type:'openThread',sessionId:row.id});};if(historyMode==='lineage'){const label=document.createElement('span');label.className='session-lineage';label.textContent=(entry.orphan||entry.cycle?'':'Level '+entry.depth+' · ')+historyKind(entry);item.appendChild(label);}
        const rename=document.createElement('button');rename.className='session-rename';rename.setAttribute('aria-label','Rename '+item.textContent);rename.title='Rename conversation';rename.innerHTML='${icon("edit")}';
        rename.onclick=()=>{if(group.querySelector('input'))return;const input=document.createElement('input');input.className='session-rename-input';input.setAttribute('aria-label','Session name');input.value=original;let finished=false;function finish(commit){if(finished)return;finished=true;input.replaceWith(item);if(commit&&input.value.trim()&&input.value.trim()!==original)vscode.postMessage({type:'renameSession',sessionId:row.id,name:input.value.trim()});item.focus();}input.onkeydown=ev=>{if(ev.key==='Enter'||ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();finish(ev.key==='Enter');}};input.onblur=()=>finish(false);item.replaceWith(input);input.focus();input.select();};
        const del=document.createElement('button');del.className='session-delete';del.textContent='×';del.setAttribute('aria-label','Delete '+item.textContent);del.title='Delete conversation';del.onclick=()=>vscode.postMessage({type:'deleteSession',sessionId:row.id});
        if(row.matchSnippet){const snippet=document.createElement('span');snippet.className='session-match';snippet.textContent=row.matchSnippet;item.appendChild(snippet);}
        group.append(item,rename,del);choices.appendChild(group);
      }if(!choices.children.length)choices.textContent=search.value.trim()?'No matching conversations.':'No conversations yet.';if(restoreScroll){choices.scrollTop=restoreScroll;restoreScroll=0;}saveHistory();}
      search.oninput=()=>{generation++;clearTimeout(timer);saveHistory();const q=search.value.trim().toLowerCase();render(roster.filter(row=>[row.title,row.prompt,row.working_directory].filter(Boolean).join(' ').toLowerCase().includes(q)));status.textContent='Searching messages…';timer=setTimeout(request,180);};
      search.onkeydown=e=>{if(e.key==='ArrowDown'&&choices.querySelector('button')){e.preventDefault();choices.querySelector('button').focus();}};
      document.querySelectorAll('[data-history-mode]').forEach(b=>b.onclick=()=>{historyMode=b.dataset.historyMode;document.querySelectorAll('[data-history-mode]').forEach(other=>other.setAttribute('aria-pressed',String(other===b)));render(lastRows);});choices.addEventListener('scroll',saveHistory,{passive:true});
      window.addEventListener('message',e=>{const m=e.data;if(m?.type==='historyRestore'){restoreHistory(m.state);return;}if(m?.type==='showSessions'){if(picker.classList.contains('hidden'))button.click();return;}if(m?.type==='sessionsChanged'){if(!picker.classList.contains('hidden'))request();return;}if(m?.type!=='sessions'||m.requestId!==undefined&&m.requestId!==generation)return;if(m.error){status.textContent=m.error;return;}if(!m.query)roster=m.sessions||[];status.textContent=m.query?(m.sessions||[]).length+' conversations · content results capped at 60 matches':'';render(m.sessions||[]);});vscode.postMessage({type:'ready'});restoreHistory((vscode.getState()||{}).historyBrowser);
      function E(id){return document.getElementById(id);}
      ${RUNTIME_CLIENT_JS}
      </script></body></html>`;
  }

  clearSessions(sessionIds: string[]): void {
    if (!this.controller || !sessionIds.includes(this.controller.sessionId)) return;
    this.attached?.dispose();
    this.attached = undefined;
    this.controller = undefined;
    this.pendingContext = [];
    if (this.view) this.showWelcome(this.view);
  }

  showHistory(): void {
    if (this.attached) { this.view?.show(true); this.attached.showHistory(); return; }
    this.pendingHistory = true;
    if (!this.view) { void vscode.commands.executeCommand("nodecodeChat.focus"); return; }
    this.view.show(true);
    if (this.welcomeReady) { this.pendingHistory = false; void this.view.webview.postMessage({type:"showSessions"}); }
  }

  show(controller: SessionController): void {
    if (this.controller === controller && this.attached && this.view) { this.view.show(true); return; }
    this.controller = controller;
    if (this.view) { this.attach(); this.view.show(true); }
    else void vscode.commands.executeCommand("nodecodeChat.focus");
  }

  addContext(text: string): void {
    if (this.attached) this.attached.addContext(text);
    else this.pendingContext.push(text);
  }

  restore(controller: SessionController): void {
    this.controller = controller;
    if (this.view) this.attach();
  }

  private attach(): void {
    if (!this.view || !this.controller) return;
    this.attached?.dispose();
    this.attached = SessionPanel.forSidebar(this.view, this.extensionUri, this.controller, this.callbacks, this.notes);
    if (this.pendingHistory) { this.pendingHistory = false; this.attached.showHistory(); }
    for (const text of this.pendingContext.splice(0)) this.attached.addContext(text);
  }

  dispose(): void {
    this.attached?.dispose();
    this.subscriptions.splice(0).forEach((entry) => entry.dispose());
  }
}

const PANEL_CSS = `
${ACTIVITY_CSS}
:root{color-scheme:light dark;--bg:var(--vscode-editor-background,#171716);--fg:var(--vscode-editor-foreground,#e8e5df);--dim:var(--vscode-descriptionForeground,#99958c);--border:var(--vscode-panel-border,#373630);--surface:var(--vscode-sideBar-background,#20201d);--accent:#fa8b3e;--accentfg:#20140a;--err:var(--vscode-errorForeground,#f48771);--warn:var(--vscode-editorWarning-foreground,#cca700);--ok:var(--vscode-testing-iconPassed,#73c991)}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--bg);color:var(--fg);font:var(--vscode-font-size,13px)/1.6 var(--vscode-font-family,system-ui,sans-serif)}button,textarea{font:inherit}button{color:inherit;cursor:pointer;background:transparent;border:1px solid transparent;border-radius:6px;padding:5px 9px;line-height:1.4}button:hover{background:var(--vscode-toolbar-hoverBackground,#ffffff10)}button:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--vscode-focusBorder,var(--accent));outline-offset:2px}button:disabled{opacity:.4;cursor:default}button.danger{color:var(--err)}button.primary{background:var(--accent);color:var(--accentfg);font-weight:650}button.primary:hover{filter:brightness(1.1)}.hidden{display:none!important}.grow{flex:1;min-width:0}.sub{font-size:11px;color:var(--dim)}#app{height:100vh;display:flex;flex-direction:column}#topbar{display:flex;align-items:center;gap:12px;min-height:54px;padding:8px 16px;border-bottom:1px solid var(--border)}.brand{display:flex;align-items:center;gap:8px;font-weight:650;letter-spacing:-.3px}.brand img{width:30px;height:30px;border-radius:6px}.title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dim)}.btns{display:flex;gap:2px}.icon{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;vertical-align:middle}.icon-btn{width:30px;height:30px;padding:6px;display:inline-flex;align-items:center;justify-content:center}#menuWrap{position:relative}#menuWrap summary{list-style:none;cursor:pointer}#menuWrap summary::-webkit-details-marker{display:none}.menu{position:absolute;right:0;top:36px;z-index:4;width:205px;border:1px solid var(--border);padding:5px;border-radius:8px;background:var(--vscode-menu-background,var(--surface));box-shadow:0 8px 28px #0004}.menu button{display:block;width:100%;text-align:left;font-size:12px;padding:7px 10px}.menu hr{border:0;border-top:1px solid var(--border);margin:4px}.menu button .icon{margin-right:8px}#scroll{flex:1;min-height:0;overflow:auto;overflow-anchor:none;padding:22px 24px;scrollbar-gutter:stable}#transcript{max-width:820px;margin:0 auto}.msg{margin:0 0 22px}.msg.user{display:flex;justify-content:flex-end}.bubble{overflow-wrap:anywhere;min-width:0}.msg.user .bubble{max-width:85%;background:var(--surface);border:1px solid var(--border);border-radius:12px 12px 3px 12px;padding:10px 15px}.msg.assistant .bubble{width:100%}.speaker{display:flex;gap:7px;align-items:center;color:var(--dim);font-size:11px;font-weight:600;margin-bottom:7px}#attachments{display:flex;gap:8px;flex-wrap:wrap}.attachment{position:relative;margin:6px 0}.attachment img{width:64px;height:64px;object-fit:cover;border:1px solid var(--border);border-radius:7px}.attachment button{position:absolute;right:-6px;top:-6px;border:1px solid var(--border);border-radius:50%;background:var(--surface);font-size:12px;line-height:1;padding:3px 5px}.message-image{display:block;max-width:min(100%,480px);max-height:360px;object-fit:contain;border:1px solid var(--border);border-radius:8px;margin:8px 0}.fork-turn{font-size:10px;padding:1px 5px;color:var(--dim)}.copy-text{margin-left:auto;font-size:10px;color:var(--dim);padding:1px 5px}.reasoning summary .copy-text{float:right}.speaker img{width:20px;height:20px;border-radius:4px}.msg p{margin:8px 0}.msg p:first-child{margin-top:0}.msg p:last-child{margin-bottom:0}pre.code,pre.tool-io{background:var(--vscode-textCodeBlock-background,var(--surface));border:1px solid var(--border);border-radius:7px;padding:10px 12px;overflow:auto;font:12px/1.6 var(--vscode-editor-font-family,monospace);tab-size:2}code.inline{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:1px 4px;font:12px var(--vscode-editor-font-family,monospace)}strong.h{font-size:15px}.li{margin-left:10px}.reasoning{border-left:2px solid var(--accent);margin:4px 0 12px;padding-left:12px;color:var(--dim)}.reasoning summary{cursor:pointer;font-size:12px;padding:3px 0}.reasoning .rbody{white-space:pre-wrap;max-height:min(calc(8 * 1.6em + 8px),var(--thought-cap,162px));overflow:auto;overflow-anchor:none;overscroll-behavior:contain;font-size:12px;padding:4px 0}.caret{display:inline-block;width:6px;height:14px;border-radius:2px;background:var(--accent);animation:blink 1s steps(1) infinite;vertical-align:middle}@keyframes blink{50%{opacity:0}}.tool{border:1px solid var(--border);border-radius:8px;margin:8px 0 16px;overflow:hidden}.tool-head{cursor:pointer;font:12px/1.6 var(--vscode-editor-font-family,monospace);padding:8px 12px;background:var(--surface)}.tool-head.running{color:var(--warn)}.tool-head.done{color:var(--dim)}.tool-diff,.tool-metadata{margin:8px 12px}.tool-diff summary,.tool-metadata summary{cursor:pointer;font-size:12px}.tool-head.failed{color:var(--err)}.tool-head.stopped,.tool-head.background{color:var(--warn)}.msg.voided{opacity:.7}.tool-sec{padding:8px 12px}.tool-label{text-transform:uppercase;font-size:10px;letter-spacing:.07em;color:var(--dim)}.tool-sec pre{max-height:320px;margin:4px 0}.sys{color:var(--dim);font-size:12px;text-align:center;margin:12px 0}.sys.warn{color:var(--warn)}.sys.error{color:var(--err)}.welcome{min-height:45vh;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;gap:9px;color:var(--dim)}.welcome img{width:92px;height:92px;border-radius:18px}.welcome h1{font-size:23px;letter-spacing:-.7px;color:var(--fg);margin:4px 0}.welcome p{max-width:330px;margin:0}.welcome small{font-size:11px;margin-top:8px}#procBar,#queueBar,#threadBar{display:flex;gap:6px;flex-wrap:wrap;padding:7px 16px;border-top:1px solid var(--border)}#procBar:empty,#queueBar:empty,#threadBar:empty{display:none}.strip-label{font-size:11px;color:var(--dim);padding:4px 3px;align-self:center}.chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:11px;max-width:100%;background:var(--surface)}.chip .cmd{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:350px}.chip button{padding:1px 4px;font-size:11px}.thread{max-width:240px;text-align:left}.thread .state{width:6px;height:6px;border-radius:50%;background:var(--dim)}.thread.running .state{background:var(--accent)}#statusLine{font-size:11px;color:var(--dim);max-width:820px;margin:auto;width:100%;display:flex;justify-content:space-between;padding:0 4px 6px;min-height:23px}.connection{display:inline-flex;align-items:center;gap:5px}.connection:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--ok)}.connection.offline:before{background:var(--warn)}#composerArea{padding:10px 20px 12px}#composerBar{max-width:820px;margin:auto;border:1px solid var(--border);border-radius:12px;background:var(--vscode-input-background,var(--surface));padding:10px 12px 8px}#composerBar:focus-within{border-color:var(--accent)}#composer{display:block;width:100%;resize:none;min-height:42px;max-height:180px;overflow:auto;background:transparent;color:var(--vscode-input-foreground,var(--fg));border:0;outline:0;padding:1px 2px;font:inherit}#composer::placeholder{color:var(--vscode-input-placeholderForeground,var(--dim))}.composer-actions{display:flex;align-items:center;gap:6px;margin-top:7px}.selector{font-size:11px;color:var(--dim);padding:4px 6px;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.selector .icon{width:13px;height:13px;margin-right:4px}.composer-hint{text-align:center;color:var(--dim);font-size:10px;padding-top:6px}.mode.steering{background:var(--accent);color:var(--accentfg)}#jumpBtn{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);border:1px solid var(--border);background:var(--surface);box-shadow:0 3px 12px #0003;font-size:11px;border-radius:20px;padding:5px 12px}#conversation{flex:1;min-height:0;display:flex;position:relative;flex-direction:column}a{color:var(--vscode-textLink-foreground,#fa8b3e)}@media(max-width:480px){#topbar{padding:8px 10px;gap:9px}.brand-name{display:none}#scroll{padding:16px 12px}#composerArea{padding:8px 10px}.composer-hint{display:none}}@media(prefers-reduced-motion:reduce){*{animation:none!important;scroll-behavior:auto!important}}
#commandResult{max-height:230px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;overflow:auto}#commandBody{padding:6px 10px}.command-tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px}.command-tabs [aria-pressed="true"]{background:var(--surface);border-color:var(--border)}.command-row{display:flex;gap:4px}.command-row>button:first-child{flex:1;text-align:left}.command-row .sub,.file-option .sub{display:block;font-size:11px}#runtimeBanner{padding:8px 12px;border-bottom:1px solid var(--border);color:var(--warn);font-size:12px}#runtimeBanner>div{display:flex;gap:6px;margin-top:5px}#historyEarlier{display:block;margin:0 auto 16px;font-size:12px;color:var(--dim)}#topbar{position:relative}.title-button{display:block;max-width:100%;padding:2px 0;border:0;text-align:left;color:var(--fg);font-weight:600;font-size:13px}.title-input,.session-rename-input{width:100%;min-width:0;background:var(--vscode-input-background,var(--surface));color:var(--fg);border:1px solid var(--vscode-focusBorder,var(--accent));border-radius:4px;padding:4px 6px;font:inherit}.session-rename-input{flex:1}.session-rename{flex-shrink:0;width:28px;height:28px;padding:5px;color:var(--dim)}.session-rename .icon{width:14px;height:14px}#sessionPickerWrap{position:static}#sessionPicker{position:absolute;z-index:5;top:calc(100% - 4px);right:10px;width:min(320px,calc(100vw - 24px));border:1px solid var(--border);border-radius:8px;background:var(--vscode-menu-background,var(--surface));box-shadow:0 8px 28px #0004;padding:5px}.history-search{display:block;width:calc(100% - 12px);margin:3px 6px 5px;padding:6px 8px;background:var(--vscode-input-background,var(--bg));color:var(--fg);border:1px solid var(--border);border-radius:5px;font:inherit;font-size:12px}.history-search:focus{outline:1px solid var(--vscode-focusBorder,var(--accent))}.history-status{font-size:11px;color:var(--dim);padding:0 8px 4px}.session-match{white-space:normal!important;display:-webkit-box!important;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:3px;font-size:11px;color:var(--dim)}.picker-heading{display:flex;align-items:center;justify-content:space-between;padding:3px 7px;font-size:12px;color:var(--dim)}#sessionChoices{max-height:min(360px,50vh);overflow:auto;overscroll-behavior:contain}.session-row{display:flex;align-items:center;gap:3px}.session-choice{display:block;flex:1;min-width:0;width:100%;text-align:left;padding:8px;border-radius:5px}.session-delete{flex-shrink:0;width:28px;height:28px;padding:5px;color:var(--dim)}.session-delete:hover{color:var(--err)}.session-choice[aria-current="true"]{background:var(--vscode-list-activeSelectionBackground,var(--border));color:var(--vscode-list-activeSelectionForeground,var(--fg))}.session-choice span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.session-choice .sub{margin-top:2px}.welcome #sessionPickerWrap{position:relative}.welcome #sessionPicker{top:auto;bottom:36px;right:50%;transform:translateX(50%);text-align:left}#composerBar{position:relative}#filePicker{position:fixed;top:0;left:0;width:320px;max-height:180px;overflow:auto;z-index:5;background:var(--vscode-menu-background,var(--surface));border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 8px 28px #0004}#optionPicker{display:flex;flex-direction:column;max-height:calc(100vh - 16px);position:fixed;width:340px;max-width:calc(100vw - 16px);z-index:6;background:var(--vscode-menu-background,var(--surface));border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 28px #0004;padding:5px}.model-role-tabs{display:flex;flex-shrink:0;border-top:1px solid var(--border);padding-top:5px;gap:3px}.model-role-tabs button{flex:1;font-size:12px}.model-role-tabs [aria-selected="true"]{background:var(--surface);color:var(--accent)}.backup-row{display:flex;gap:3px;align-items:center;padding:5px}.backup-row>span{flex:1;min-width:0;overflow-wrap:anywhere}.backup-row .sub{display:block}.backup-row button{flex-shrink:0}.backup-trigger{display:flex;gap:7px;align-items:center;padding:5px 8px}.role-default{width:100%;text-align:left;padding:7px}.role-efforts{display:flex;gap:3px;flex-wrap:wrap;padding:5px}.aux-effort-list{flex-direction:column}.aux-effort-list button{width:100%;text-align:left}.role-efforts [aria-pressed="true"]{color:var(--accent);border:1px solid var(--border)}#optionChoices{min-height:0;max-height:280px;overflow:auto;overscroll-behavior:contain}.option-note{font-size:10px;color:var(--dim);padding:7px}.option-row{display:flex;align-items:center;gap:4px}.decider-choice,.reasoning-choice{display:block;width:100%;text-align:left}.option-select{min-width:0;flex:1;text-align:left;padding:7px}.option-select span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.option-select[aria-current="true"]{background:var(--vscode-list-activeSelectionBackground,var(--border));color:var(--vscode-list-activeSelectionForeground,var(--fg))}.option-star{flex-shrink:0;padding:6px}.option-star[aria-pressed="true"]{color:var(--accent)}.option-group{font-size:11px;color:var(--dim);padding:6px 8px 2px}#imagePreview{position:fixed;inset:0;z-index:20;background:#000b;display:flex;align-items:center;justify-content:center;padding:36px}#imagePreview img{max-width:100%;max-height:100%;object-fit:contain}#closeImagePreview{position:absolute;right:10px;top:10px;font-size:24px;color:white}.attachment img,.message-image{cursor:zoom-in}#textAttachments{display:flex;flex-wrap:wrap;gap:6px}.text-attachment{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border);border-radius:5px;padding:3px 6px;font-size:11px;max-width:100%}.text-attachment button{padding:1px 3px}.text-attachment .text-file-open{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.text-attachment.failed{border-color:var(--err)}.file-option{width:100%;text-align:left;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-option[aria-selected="true"]{background:var(--vscode-list-activeSelectionBackground,var(--border));color:var(--vscode-list-activeSelectionForeground,var(--fg))}.message-files{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}.message-file{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--border);border-radius:4px;padding:1px 5px;font-size:11px;color:var(--dim)}#fileReferences{display:flex;flex-wrap:wrap;gap:5px}.file-reference{display:inline-flex;align-items:center;max-width:100%;gap:4px;margin:4px 0;border:1px solid var(--border);border-radius:5px;padding:2px 5px;font-size:11px}.file-reference span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-reference button{padding:0 3px}.picker-message{padding:14px 8px;color:var(--dim);font-size:12px}
.md p {
	margin: 0.35em 0;
	line-height: 1.55;
}

.md p:first-child { margin-top: 0; }
.md p:last-child { margin-bottom: 0; }

.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
	margin: 0.75em 0 0.3em;
	line-height: 1.3;
}

.md h1 { font-size: 1.25em; }
.md h2 { font-size: 1.15em; }
.md h3 { font-size: 1.05em; }
.md h4, .md h5, .md h6 { font-size: 1em; }

.md ul, .md ol {
	margin: 0.35em 0;
	padding-left: 1.5em;
}

.md li { margin: 0.15em 0; }

.md code {
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 0.92em;
	background: var(--surface, rgba(128, 128, 128, 0.16));
	border: 1px solid var(--border);
	border-radius: 4px;
	padding: 0.5px 4px;
}

.codeblock {
	border: 1px solid var(--border);
	border-radius: 8px;
	overflow: hidden;
	margin: 0.45em 0;
}

.codeblock-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 3px 8px;
	background: var(--surface, rgba(128, 128, 128, 0.1));
	border-bottom: 1px solid var(--border);
	font-size: 10.5px;
	color: var(--dim);
}

.codeblock-copy {
	font-size: 10.5px;
	color: var(--dim);
	padding: 1px 6px;
	border-radius: 4px;
}

.codeblock-copy:hover {
	color: var(--accent);
	background: var(--surface);
}

.md pre {
	background: var(--surface, rgba(128, 128, 128, 0.1));
	padding: 9px 11px;
	overflow-x: auto;
	margin: 0;
}

.md pre code {
	background: none;
	border: none;
	padding: 0;
	white-space: pre;
}

.md a {
	color: var(--accent);
	text-decoration: none;
}

.md a:hover {
	text-decoration: underline;
}

/* A target we will not open (relative path, unknown scheme) must not be dressed
   up as a working link. */
.md a.md-link-inert,
.md a.md-link-inert:hover {
	color: var(--dim);
	text-decoration: underline dotted;
	cursor: default;
}

.md blockquote {
	margin: 0.35em 0;
	padding: 3px 11px;
	border-left: 2px solid var(--accent);
	color: var(--dim);
}

.md hr {
	border: none;
	border-top: 1px solid var(--border);
	margin: 0.7em 0;
}

.md table {
	border-collapse: collapse;
	margin: 0.45em 0;
	font-size: 0.95em;
}

.md th, .md td {
	border: 1px solid var(--border);
	padding: 4px 9px;
}

.md th {
	background: var(--surface);
}


`;

function icon(name: string): string {
  const paths: Record<string, string> = {
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/>',
    bookmark: '<path d="M6 3h12v18l-6-4-6 4V3Z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    menu: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    history: '<path d="M3 11a9 9 0 1 1 3 8M3 4v7h7M12 7v5l3 2"/>',
    terminal: '<path d="m5 6 5 6-5 6M13 18h6"/>',
    fork: '<circle cx="6" cy="4" r="2"/><circle cx="18" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><path d="M6 6v12M18 6a6 6 0 0 1-6 6H6"/>',
    undo: '<path d="M3 10h11a6 6 0 0 1 0 12M3 10l5-5M3 10l5 5"/>',
    redo: '<path d="M21 10H10a6 6 0 0 0 0 12M21 10l-5-5M21 10l-5 5"/>',
    model: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
    effort: '<path d="M4 18a9 9 0 1 1 16 0M12 13l4-5"/><circle cx="12" cy="13" r="2"/>',
    send: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    refresh: '<path d="M20 7a9 9 0 1 0 1 9M20 3v5h-5"/>',
    edit: '<path d="m4 16 12-12 4 4L8 20H4v-4Z"/>',
    export: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  };
  return '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24">' + (paths[name] || paths.menu) + '</svg>';
}
function actionButton(id: string, label: string, symbol: string, extra = ""): string {
  return '<button id="' + id + '" title="' + label + '" aria-label="' + label + '" class="icon-btn ' + extra + '">' + icon(symbol) + '</button>';
}
const MESSAGE_CSS = `
.msg.assistant .bubble{display:grid;grid-template-columns:18px minmax(0,1fr);gap:8px;align-items:start}.message-avatar{width:18px;height:18px;border-radius:4px;margin-top:2px}.assistant-content{position:relative;min-width:0;padding-right:66px}.msg.user .bubble{position:relative;padding-right:36px}.message-actions{position:absolute;right:0;top:0;display:flex;align-items:center;gap:2px;opacity:0;pointer-events:none}.msg.user .message-actions{right:6px;top:7px}.bookmark-turn.saved .icon{fill:var(--accent);stroke:var(--accent)}.copy-text,.fork-turn,.bookmark-turn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:2px;margin:0}.copy-text .icon,.fork-turn .icon,.bookmark-turn .icon{width:14px;height:14px}.reasoning summary{position:relative;padding-right:23px}.reasoning summary>.copy-text{position:absolute;right:0;top:3px;opacity:0;pointer-events:none}.msg:hover:not(:has(.reasoning:hover,.codeblock:hover)) .message-actions,.msg:focus-within:not(:has(.reasoning:focus-within,.codeblock:focus-within)) .message-actions,.message-actions:focus-within{opacity:1;pointer-events:auto}.reasoning:hover>summary>.copy-text,.reasoning:focus-within>summary>.copy-text{opacity:1;pointer-events:auto}.codeblock-copy{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;opacity:0;pointer-events:none;padding:2px}.codeblock-copy svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.7}.codeblock:hover .codeblock-copy,.codeblock:focus-within .codeblock-copy{opacity:1;pointer-events:auto}@media(hover:none){.message-actions,.reasoning summary>.copy-text,.codeblock-copy{opacity:1;pointer-events:auto}}
`;
const PANEL_BODY = `
<div id="app">
  <header id="topbar">
    <div class="brand"><img src="__MARK_URI__" alt="Nodecode axolotl"><span class="brand-name">nodecode</span></div>
    <div class="grow"><button id="title" class="title title-button" aria-label="Rename session">Session</button><input id="titleInput" class="title-input hidden" aria-label="Session name" placeholder="Session name" title="Enter to save · Escape to cancel"><div id="modelLine" class="hidden"></div></div>
    <div class="btns">
      ${actionButton("newBtn", "New conversation", "plus")}
      <div id="sessionPickerWrap">${actionButton("sessBtn", "Browse sessions", "history")}
        <div id="sessionPicker" class="hidden" role="dialog" aria-label="Sessions">
          <div class="picker-heading"><strong>Sessions</strong><button id="closeSessions" aria-label="Close sessions">×</button></div>
          ${HISTORY_MODES}<input id="sessionSearch" class="history-search" type="search" aria-label="Search sessions" placeholder="Search names or messages…" autocomplete="off"><div id="sessionSearchStatus" class="history-status" role="status"></div><div id="sessionChoices"></div>
        </div>
      </div>
      ${actionButton("forkBtn", "Fork session", "fork")}
      <details id="menuWrap"><summary class="icon-btn" title="Session actions" aria-label="Session actions">${icon("menu")}</summary><div class="menu">
        <button id="editorBtn">${icon("terminal")}Open in editor</button>
        <button id="termBtn">${icon("terminal")}Reveal terminal</button>
        <button id="renameBtn">${icon("edit")}Rename session</button>
        <button id="histBtn">${icon("history")}Checkpoint history</button>
        <button id="undoBtn">${icon("undo")}Undo last turn</button>
        <button id="redoBtn">${icon("redo")}Redo checkpoint</button>
        <button id="exportBtn">${icon("export")}Export history</button>
        <button id="refreshBtn">${icon("refresh")}Refresh session</button><hr>
        <button id="delBtn" class="danger">${icon("trash")}Delete session</button><hr>
        <button id="runtimeVersionBtn" disabled>Nodecode CLI version…</button>
        <button id="restartBtn" disabled>Restart service</button>
        <button id="websiteBtn">Visit nodecode.ai</button>
      </div></details>
    </div>
  </header>
  ${RUNTIME_MARKUP}
  <div id="procBar"></div>
  <div id="conversation"><div id="scroll"><button id="historyEarlier" class="hidden">Load earlier messages</button><div id="transcript"></div></div><button id="jumpBtn" class="hidden">↓ Latest message</button></div>
  <div id="threadBar" aria-label="Related threads"></div>
  <div id="fileBar" aria-label="Session file changes"></div>
  <div id="queueBar" aria-label="Queued prompts"></div>
  <div id="composerArea">
    ${SLASH_MARKUP}
    <div id="statusLine" role="status" aria-live="polite"></div>
    <footer id="composerBar">
      ${ATTACHMENT_MENU}
      <div id="optionPicker" class="hidden" role="dialog" aria-label="Model options"><div class="picker-heading"><strong id="optionHeading">Models</strong><button id="optionClose" aria-label="Close options">×</button></div><input id="modelSearch" class="history-search" type="search" aria-label="Search models" placeholder="Search models…"><div id="optionStatus" class="history-status" role="status"></div><div id="optionChoices"></div><div id="optionNote" class="option-note">Changes apply to the next turn and set the default for new sessions.</div><div id="modelRoleTabs" class="model-role-tabs" role="tablist" aria-label="Model role"><button role="tab" data-model-role="main" aria-selected="true">Main</button><button role="tab" data-model-role="aux" aria-selected="false">Aux</button><button role="tab" data-model-role="decider" aria-selected="false">Decider</button><button role="tab" data-model-role="backup" aria-selected="false">Backup</button></div></div>
      <div id="filePicker" class="hidden" role="listbox" aria-label="Workspace files"></div>
      <textarea id="composer" rows="2" aria-label="Message Nodecode" placeholder="What would you like to build?"></textarea>
      <div id="textAttachments" aria-label="Attached text files"></div><div id="fileReferences" aria-label="Attached workspace files"></div><div id="attachments" aria-label="Image attachments"></div><div id="attachmentError" class="sys error hidden" role="alert"></div>
      <input id="imageInput" class="hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.csv,.ts,.tsx,.js,.py,.yaml,.yml,.log" multiple>
      <div class="composer-actions">
        ${actionButton("attachBtn", "Attach files or images", "plus")}
        <button id="modelBtn" class="selector" title="Choose model">${icon("model")}<span id="modelLabel">Choose model</span></button>
        <button id="effortBtn" class="selector" title="Choose effort">${icon("effort")}<span id="effortLabel">Effort</span></button>
        <span class="grow"></span>
        <button id="steerBtn" class="mode hidden" title="Steer the active turn" aria-pressed="false">Steer</button>
        ${actionButton("cancelBtn", "Stop active turn", "stop", "hidden")}
        ${actionButton("sendBtn", "Send message", "send", "primary")}
      </div>
    </footer>
    <div class="composer-hint">Enter to send · Shift+Enter for a new line · @ for files</div>
  </div>
</div>
<div id="imagePreview" class="hidden" role="dialog" aria-label="Image preview"><button id="closeImagePreview" aria-label="Close image preview">×</button><img id="imagePreviewContent" alt="Attachment preview"></div>
`;

const CLIENT_JS = String.raw`
(function(){
  var vscode = acquireVsCodeApi();
  var state = { view: null, connection: 'connecting', attempts: 0, history: [] };
  var attachments = [],pendingReads=0;
  var forkingTurns={},bookmarkingTurns={};
  var steerMode = false;
  var sending = false;
  var sessionId = __SESSION_ID__;
  var persisted = vscode.getState() || {};
  var saved = (persisted.sessions || {})[sessionId] || {};
  attachments=Array.isArray(saved.images)?saved.images:[];
  var textFiles=Array.isArray(saved.textFiles)?saved.textFiles:[],textRequest=Date.now(),textFileCount=textFiles.length,restoredTextStarted=false;
  var files=[],inlineRefs=Array.isArray(saved.inlineRefs)?saved.inlineRefs.filter(function(ref){return ref&&typeof ref.path==='string'&&Number.isInteger(ref.start)&&Number.isInteger(ref.end);}):[],referenceText=saved.draft||'',referenceEdit=null;
  ${INLINE_REFERENCE_JS}
  var fileQuery = null, fileResults = [], fileIndex = 0, fileRequest = 0, fileTimer;
  var historyRequest=0,historyTimer,historyRows=[],historyMode='lineage',historyLast=[],historyRestoreScroll=0;
  ${HISTORY_TREE_JS}
  var optionKind=null,optionRequest=0,optionApplying=false,modelRows=[],modelFavorites=[],modelTarget={},modelContext={},favoriteRequest=0;
  var expanded = saved.expanded || {};
  var paneScroll = {};
  var followLatest = true;
  var firstRender = true;
  var visibleStart = null, loadingEarlier = false, historyExpanded = saved.historyExpanded === true;
  var readingAnchor = null;
  var histIdx = -1;
  function E(id){ return document.getElementById(id); }
  var transcript = E('transcript'), scrollBox = E('scroll'), composer = E('composer'),
      sendBtn = E('sendBtn'), cancelBtn = E('cancelBtn'), steerBtn = E('steerBtn'),
      statusLine = E('statusLine'), titleEl = E('title'), modelEl = E('modelLine'),
      queueBar = E('queueBar'), procBar = E('procBar');
  window.addEventListener('message', function(ev){
    var m = ev.data;
    if (!m) return;
    if(m.type==='bookmarkFinished'){delete bookmarkingTurns[m.turnId];if(Array.isArray(m.ids)&&state.view)state.view.bookmarkedTurnIds=m.ids;renderAll(followLatest);return;}
    if(m.type==='forkFinished'){delete forkingTurns[m.turnId];renderAll(followLatest);return;}
    if(m.type==='textAttachmentChunk'){receiveTextChunk(m);return;}
    if(m.type==='modelOptions'){if(m.requestId===optionRequest&&optionKind){modelRows=m.models||[];modelFavorites=m.favorites||[];modelTarget=m.target||{};modelContext=m.context||{};receiveRoleOptions(m);renderOptions();}return;}
    if(m.type==='modelFavorites'){if(m.requestId!==undefined&&m.requestId!==favoriteRequest)return;modelFavorites=m.favorites||[];if(optionKind==='model'&&!optionApplying)renderOptions();return;}
    if(m.type==='optionApplied'){if(m.requestId!==undefined&&m.requestId!==optionRequest)return;setOptionBusy(false);if(m.warning){E('optionStatus').textContent=m.warning;E('optionChoices').querySelectorAll('button').forEach(function(b){b.disabled=false;});}else closeOptions(true);return;}
    if(m.type==='optionError'){if(m.requestId!==undefined&&m.requestId!==optionRequest)return;setOptionBusy(false);renderOptions();E('optionStatus').textContent=m.message;return;}
    if (m.type === 'fileSearchResults') { if(m.requestId===fileRequest && fileQuery) renderFileResults(m); return; }
    if (m.type === 'historyRestore') { restoreHistory(m.state); return; }
    if (m.type === 'showSessions') { if(E('sessionPicker').classList.contains('hidden')) E('sessBtn').click(); return; }
    if (m.type === 'sessionsChanged') { if(!E('sessionPicker').classList.contains('hidden')) requestHistory(); return; }
    if (m.type === 'renamed') { if(m.sessionId === sessionId) titleEl.textContent=m.name; return; }
    if (m.type === 'sessions') { renderSessionChoices(m); return; }
    if (m.type === 'addContext') { composer.value += (composer.value ? '\n\n' : '') + m.text; grow(); saveDraft(); composer.focus(); renderAll(nearBottom()); return; }
    if (m.type === 'sendAccepted' || m.type === 'sendRejected') {
      sending = false;
      if (m.type === 'sendAccepted') { E('attachmentError').classList.add('hidden');attachments = []; textFiles=textFiles.filter(function(f){return !(m.textFiles||[]).includes(f.attachment&&f.attachment.ref);}); renderAttachments(); renderTextFiles(); renderFileReferences(); if (composer.value.trim() === m.text) { composer.value = '';files=[];inlineRefs=[];referenceText='';grow(); } saveDraft(); }
      renderAll(nearBottom());
      return;
    }
    if (m.type !== 'state') return;
    var wasNearBottom = followLatest;
    state = m;
    renderAll(wasNearBottom);
    if(!restoredTextStarted){restoredTextStarted=true;textFiles.filter(function(f){return !f.attachment&&f.text;}).forEach(stageTextFile);}
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
    return '<div class="md" data-markdown="' + esc(src || '') + '"></div>';
  }
  function renderMarkdownBlocks(root){
    root.querySelectorAll('[data-markdown]').forEach(function(el){
      NodecodeMarkdown.renderMarkdown(el.dataset.markdown, el, {
        external: function(url){ vscode.postMessage({ type: 'openExternal', url: url }); },
        file: function(path, line, endLine){ vscode.postMessage({ type: 'openFile', path: path, line: line, endLine:endLine }); }
      });
      el.removeAttribute('data-markdown');
    });
  }
  function toolHtml(call){
    var status = call.status || (call.done ? (call.failed ? 'failed' : 'done') : 'running');
    var body = '';
    if (call.arguments) body += '<div class="tool-sec"><div class="tool-label">Input</div><pre class="tool-io">' + esc(call.arguments) + '</pre></div>';
    var metadata=call.metadata||{},image=metadata.image,shell=metadata.background_shell;
    if(image){var label=['Image',image.path||image.target||'',image.width&&image.height?image.width+' × '+image.height:'',image.media_type||''].filter(Boolean).join(' · ');body+='<div class="tool-sec"><div class="tool-label">'+esc(label)+'</div>'+(call.imageUrl?'<img class="message-image" src="'+esc(call.imageUrl)+'" alt="Tool image result">':'<div class="sub">Preview unavailable in this workspace</div>')+'</div>';}
    if(metadata.snippet&&metadata.snippet.note)body+='<div class="tool-sec sub">'+esc(metadata.snippet.note)+'</div>';
    if(shell)body+='<div class="tool-sec sub">'+esc(['Background process',shell.status,typeof shell.exit_code==='number'?'exit '+shell.exit_code:''].filter(Boolean).join(' · '))+'</div>';
    var diff=metadata.workspace_diff;
    if(diff&&Array.isArray(diff.files))body+=diff.files.map(function(file,i){return '<details class="tool-diff" data-detail="diff-'+esc(call.callId)+'-'+i+'"><summary>'+esc(file.path)+' <span class="sub">+'+esc(file.added)+' / −'+esc(file.removed)+(file.binary?' · binary':'')+'</span></summary>'+(file.patch?'<pre class="tool-io">'+esc(file.patch)+'</pre>':'<div class="sub">'+(file.binary?'Binary file changed':'No textual patch supplied')+'</div>')+'</details>';}).join('');
    if(Object.keys(metadata).length)body+='<details class="tool-metadata" data-detail="metadata-'+esc(call.callId)+'"><summary>Result details</summary><pre class="tool-io">'+esc(JSON.stringify(metadata,null,2))+'</pre></details>';
    if (call.result && !(image && call.imageUrl && call.imageUrl.startsWith('data:image/png'))) body += '<div class="tool-sec"><div class="tool-label">' + (call.failed ? 'Error' : 'Output') + '</div><pre class="tool-io">' + esc(call.result) + '</pre></div>';
    return '<details class="tool" data-detail="tool-' + esc(call.callId) + '"><summary class="tool-head ' + status + '">' + esc(call.name) + ' <span class="sub">' + status + (call.durationMs != null ? ' · ' + call.durationMs + ' ms' : '') + '</span></summary>' + body + '</details>';
  }
  function imageHtml(part){ return (part.images || []).map(function(image){return '<img class="message-image" src="' + esc(image.url) + '" alt="Conversation image" loading="lazy">';}).join(''); }
  function textFileHtml(part){return (part.textFiles||[]).map(function(file){return '<button class="message-file" data-a="openTextAttachment" data-p="'+esc(file.ref)+'" title="'+esc(file.name)+' · '+file.byteLength+' bytes">'+esc(file.name)+'</button>';}).join('');}
  function fileHtml(part){return (part.files||[]).filter(function(file){return !(part.text||'').includes('@'+file);}).map(function(file){return '<span class="message-file" title="'+esc(file)+'">@'+esc(file.split(/[\\/]/).pop())+'</span>';}).join('');}
  function forkHtml(part){var saved=(state.view&&state.view.bookmarkedTurnIds||[]).includes(part.forkTurnId);return part.forkTurnId&&!part.streaming&&!part.voided&&!(state.view&&state.view.running&&state.view.activeTurnId===part.forkTurnId)?'<button class="fork-turn" data-a="forkAtMessage" data-p="'+esc(part.forkTurnId)+'" '+(forkingTurns[part.forkTurnId]?'disabled':'')+' aria-label="Fork from this turn" title="Fork from this turn into a new editor. Includes all recorded messages in this turn; this conversation is kept.">${icon('fork')}</button><button class="bookmark-turn '+(saved?'saved':'')+'" data-a="toggleCheckpointBookmark" data-p="'+esc(part.forkTurnId)+'" aria-pressed="'+String(saved)+'" aria-label="'+(saved?'Remove bookmark':'Bookmark checkpoint')+'" title="'+(saved?'Remove bookmark':'Bookmark this recorded checkpoint; does not create a new file snapshot')+'" '+(bookmarkingTurns[part.forkTurnId]?'disabled':'')+'>${icon('bookmark')}</button>':'';}
  function partHtml(part, index){
    if (part.kind === 'user') return '<div class="msg user"><div class="bubble"><div class="message-actions"><button class="copy-text" data-a="copyUser" data-p="'+index+'" aria-label="Copy message" title="Copy message">${icon('copy')}</button></div>' + md(part.text) + '<div class="message-files">' + fileHtml(part) + textFileHtml(part) + '</div>' + imageHtml(part) + '</div></div>';
    if (part.kind === 'assistant') {
      var key = 'reasoning-' + index;
      var r = part.reasoning ? '<details class="reasoning" data-detail="' + key + '"><summary><span class="reasoning-label">' + (part.streaming && !part.text ? 'Thinking…' : 'Thought process') + '</span><button class="copy-text" data-a="copyThinking" data-p="' + index + '" aria-label="Copy thought process" title="Copy thought process">${icon('copy')}</button></summary><div class="rbody" tabindex="0" aria-label="Thought process">' + esc(part.reasoning) + '</div></details>' : '';
      var caret = part.streaming ? '<span class="caret"></span>' : '';
      return '<div class="msg assistant' + (part.voided ? ' voided' : '') + '"><div class="bubble"><img class="message-avatar" src="__MARK_URI__" alt="Nodecode"><div class="assistant-content"><div class="message-actions"><button class="copy-text" data-a="copyReply" data-p="' + index + '" aria-label="Copy reply and thought process" title="Copy reply and thought process">${icon('copy')}</button><span class="message-fork">'+forkHtml(part)+'</span></div>' + r + '<div class="reply-text">' + (part.text ? md(part.text) : '') + '</div><div class="reply-images">' + imageHtml(part) + '</div><span class="reply-caret">' + caret + '</span>' + '</div></div></div>';
    }
    if (part.kind === 'tool') return toolHtml(part.call);
    if (part.kind === 'system') return '<div class="sys ' + esc(part.level || 'info') + '">' + (part.childSessionId?'<button data-a="openThread" data-p="'+esc(part.childSessionId)+'">'+esc(part.text)+'</button>':esc(part.text)) + '</div>';
    return '';
  }
  function saveDraft(){ reconcileInlineReferences();persisted.sessions = persisted.sessions || {}; persisted.sessions[sessionId] = { draft: composer.value, inlineRefs:inlineRefs.map(function(ref){return {path:ref.path,start:ref.start,end:ref.end};}),files:files.slice(), images:attachments, textFiles:textFiles.map(function(f){return {requestId:f.requestId,name:f.name,text:f.text,byteLength:f.byteLength,attachment:f.attachment,error:f.error};}), expanded: expanded, visibleStart:visibleStart, historyExpanded:historyExpanded, scrollTop: scrollBox.scrollTop }; vscode.setState(persisted); }
  function hasSelection(pane){
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    return selection.getRangeAt(0).intersectsNode(pane);
  }
  function atTail(pane, margin){ return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= margin; }
  function setFollow(pane, follow){
    pane._follow = follow;
    if (pane === scrollBox) followLatest = follow;
  }
  function trackFollow(pane, margin){
    if (pane._tracked) return;
    pane._tracked = true;
    pane._margin = margin;
    pane._lastTop = pane.scrollTop;
    pane._lastHeight = pane.clientHeight;pane._lastScrollHeight = pane.scrollHeight;
    setFollow(pane, true);
    pane.addEventListener('wheel', function(ev){
      if (ev.ctrlKey) return;
      pane._userScrollIntent=true;
      if (pane === scrollBox && ev.target.closest('.rbody')) return;
      if (ev.deltaY < 0) setFollow(pane, false);
      else if (ev.deltaY > 0 && atTail(pane, margin)) setFollow(pane, true);
    }, {passive:true});
    pane.addEventListener('keydown', function(ev){
      if (pane === scrollBox && ev.target.closest('.rbody')) return;
      if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(ev.key))pane._userScrollIntent=true;
      if (['ArrowUp','PageUp','Home'].includes(ev.key)) setFollow(pane, false);
    });
    pane.addEventListener('pointerdown', function(){ pane._interacting = true;pane._userScrollIntent=true; });
    var touchY;
    pane.addEventListener('touchstart',function(ev){touchY=ev.touches[0]&&ev.touches[0].clientY;},{passive:true});
    pane.addEventListener('touchmove',function(ev){
      if(pane===scrollBox&&ev.target.closest('.rbody'))return;
      pane._userScrollIntent=true;
      var nextY=ev.touches[0]&&ev.touches[0].clientY;
      if(touchY!==undefined&&nextY!==undefined){if(nextY>touchY)setFollow(pane,false);else if(nextY<touchY&&atTail(pane,margin))setFollow(pane,true);}
      touchY=nextY;
    },{passive:true});
    pane.addEventListener('scroll', function(){
      // A delayed scroll event from our own write or content growth is not intent.
      captureFollow(pane);
    }, {passive:true});
  }
  function captureFollow(pane){
    if (!pane.clientHeight) return;
    var delta = pane.scrollTop - pane._lastTop;
    var layoutChanged=pane.clientHeight!==pane._lastHeight||pane.scrollHeight!==pane._lastScrollHeight;
    pane._readerMoved=Math.abs(delta)>1&&(!layoutChanged||pane._userScrollIntent);
    pane._userScrollIntent=false;
    var clampedByLayout = pane._follow && !pane._interacting && atTail(pane,pane._margin) && (pane.clientHeight!==pane._lastHeight || pane.scrollHeight<pane._lastScrollHeight);
    if (Math.abs(delta) > 1 && !clampedByLayout) setFollow(pane, delta > 0 && atTail(pane, pane._margin));
    pane._lastTop = pane.scrollTop;pane._lastHeight=pane.clientHeight;pane._lastScrollHeight=pane.scrollHeight;
  }
  function updateThoughtSize(){
    var cap=Math.max(0,scrollBox.clientHeight/3)+'px';
    if(document.documentElement.style.getPropertyValue('--thought-cap')===cap)return;
    document.documentElement.style.setProperty('--thought-cap',cap);
    transcript.querySelectorAll('.rbody').forEach(function(pane){followPane(pane);pane._lastTop=pane.scrollTop;});
  }
  function followPane(pane){
    if (!pane.clientHeight || !pane._follow || pane._interacting || hasSelection(pane)) return;
    pane.scrollTop = pane.scrollHeight;
    pane._lastTop = pane.scrollTop;pane._lastHeight=pane.clientHeight;pane._lastScrollHeight=pane.scrollHeight;
  }
  function updateThought(body, text){
    trackFollow(body, 4);
    captureFollow(body);
    var current = body.textContent;
    if (current !== text) {
      // Append to the same text node so an existing selection remains intact.
      if (text.startsWith(current) && body.firstChild) body.firstChild.appendData(text.slice(current.length));
      else if (!hasSelection(body)) body.textContent = text;
    }
    followPane(body);
  }
  function updateAssistant(node, part, index){
    node.querySelector('.msg.assistant').classList.toggle('voided',!!part.voided);
    var bubble = node.querySelector('.bubble');
    var fork=bubble.querySelector('.message-fork'),forkMarkup=forkHtml(part);if(fork&&node._forkMarkup!==forkMarkup){fork.innerHTML=forkMarkup;node._forkMarkup=forkMarkup;}
    var thought = bubble.querySelector('.reasoning');
    if (part.reasoning && !thought) {
      var template = document.createElement('div'); template.innerHTML = partHtml(part, index);
      thought = template.querySelector('.reasoning');
      thought.open = expanded[thought.dataset.detail] !== undefined ? expanded[thought.dataset.detail] : !!part.streaming;
      bubble.querySelector('.assistant-content').insertBefore(thought, bubble.querySelector('.reply-text'));
    }
    if (thought && part.reasoning) {
      var label = thought.querySelector('.reasoning-label'), text = part.streaming && !part.text ? 'Thinking…' : 'Thought process';
      if (label.textContent !== text && !hasSelection(label)) label.textContent = text;
      updateThought(thought.querySelector('.rbody'), part.reasoning);
    } else if (thought && !hasSelection(thought)) thought.remove();
    var reply = bubble.querySelector('.reply-text');
    if (node._text !== part.text && !hasSelection(reply)) {
      var codePositions = Array.from(reply.querySelectorAll('.codeblock pre')).map(function(pre){return [pre.scrollTop, pre.scrollLeft];});
      reply.innerHTML = part.text ? md(part.text) : ''; renderMarkdownBlocks(reply); node._text = part.text;
      reply.querySelectorAll('.codeblock pre').forEach(function(pre, i){var pos=codePositions[i];if(pos){pre.scrollTop=pos[0];pre.scrollLeft=pos[1];}});
    }
    var images = JSON.stringify(part.images || []);
    if (node._images !== images) { bubble.querySelector('.reply-images').innerHTML = imageHtml(part); node._images = images; }
    bubble.querySelector('.reply-caret').innerHTML = part.streaming ? '<span class="caret"></span>' : '';
  }
  function rememberReadingAnchor(){
    if(followLatest||firstRender){readingAnchor=null;return;}
    var node=Array.from(transcript.children).find(function(row){return row.getBoundingClientRect().bottom>scrollBox.getBoundingClientRect().top;});
    readingAnchor=node?{node:node,offset:node.getBoundingClientRect().top-scrollBox.getBoundingClientRect().top}:null;
  }
  function restoreReadingAnchor(){
    if(followLatest){followPane(scrollBox);return;}
    if(!readingAnchor||!readingAnchor.node.isConnected||scrollBox._interacting)return;
    var delta=readingAnchor.node.getBoundingClientRect().top-scrollBox.getBoundingClientRect().top-readingAnchor.offset;
    if(Math.abs(delta)>.1)scrollBox.scrollTop+=delta;
    scrollBox._lastTop=scrollBox.scrollTop;
  }
  function renderTranscript(parts){
    var oldTop = scrollBox.scrollTop;
    var anchor = Array.from(transcript.children).find(function(node){return node.getBoundingClientRect().bottom>scrollBox.getBoundingClientRect().top;});
    var anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
    transcript.querySelectorAll('[data-detail]').forEach(function(el){
      expanded[el.dataset.detail] = el.open;
      el.querySelectorAll('pre:not(.rbody)').forEach(function(pane, i){ paneScroll[el.dataset.detail + '-' + i] = [pane.scrollTop, pane.scrollLeft]; });
    });
    if (!parts.length) {
      visibleStart=null;E('historyEarlier').classList.add('hidden');
      var welcome = '<div class="welcome"><img src="__MARK_URI__" alt="Nodecode axolotl"><h1>Build with nodecode.</h1><p>Your workspace, a conversation, and room to think.</p><small>Ask a question, make a change, or explore an idea.</small></div>';
      if (transcript.dataset.empty !== 'true') transcript.innerHTML = welcome;
      transcript.dataset.empty = 'true';
      return;
    }
    if (transcript.dataset.empty === 'true') transcript.innerHTML = '';
    transcript.dataset.empty = 'false';
    if(visibleStart===null)visibleStart=Number.isInteger(saved.visibleStart)?Math.max(0,Math.min(saved.visibleStart,parts.length-1)):Math.max(0,parts.length-150);
    if(visibleStart>=parts.length)visibleStart=Math.max(0,parts.length-150);
    if(!historyExpanded&&followLatest&&!hasSelection(transcript))visibleStart=Math.max(0,parts.length-150);
    if(followLatest&&!hasSelection(transcript)&&parts.length-visibleStart>600)visibleStart=Math.max(0,parts.length-400);
    E('historyEarlier').classList.toggle('hidden',visibleStart===0);
    var existing=new Map(Array.from(transcript.children).map(function(node){return [node._partIndex,node];}));
    parts.slice(visibleStart).forEach(function(part, offset){
      var i=visibleStart+offset;
      var html = partHtml(part, i);
      var node = existing.get(i);
      if (!node) { node = document.createElement('section');node._partIndex=i; }
      if(transcript.children[offset]!==node)transcript.insertBefore(node,transcript.children[offset]||null);
      if (part.kind === 'assistant' && node._kind === 'assistant') {
        updateAssistant(node, part, i);
      } else if (node._html !== html && !hasSelection(node)) {
        var codePositions = Array.from(node.querySelectorAll('.codeblock pre')).map(function(pre){return [pre.scrollTop, pre.scrollLeft];});
        node.innerHTML = html; renderMarkdownBlocks(node);
        node.querySelectorAll('.codeblock pre').forEach(function(pre, n){var pos=codePositions[n];if(pos){pre.scrollTop=pos[0];pre.scrollLeft=pos[1];}});
        if (part.kind === 'assistant') {
          var thought = node.querySelector('.reasoning');
          if (thought) {
            thought.open = expanded[thought.dataset.detail] !== undefined ? expanded[thought.dataset.detail] : !!part.streaming;
            updateThought(thought.querySelector('.rbody'), part.reasoning);
          }
          node._text = part.text; node._images = JSON.stringify(part.images || []);
        }
        node._html = html; node._kind = part.kind;
      }
    });
    Array.from(transcript.children).forEach(function(node){if(node._partIndex<visibleStart||node._partIndex>=parts.length)node.remove();});
    transcript.querySelectorAll('[data-detail]:not(.reasoning)').forEach(function(el){
      el.open = !!expanded[el.dataset.detail];
      el.querySelectorAll('pre').forEach(function(pane, i){ var pos = paneScroll[el.dataset.detail + '-' + i]; if (pos) { pane.scrollTop = pos[0]; pane.scrollLeft = pos[1]; } });
    });
    scrollBox.scrollTop = anchor && anchor.isConnected && !followLatest ? oldTop+anchor.getBoundingClientRect().top-anchorTop : oldTop;
    scrollBox._lastTop = scrollBox.scrollTop;
  }
  function editSessionName(button, id){
    var original = button.querySelector('span') ? button.querySelector('span').textContent : button.textContent;
    var input = document.createElement('input'); input.className = 'session-rename-input'; input.value = original; input.setAttribute('aria-label','Session name');
    var finished = false;
    function finish(commit){
      if(finished)return;finished=true;var name=input.value.trim();input.replaceWith(button);
      if(commit && name && name!==original)vscode.postMessage({type:'renameSession',sessionId:id,name:name});
      button.focus();
    }
    input.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();finish(ev.key==='Enter');}});
    input.addEventListener('blur',function(){finish(false);});
    button.replaceWith(input);input.focus();input.select();
  }
  E('title').addEventListener('click',function(){
    var input=E('titleInput'),original=titleEl.textContent;input.value=original;titleEl.classList.add('hidden');input.classList.remove('hidden');input.focus();input.select();
  });
  function finishTitleEdit(commit){
    var input=E('titleInput');if(input.classList.contains('hidden'))return;
    var name=input.value.trim();input.classList.add('hidden');titleEl.classList.remove('hidden');
    if(commit&&name&&name!==titleEl.textContent)vscode.postMessage({type:'renameSession',sessionId:sessionId,name:name});
  }
  E('titleInput').addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();finishTitleEdit(ev.key==='Enter');titleEl.focus();}});
  E('titleInput').addEventListener('blur',function(){finishTitleEdit(true);});
  function closeSessions(restoreFocus){
    clearTimeout(historyTimer);historyRequest++;
    E('sessionPicker').classList.add('hidden'); E('sessBtn').setAttribute('aria-expanded', 'false');
    saveHistoryBrowser();
    if (restoreFocus) E('sessBtn').focus();
  }
  function requestHistory(){
    if(E('sessionPicker').classList.contains('hidden'))return;
    var query=E('sessionSearch').value.trim(),requestId=++historyRequest;
    E('sessionSearchStatus').textContent=query?'Searching messages…':'Loading sessions…';
    vscode.postMessage({type:'requestSessions',query:query,requestId:requestId});
  }
  function renderSessionChoices(message){
    if(message.requestId!==undefined && message.requestId!==historyRequest)return;
    var box = E('sessionChoices');
    if (message.error) {E('sessionSearchStatus').textContent=message.error;return;}
    var rows = message.sessions || [];historyLast=rows;
    if(!message.query)historyRows=rows;
    E('sessionSearchStatus').textContent=message.query ? rows.length+' conversations · content results capped at 60 matches' : '';
    box.innerHTML = rows.length ? historyTree(rows,historyMode).map(function(entry){var row=entry.row;
      var title = row.semanticTitle || (row.semantic_summary || {}).title || row.title || (row.prompt || '').replace(/\s+/g, ' ').slice(0,60) || 'Untitled conversation';
      var detail = row.working_directory || (historyMode==='lineage'?'':historyKind(entry));
      return '<div class="session-row"'+(historyMode==='lineage'?' data-depth="'+entry.depth+'" style="--history-depth:'+entry.depth+'"':'')+'><button class="session-choice" data-a="chooseSession" data-p="'+esc(row.id)+'" aria-current="'+String(row.id===sessionId)+'" title="'+esc(title)+'"><span>'+esc(title)+'</span>'+(historyMode==='lineage'?'<span class="session-lineage">'+(entry.orphan||entry.cycle?'':'Level '+entry.depth+' · ')+esc(historyKind(entry))+'</span>':'')+'<span class="sub">'+esc(detail)+'</span>'+(row.matchSnippet?'<span class="session-match">'+esc(row.matchSnippet)+'</span>':'')+'</button><button class="session-rename" data-a="renameSession" data-p="'+esc(row.id)+'" aria-label="Rename '+esc(title)+'" title="Rename conversation">${icon('edit')}</button><button class="session-delete" data-a="deleteSession" data-p="'+esc(row.id)+'" aria-label="Delete '+esc(title)+'" title="Delete conversation">×</button></div>';
    }).join('') : '<div class="picker-message">'+(E('sessionSearch').value.trim()?'No matching conversations.':'No conversations yet.')+'</div>';
    if(historyRestoreScroll){box.scrollTop=historyRestoreScroll;historyRestoreScroll=0;}
    saveHistoryBrowser();
  }
  function saveHistoryBrowser(){var value={open:!E('sessionPicker').classList.contains('hidden'),query:E('sessionSearch').value,mode:historyMode,scroll:E('sessionChoices').scrollTop};persisted.historyBrowser=value;vscode.setState(persisted);vscode.postMessage({type:'historyBrowserState',state:value});}
  function restoreHistory(value){if(!value)return;if(value.open&&!E('sessionPicker').classList.contains('hidden')&&historyRequest>0&&E('sessionSearch').value===value.query&&historyMode===value.mode)return;historyMode=value.mode==='recent'?'recent':'lineage';E('sessionSearch').value=typeof value.query==='string'?value.query:'';historyRestoreScroll=Number(value.scroll)||0;document.querySelectorAll('[data-history-mode]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.historyMode===historyMode));});if(value.open){E('sessionPicker').classList.remove('hidden');E('sessBtn').setAttribute('aria-expanded','true');requestHistory();}else{E('sessionPicker').classList.add('hidden');E('sessBtn').setAttribute('aria-expanded','false');}}
  document.querySelectorAll('[data-history-mode]').forEach(function(button){button.addEventListener('click',function(){historyMode=button.dataset.historyMode;document.querySelectorAll('[data-history-mode]').forEach(function(b){b.setAttribute('aria-pressed',String(b===button));});renderSessionChoices({query:E('sessionSearch').value,sessions:historyLast});});});
  E('sessionChoices').addEventListener('scroll',saveHistoryBrowser,{passive:true});
  E('sessBtn').setAttribute('aria-controls','sessionPicker');
  E('sessBtn').setAttribute('aria-expanded','false');
  E('sessBtn').addEventListener('click',function(){
    if (!E('sessionPicker').classList.contains('hidden')) {closeSessions(true);return;}
    E('sessionPicker').classList.remove('hidden');E('sessBtn').setAttribute('aria-expanded','true');
    E('sessionChoices').innerHTML='';saveHistoryBrowser();
    E('sessionSearch').focus();requestHistory();
  });
  E('sessionSearch').addEventListener('input',function(){
    clearTimeout(historyTimer);historyRequest++;saveHistoryBrowser();
    var query=this.value.trim().toLowerCase(),tokens=query.split(/\s+/).filter(Boolean);
    renderSessionChoices({query:query,sessions:historyRows.filter(function(row){var text=[row.title,row.semanticTitle,row.prompt,row.working_directory].filter(Boolean).join(' ').toLowerCase();return tokens.every(function(token){return text.includes(token);});})});
    E('sessionSearchStatus').textContent=query?'Searching messages…':'Loading sessions…';
    historyTimer=setTimeout(requestHistory,180);
  });
  E('sessionSearch').addEventListener('keydown',function(ev){if(ev.key==='ArrowDown'){var first=E('sessionChoices').querySelector('button');if(first){ev.preventDefault();first.focus();}}});
  E('closeSessions').addEventListener('click',function(){closeSessions(true);});
  document.addEventListener('click',function(ev){if(!ev.composedPath().includes(E('sessionPickerWrap')))closeSessions(false);});
  function chip(label, action, payload, actionLabel){
    return '<span class="chip"><span class="cmd">' + esc(label) + '</span><button data-a="' + action + '" data-p="' + esc(payload) + '">' + actionLabel + '</button></span>';
  }
  function renderAll(stick){
    if(firstRender&&saved.scrollTop!==undefined)setFollow(scrollBox,false);
    captureFollow(scrollBox);
    if(scrollBox._readerMoved)rememberReadingAnchor();
    // Reconcile reflow before rendering; ResizeObserver may not have run yet.
    restoreReadingAnchor();
    updateThoughtSize();
    restoreReadingAnchor();
    stick = followLatest;
    var view = state.view || {};
    var parts = view.parts || [];
    titleEl.textContent = view.title || 'Untitled conversation';
    titleEl.title = [view.title || 'Untitled conversation', view.cwd, 'Click to rename'].filter(Boolean).join('\n');
    var line = [];
    if (view.provider || view.model) line.push([view.provider, view.model].filter(Boolean).join('/'));
    if (view.effort) line.push('effort ' + view.effort);
    if (state.connection !== 'connected') line.push(state.connection === 'failed' ? 'connection failed' : 'reconnecting (' + state.attempts + ')');
    modelEl.textContent = '';
    modelEl.title = line.join(' · ');
    E('modelLabel').textContent = view.model || 'Choose model';
    E('effortLabel').textContent = view.effort || 'Effort';
    var replayReady=view.replayComplete!==false;
    if(replayReady)renderTranscript(parts);
    renderActivity(view);
    var q = view.queue || [];
    queueBar.innerHTML = q.map(function(p){
      var label = (p.content || p.prompt_id || '').slice(0, 120);
      return chip(label, 'withdraw', p.prompt_id, '&#10005; withdraw');
    }).join('');
    var sline = [];
    var t = view.totals || {};
    if (t.costKnown) sline.push('$' + (t.costUsd || 0).toFixed(4));
    if (t.output) sline.push((t.output || 0) + ' out / ctx ' + formatContextCount(t.input || 0));
    var savedState=view.standby===true?(view.parentId?'Draft fork':'Draft'):view.standby===false?'Saved':'';
    var status = state.connection === 'connected' ? (sending ? 'Sending…' : view.running ? 'Working' : 'Ready') : state.connection;
    statusLine.innerHTML = '<span class="connection ' + (state.connection === 'connected' ? '' : 'offline') + '"' + (view.activeTurnId ? ' title="Turn ID: ' + esc(view.activeTurnId) + '"' : '') + '>' + esc(status) + '</span><span title="'+(t.output?'Context: '+esc(new Intl.NumberFormat().format(t.input||0))+' tokens':'')+'">' + (savedState?'<span class="save-state" title="'+(view.standby?'Waiting for the first durable content; draft state is kept separately.':'Conversation history is recorded by Nodecode.')+'">'+savedState+'</span>'+ (sline.length?' · ':''):'') + esc(sline.join(' · ')) + '</span>';
    var steerable = view.activeTurnSteerable && view.activeTurnId;
    steerBtn.className = steerable ? ('mode' + (steerMode ? ' steering' : '')) : 'mode hidden';
    steerBtn.setAttribute('aria-pressed', String(steerMode));
    cancelBtn.className = view.running ? 'icon-btn' : 'icon-btn hidden';
    if (!steerable) steerMode = false;
    sendBtn.disabled = sending || pendingReads>0 || textFiles.some(function(f){return !f.attachment||f.error;}) || (!composer.value.trim() && !attachments.length && !files.length && !textFiles.length) || state.connection !== 'connected';
    E('attachBtn').disabled = sending;
    sendBtn.title = sending ? 'Sending…' : 'Send message';
    if (replayReady && firstRender && saved.scrollTop !== undefined) { scrollBox.scrollTop = saved.scrollTop; scrollBox._lastTop = scrollBox.scrollTop; setFollow(scrollBox, atTail(scrollBox, 120)); }
    else if (replayReady && stick) followPane(scrollBox);
    if(replayReady)firstRender = false;
    rememberReadingAnchor();
    E('jumpBtn').classList.toggle('hidden', nearBottom());
  }

  function send(){
    reconcileInlineReferences();var text = composer.value.trim();
    if ((!text && !attachments.length && !files.length && !textFiles.length) || pendingReads>0 || textFiles.some(function(f){return !f.attachment||f.error;}) || sending || state.connection !== 'connected') return;
    if(text.startsWith('/')){runSlashLine(text);return;}
    var view = state.view || {};
    var msg = { type: 'send', text: text, files:files.slice(), textFiles:textFiles.map(function(f){return f.attachment.ref;}), images: attachments.map(function(a){return {mediaType:a.mediaType,data:a.data};}) };
    if (steerMode && view.activeTurnSteerable && view.activeTurnId) {
      msg.mode = 'steer';
      msg.turnId = view.activeTurnId;
    }
    sending = true;
    closeFilePicker();
    renderAll(nearBottom());
    histIdx = -1;
    steerMode = false;
    vscode.postMessage(msg);
  }
  function grow(){
    composer.style.height = 'auto';
    composer.style.height = Math.min(180, composer.scrollHeight) + 'px';
  }
  sendBtn.addEventListener('click', function(ev){ev.stopPropagation();closeSessions(false);send();});
  cancelBtn.addEventListener('click', function(){ vscode.postMessage({ type: 'cancel' }); });
  steerBtn.addEventListener('click', function(){ steerMode = !steerMode; renderAll(nearBottom()); composer.focus(); });
  ${MODEL_CLIENT_JS}
  var caretMirror=document.createElement('div');caretMirror.id='composerCaretMirror';caretMirror.setAttribute('aria-hidden','true');document.body.appendChild(caretMirror);
  function positionFilePicker(){
    if(!fileQuery||E('filePicker').classList.contains('hidden'))return;
    var box=composer.getBoundingClientRect(),style=getComputedStyle(composer),picker=E('filePicker');
    caretMirror.style.cssText='position:fixed;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;height:auto;';
    ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','wordSpacing','textIndent','tabSize','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth'].forEach(function(key){caretMirror.style[key]=style[key];});
    caretMirror.style.left=box.left+'px';caretMirror.style.top=box.top+'px';caretMirror.style.width=(composer.clientWidth+parseFloat(style.borderLeftWidth||0)+parseFloat(style.borderRightWidth||0))+'px';
    caretMirror.textContent=composer.value.slice(0,composer.selectionStart);
    var marker=document.createElement('span');marker.textContent='\u200b';caretMirror.appendChild(marker);
    var caret=marker.getBoundingClientRect(),lineHeight=parseFloat(style.lineHeight)||20;
    var x=caret.left-composer.scrollLeft,y=caret.top-composer.scrollTop;
    picker.style.visibility=y<box.top-1||y>box.bottom-lineHeight+2?'hidden':'visible';
    var width=Math.min(320,window.innerWidth-16),below=Math.min(window.innerHeight,box.bottom)-y-lineHeight-8,above=y-8;
    var useBelow=below>=Math.min(100,picker.scrollHeight)||below>=above;
    var available=Math.max(32,useBelow?below:above),height=Math.min(180,available,picker.scrollHeight+picker.offsetHeight-picker.clientHeight);
    picker.style.width=width+'px';picker.style.maxHeight=Math.min(180,available)+'px';
    picker.style.left=Math.max(8,Math.min(x,window.innerWidth-width-8))+'px';
    picker.style.top=Math.max(8,Math.min(useBelow?y+lineHeight+3:y-height-3,window.innerHeight-height-8))+'px';
  }
  function closeFilePicker(){fileQuery=null;fileRequest++;clearTimeout(fileTimer);E('filePicker').classList.add('hidden');composer.removeAttribute('aria-activedescendant');composer.setAttribute('aria-expanded','false');}
  function renderFileReferences(){reconcileInlineReferences();E('fileReferences').textContent='';}
  function renderFileResults(message){
    fileResults=message.files||[];fileIndex=0;
    E('filePicker').innerHTML=message.error ? '<div class="picker-message">'+esc(message.error)+'</div>' : fileResults.length ? fileResults.map(function(file,i){return '<button type="button" id="file-option-'+i+'" class="file-option" role="option" aria-selected="'+String(i===0)+'" data-file="'+i+'" title="'+esc(file.path)+'">'+esc(file.path)+(file.description?'<span class="sub">'+esc(file.description)+'</span>':'')+'</button>';}).join('') : '<div class="picker-message">No matching workspace files</div>';
    if(fileResults.length)composer.setAttribute('aria-activedescendant','file-option-0');
    positionFilePicker();
  }
  function updateFileQuery(){
    if(sending || composer.selectionStart!==composer.selectionEnd){closeFilePicker();return;}
    var before=composer.value.slice(0,composer.selectionStart);if(updateSlashQuery(before))return;E('filePicker').setAttribute('aria-label','Workspace files');var match=before.match(/(?:^|\s)@([^\s@]*)$/);
    if(!match){closeFilePicker();return;}
    fileQuery={start:before.lastIndexOf('@'),end:composer.selectionStart,text:match[1]};
    var request=++fileRequest;clearTimeout(fileTimer);fileResults=[];E('filePicker').classList.remove('hidden');composer.setAttribute('aria-expanded','true');E('filePicker').innerHTML='<div class="picker-message">Finding files…</div>';
    positionFilePicker();
    fileTimer=setTimeout(function(){vscode.postMessage({type:'searchFiles',query:fileQuery.text,requestId:request});},100);
  }
  function chooseFile(index){
    if(sending)return;
    var file=fileResults[index];if(!file||!fileQuery)return;
    if(file.kind==='slash'){composer.value=file.value+composer.value.slice(composer.selectionStart);composer.setSelectionRange(file.value.length,file.value.length);closeFilePicker();grow();saveDraft();renderAll(followLatest);composer.focus();return;}
    var before=composer.value.slice(0,composer.selectionStart),current=before.match(/(?:^|\s)@([^\s@]*)$/);
    if(!current){closeFilePicker();return;}
    fileQuery={start:before.lastIndexOf('@'),end:composer.selectionStart,text:current[1]};
    if(files.length>=8 && !files.includes(file.path)){E('attachmentError').textContent='Attach at most eight files.';E('attachmentError').classList.remove('hidden');return;}
    reconcileInlineReferences();
    var start=fileQuery.start,token='@'+file.path,tail=composer.value.slice(fileQuery.end),separator=/^\s/.test(tail)?'':' ';
    composer.value=composer.value.slice(0,start)+token+separator+tail;
    reconcileInlineReferences();inlineRefs.push({path:file.path,start:start,end:start+token.length});referenceText=composer.value;files=Array.from(new Set(inlineRefs.map(function(ref){return ref.path;})));
    var caret=start+token.length+(separator.length||tail.startsWith(' ')?1:0);composer.setSelectionRange(caret,caret);
    closeFilePicker();renderFileReferences();grow();saveDraft();renderAll(followLatest);composer.focus();
  }
  composer.setAttribute('aria-controls','filePicker');composer.setAttribute('aria-autocomplete','list');composer.setAttribute('aria-expanded','false');
  E('filePicker').addEventListener('mousedown',function(ev){ev.preventDefault();});
  E('filePicker').addEventListener('click',function(ev){var option=ev.target.closest('[data-file]');if(option)chooseFile(Number(option.dataset.file));});
  composer.addEventListener('click',updateFileQuery);
  composer.addEventListener('scroll',positionFilePicker,{passive:true});
  window.addEventListener('resize',positionFilePicker);
  composer.addEventListener('keyup',function(ev){if(['ArrowLeft','ArrowRight','Home','End'].includes(ev.key))updateFileQuery();});
  document.addEventListener('click',function(ev){if(!E('composerBar').contains(ev.target))closeFilePicker();});
  function renderTextFiles(){
    E('textAttachments').innerHTML=textFiles.map(function(file){var status=file.error?'failed':file.attachment?Math.ceil(file.byteLength/1024)+' KiB':'preparing…';return '<span class="text-attachment '+(file.error?'failed':'')+'"><button class="text-file-open" data-a="openTextAttachment" data-p="'+esc(file.attachment?file.attachment.ref:'')+'" '+(!file.attachment?'disabled':'')+' title="'+esc(file.error||(file.attachment&&file.attachment.origin?file.attachment.origin+': ':'')+(file.attachment&&file.attachment.originalPath||file.name))+'">'+esc(file.name)+'</button><span class="sub">'+status+'</span>'+(file.error?'<button data-a="retryTextAttachment" data-p="'+file.requestId+'">Retry</button>':'')+'<button data-a="removeTextAttachment" data-p="'+file.requestId+'" aria-label="Remove '+esc(file.name)+'">×</button></span>';}).join('');
  }
  function splitText(text){var chunks=[];for(var i=0;i<text.length;){var end=Math.min(i+64000,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;chunks.push(text.slice(i,end));i=end;}return chunks;}
  function sendTextChunk(file,index){vscode.postMessage({type:'stageTextChunk',requestId:file.requestId,index:index,totalChunks:file.chunks.length,name:file.name,text:file.chunks[index]});}
  function stageTextFile(file){file.error=undefined;file.requestId=++textRequest;file.chunks=splitText(file.text||'');renderTextFiles();saveDraft();if(file.chunks.length)sendTextChunk(file,0);}
  function addTextFile(text,name){
    var bytes=new TextEncoder().encode(text).length;
    if(!text||text.includes('\0')||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text))throw new Error('Choose a non-empty UTF-8 text file.');
    if(textFiles.length>=4||bytes+textFiles.reduce(function(n,f){return n+f.byteLength;},0)>8*1024*1024)throw new Error('Attach at most four text files, 8 MiB total.');
    var file={name:name,byteLength:bytes,text:text};textFiles.push(file);stageTextFile(file);
  }
  function receiveTextChunk(message){
    var file=textFiles.find(function(f){return f.requestId===message.requestId;});if(!file)return;
    if(message.error){file.error=message.error;renderTextFiles();saveDraft();renderAll(followLatest);return;}
    if(message.attachment){file.attachment=message.attachment;file.name=message.attachment.name;file.byteLength=message.attachment.byteLength;file.text=undefined;file.chunks=undefined;}
    else if(file.chunks&&message.index+1<file.chunks.length)sendTextChunk(file,message.index+1);
    renderTextFiles();saveDraft();renderAll(followLatest);
  }
  function attachLongDraft(){if(sending||composer.value.length<32000)return;try{addTextFile(composer.value,'pasted-text-'+(++textFileCount)+'.txt');composer.value='';grow();saveDraft();}catch(error){E('attachmentError').textContent=error.message;E('attachmentError').classList.remove('hidden');}}
  renderTextFiles();
  function renderAttachments(){
    E('attachments').innerHTML = attachments.map(function(a, i){return '<span class="attachment" title="'+esc((a.origin?a.origin+': ':'')+(a.originalPath||a.name))+'"><img src="data:' + a.mediaType + ';base64,' + a.data + '" alt="' + esc(a.name) + '"><button data-a="removeImage" data-p="' + i + '" title="Remove ' + esc(a.name) + '" aria-label="Remove image">×</button></span>';}).join('');
  }
  async function attachFiles(files){
    if (sending) return;
    pendingReads++;renderAll(followLatest);
    E('attachmentError').classList.add('hidden');
    try {
      for (var file of Array.from(files)) {
        if(!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type)){
          if(file.size>8*1024*1024)throw new Error('Text attachments must fit within 8 MiB.');
          var text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());addTextFile(text,file.name);continue;
        }
        if (!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type)) throw new Error('Choose PNG, JPEG, GIF or WebP images.');
        if (attachments.length >= 8) throw new Error('Attach at most eight images per message.');
        var size = attachments.reduce(function(n,a){return n+a.data.length;},0) + Math.ceil(file.size/3)*4 + composer.value.length;
        if(size > 15*1024*1024) throw new Error('Images and message must fit within 15 MB.');
        var url = await new Promise(function(resolve,reject){ var reader=new FileReader();reader.onload=function(){resolve(reader.result);};reader.onerror=function(){reject(new Error('Could not read image.'));};reader.readAsDataURL(file); });
        attachments.push({name:file.name || 'Pasted image',mediaType:file.type,data:url.slice(url.indexOf(',')+1)});
      }
    } catch(error) { E('attachmentError').textContent=error.message;E('attachmentError').classList.remove('hidden'); }
    finally {pendingReads--;}
    renderAttachments();renderAll(nearBottom());
  }
  ${ATTACHMENT_CLIENT_JS}
  E('imageInput').addEventListener('change',function(){void attachFiles(this.files);this.value='';});
  composer.addEventListener('paste',function(ev){var files=Array.from(ev.clipboardData.files);if(files.length){ev.preventDefault();void attachFiles(files);return;}var text=ev.clipboardData.getData('text/plain');if(text.length>=32000&&!sending){try{addTextFile(text,'pasted-text-'+(++textFileCount)+'.txt');ev.preventDefault();renderAll(followLatest);}catch(error){E('attachmentError').textContent=error.message;E('attachmentError').classList.remove('hidden');}}});
  E('composerBar').addEventListener('dragover',function(ev){if(Array.from(ev.dataTransfer.types).includes('Files'))ev.preventDefault();});
  E('composerBar').addEventListener('drop',function(ev){if(ev.dataTransfer.files.length){ev.preventDefault();void attachFiles(ev.dataTransfer.files);}});
  composer.value = saved.draft || '';
  if(!Array.isArray(saved.inlineRefs)&&Array.isArray(saved.files)){
    saved.files.filter(function(path){return typeof path==='string';}).slice(0,8).forEach(function(path){var separator=composer.value&&!/\s$/.test(composer.value)?' ':'';composer.value+=separator;var start=composer.value.length;composer.value+='@'+path+' ';inlineRefs.push({path:path,start:start,end:start+path.length+1});});
    referenceText=composer.value;
  }
  renderFileReferences();
  composer.addEventListener('beforeinput',function(ev){referenceEdit={text:composer.value,start:composer.selectionStart,end:composer.selectionEnd,type:ev.inputType||''};});
  composer.addEventListener('input', function(){ attachLongDraft();grow(); saveDraft(); updateFileQuery(); sendBtn.disabled = sending || pendingReads>0 || textFiles.some(function(f){return !f.attachment||f.error;}) || (!composer.value.trim() && !attachments.length && !files.length && !textFiles.length) || state.connection !== 'connected';
    E('attachBtn').disabled = sending; });
  trackFollow(scrollBox, 120);
  function releasePointer(){ scrollBox._interacting = false; document.querySelectorAll('.rbody,.process-output').forEach(function(pane){pane._interacting = false;}); }
  document.addEventListener('pointerup', releasePointer);
  document.addEventListener('pointercancel', releasePointer);
  window.addEventListener('blur', releasePointer);
  document.addEventListener('selectionchange', function(){ if (state.view && !hasSelection(transcript)) renderAll(followLatest); });
  function loadEarlier(){
    if(visibleStart===null||visibleStart===0)return;
    historyExpanded=true;setFollow(scrollBox,false);visibleStart=Math.max(0,visibleStart-100);renderAll(false);saveDraft();
  }
  E('historyEarlier').addEventListener('click',loadEarlier);
  scrollBox.addEventListener('scroll', function(){
    if (!firstRender) saveDraft();if(scrollBox._readerMoved)rememberReadingAnchor();E('jumpBtn').classList.toggle('hidden',nearBottom());
    if(!firstRender&&scrollBox._readerMoved&&!followLatest&&scrollBox.scrollTop<300&&visibleStart>0&&!loadingEarlier){loadingEarlier=true;requestAnimationFrame(function(){loadingEarlier=false;if(!followLatest&&scrollBox.scrollTop<300)loadEarlier();});}
  });
  E('jumpBtn').addEventListener('click', function(){ setFollow(scrollBox, true);renderAll(true);followPane(scrollBox); });
  transcript.addEventListener('toggle', function(ev){ if (ev.target.dataset.detail) { expanded[ev.target.dataset.detail] = ev.target.open; if (ev.target.open && ev.target.classList.contains('reasoning')) followPane(ev.target.querySelector('.rbody')); saveDraft(); } }, true);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(function(){ updateThoughtSize();restoreReadingAnchor(); }).observe(scrollBox);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(function(){ restoreReadingAnchor(); }).observe(transcript);
  composer.addEventListener('keydown', function(ev){
    if(ev.isComposing)return;
    if(fileQuery && !E('filePicker').classList.contains('hidden') && E('filePicker').style.visibility!=='hidden'){
      if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();closeFilePicker();return;}
      if((ev.key==='ArrowDown'||ev.key==='ArrowUp')&&fileResults.length){ev.preventDefault();fileIndex=(fileIndex+(ev.key==='ArrowDown'?1:-1)+fileResults.length)%fileResults.length;E('filePicker').querySelectorAll('[data-file]').forEach(function(el,i){el.setAttribute('aria-selected',String(i===fileIndex));});composer.setAttribute('aria-activedescendant','file-option-'+fileIndex);E('file-option-'+fileIndex).scrollIntoView({block:'nearest'});return;}
      if(ev.key==='Tab'&&!ev.shiftKey&&fileResults.length){ev.preventDefault();ev.stopPropagation();chooseFile(fileIndex);return;}
      if(ev.key==='Tab'){closeFilePicker();return;}
      if(ev.key==='Enter'&&!ev.shiftKey){ev.preventDefault();if(fileResults.length)chooseFile(fileIndex);return;}
    }
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
  document.body.addEventListener('mousedown',function(ev){if(ev.target.closest('.copy-text,.codeblock-copy'))ev.preventDefault();});
  document.body.addEventListener('click', function(ev){
    var el = ev.target.closest('[data-a]');
    if (!el) return;
    var action = el.getAttribute('data-a');
    if (!action) return;
    var payload = el.getAttribute('data-p');
    if(action==='openTextAttachment'){if(payload)vscode.postMessage({type:'openTextAttachment',ref:payload});}
    else if(action==='removeTextAttachment'){if(!sending){var file=textFiles.find(function(f){return f.requestId===Number(payload);});if(file){if(file.attachment)vscode.postMessage({type:'releaseTextAttachment',ref:file.attachment.ref});else vscode.postMessage({type:'cancelTextAttachment',requestId:file.requestId});textFiles=textFiles.filter(function(f){return f!==file;});renderTextFiles();saveDraft();renderAll(followLatest);}}}
    else if(action==='retryTextAttachment'){var file=textFiles.find(function(f){return f.requestId===Number(payload);});if(file)stageTextFile(file);}
    else if (action === 'removeImage') { if (!sending) { attachments.splice(Number(payload),1);renderAttachments();renderAll(nearBottom()); } } else if (action === 'copyReply' || action === 'copyThinking' || action === 'copyUser') {
      ev.preventDefault(); ev.stopPropagation();
      var part = (state.view.parts || [])[Number(payload)];
      if (part) {
        var text = action==='copyUser'?part.text: action === 'copyThinking' ? part.reasoning : (part.reasoning ? 'Thought process\n' + part.reasoning + '\n\n' : '') + part.text;
        NodecodeMarkdown.copyToClipboard(text, function(){var label=action==='copyUser'?'Copy message':action==='copyThinking'?'Copy thought process':'Copy reply and thought process';el.innerHTML='${icon('check')}';el.setAttribute('aria-label','Copied');setTimeout(function(){el.innerHTML='${icon('copy')}';el.setAttribute('aria-label',label);},1200);});
      }
    } else if(action==='toggleCheckpointBookmark'){if(!bookmarkingTurns[payload]){bookmarkingTurns[payload]=true;el.disabled=true;vscode.postMessage({type:'toggleCheckpointBookmark',turnId:payload});}} else if(action==='forkAtMessage'){if(!forkingTurns[payload]){forkingTurns[payload]=true;el.disabled=true;vscode.postMessage({type:'forkAtMessage',turnId:payload});}} else if (action === 'chooseSession') { saveHistoryBrowser(); vscode.postMessage({type:'openThread',sessionId:payload}); }
    else if (action === 'renameSession') { editSessionName(el.parentElement.querySelector('.session-choice'),payload); }
    else if (action === 'deleteSession') { vscode.postMessage({type:'deleteSession',sessionId:payload}); }
    else if (action === 'withdraw') vscode.postMessage({ type: 'withdraw', promptId: payload });
    else if (action === 'openThread') vscode.postMessage({ type: 'openThread', sessionId: payload });
    else if (action === 'openChangedFile') {ev.preventDefault();vscode.postMessage({type:'openFile',path:payload});}
    else if (action === 'interrupt') vscode.postMessage({ type: 'interrupt', execId: payload });
  });
  function closeImagePreview(){E('imagePreview').classList.add('hidden');E('imagePreviewContent').removeAttribute('src');composer.focus();}
  E('closeImagePreview').addEventListener('click',closeImagePreview);
  E('imagePreview').addEventListener('click',function(ev){if(ev.target===this)closeImagePreview();});
  document.addEventListener('click',function(ev){var image=ev.target.closest('.attachment img,.message-image');if(image){E('imagePreviewContent').src=image.src;E('imagePreview').classList.remove('hidden');E('closeImagePreview').focus();}});
  document.addEventListener('keydown',function(ev){if(ev.key==='Escape'&&!E('imagePreview').classList.contains('hidden')){ev.preventDefault();closeImagePreview();}});
  function wire(id, msg){
    E(id).addEventListener('click', function(){ E('menuWrap').open = false; vscode.postMessage({ type: msg }); });
  }
  wire('newBtn', 'newSession');
  wire('editorBtn', 'openInEditor');
  wire('termBtn', 'revealTerminal');
  wire('forkBtn', 'fork');
  wire('undoBtn', 'navigateUndo');
  wire('redoBtn', 'navigateRedo');
  wire('histBtn', 'checkpointHistory');


  wire('renameBtn', 'rename');
  wire('exportBtn', 'export');
  wire('refreshBtn', 'refresh');
  wire('delBtn', 'delete');
  E('websiteBtn').addEventListener('click',function(){E('menuWrap').open=false;vscode.postMessage({type:'openExternal',url:'https://nodecode.ai/'});});
  function dismissOverflowOutside(ev){var menu=E('menuWrap');if(menu.open&&!ev.composedPath().includes(menu))menu.open=false;}
  document.addEventListener('pointerdown',dismissOverflowOutside,true);
  document.addEventListener('click',dismissOverflowOutside,true);
  document.addEventListener('keydown', function(ev){ if (ev.key === 'Escape') {if(optionKind){ev.preventDefault();closeOptions(true);return;}if(E('menuWrap').open){ev.preventDefault();E('menuWrap').open=false;E('menuWrap').querySelector('summary').focus();return;}if(!E('sessionPicker').classList.contains('hidden')){ev.preventDefault();closeSessions(true);}} });
  renderAttachments();
  updateThoughtSize();
  grow();
  sendBtn.disabled = true;
  vscode.postMessage({ type: 'ready' });
  restoreHistory(persisted.historyBrowser);
  composer.focus();
  ${ACTIVITY_CLIENT_JS}
  ${SLASH_CLIENT_JS}
  ${RUNTIME_CLIENT_JS}
})();
`;

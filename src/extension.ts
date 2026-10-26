// Activation: wires the session commands, the per-session webview panel, the
// terminal shims and the status bar onto the controller/api/cli modules.
import * as path from "path";
import * as vscode from "vscode";

import { NodecodeApi } from "./api";
import { NodecodeCli, NODECODE_INSTALL_COMMAND, NODECODE_WINDOWS_INSTALL_COMMAND, RuntimeStatus } from "./cli";
import { NodecodeDiscovery, Notifications } from "./discovery";
import { SessionController, deleteSessionTree } from "./manager";
import { SessionPanel, SessionSidebar, type PanelCallbacks } from "./panel";
import { registerSessions, type CommandDeps } from "./sessions";
import { MAX_SELECTED_FILE_BYTES, MAX_SELECTED_TOTAL_BYTES, type SelectedFileInput } from "./file-browser";
import { readRuntimeMetadata } from "./runtime-metadata";

export function activate(context: vscode.ExtensionContext): void {
  const notes = new Notifications("Nodecode");
  const discovery = new NodecodeDiscovery(notes);
  const cli = new NodecodeCli(discovery, notes);
  const api = new NodecodeApi(discovery, notes);
  discovery.watch(context);

  // --- status bar: CLI + gateway state, click opens the session picker -----
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.name = "Nodecode";
  const reflect = (): void => {
    const endpoint = discovery.current();
    const binary = cli.resolve();
    statusItem.text = "$(chip) Nodecode";
    statusItem.command = "nodecode.openSessionPicker";
    statusItem.tooltip = new vscode.MarkdownString(
      [
        `**nodecode** v${cli.version || "unknown"}`,
        binary ? `binary \`${binary}\`` : "CLI not found — set nodecode.cliPath",
        endpoint
          ? `gateway up at \`${endpoint.baseUrl}\``
          : discovery.canRestore
            ? "gateway down (restorable via this extension)"
            : "gateway down",
      ].join("  \n"),
    );
    statusItem.show();
  };
  context.subscriptions.push(statusItem, discovery.onDidChange(reflect));

  // --- boot: pick a workspace once, ensure CLI + gateway, restart if fixable -
  let bootCwd: string | undefined;
  let bootPromise: Promise<void> | undefined;
  const boot = (): Promise<void> => {
    if (!bootPromise) bootPromise = doBoot();
    return bootPromise;
  };
  const doBoot = async (): Promise<void> => {
    if (!bootCwd) {
      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length === 1) {
        bootCwd = folders[0].uri.fsPath;
      } else if (folders && folders.length > 1) {
        const choice = await vscode.window.showQuickPick(
          folders.map((f) => ({ label: f.name, description: f.uri.fsPath })),
          { placeHolder: "Choose the folder for Nodecode sessions" },
        );
        bootCwd = choice?.description;
      }
    }
    const first = await cli.ensureReady();
    if (first !== "ok" && first.fixableByDaemon) {
      cli.ensureDaemon(true);
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    const again = await cli.ensureReady();
    if (again !== "ok") {
      notes.log(again.failure);
      reflect();
      return;
    }
    notes.log(`nodecode ready: v${cli.version || "?"}${bootCwd ? ` in ${bootCwd}` : ""}`);
    reflect();
  };
  void boot();
  reflect();

  // --- per-session controllers, outliving their panels ----------------------
  const controllers = new Map<string, SessionController>();
  const controllerFor: CommandDeps["controllerFor"] = (sessionId, opts) => {
    let controller = controllers.get(sessionId);
    if (!controller) {
      controller = new SessionController(cli, notes, api, bootCwd ?? "", sessionId, context.globalStorageUri?.scheme === "file" ? context.globalStorageUri.fsPath : undefined);
      controllers.set(sessionId, controller);
    }
    if (opts?.connect) controller.connect();
    return controller;
  };
  const forgetController: CommandDeps["forgetController"] = (sessionId) => {
    const controller = controllers.get(sessionId);
    if (controller) {
      controller.dispose();
      controllers.delete(sessionId);
    }
  };

  const workspaceRoot = (): string =>
    bootCwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  // One `nodecode resume SID` terminal per session; reveal reuses it.
  const revealTerminal: CommandDeps["revealTerminal"] = (sessionId: string) => {
    void (async () => {
      await boot();
      const binary = cli.resolve();
      if (!binary) {
        void vscode.window.showErrorMessage(
          "nodecode: CLI not found — install nodecode or set nodecode.cliPath.",
        );
        return;
      }
      const short = sessionId.length > 20 ? `${sessionId.slice(0, 20)}…` : sessionId;
      const name = `nodecode ${short}`;
      const existing = vscode.window.terminals.find(
        (t) => (t.creationOptions as { name?: string } | undefined)?.name === name,
      );
      if (existing) {
        existing.show();
        return;
      }
      const terminal = vscode.window.createTerminal({
        name,
        cwd: bootCwd,
        shellPath: binary,
        shellArgs: ["resume", sessionId],
      });
      terminal.show();
    })();
  };

  // --- panel callbacks: the webview's actions against real api/manager -------
  const runtimeStatus = async (): Promise<RuntimeStatus> => {
    const status = await cli.ensureReady();
    const common = {binary:cli.resolve(),installUrl:"https://nodecode.ai",installCommand:process.platform === "win32" ? NODECODE_WINDOWS_INSTALL_COMMAND : NODECODE_INSTALL_COMMAND};
    if (status !== "ok") return {...common,state:status.reason,message:status.failure,canRestart:false};
    const service = await api.service().catch(() => undefined);
    return {...common,state:"ready",message:`Nodecode ${cli.version} is ready.`,canRestart:service?.restart.able === true};
  };
  const waitForRuntime = async (previousPid?: number): Promise<void> => {
    const deadline = Date.now() + 20000;
    do {
      if (await discovery.probe()) {
        const service = await api.service().catch(() => undefined);
        if (service && (previousPid === undefined || service.pid !== previousPid)) return;
      }
      await new Promise((resolve) => setTimeout(resolve,250));
    } while (Date.now() < deadline);
    throw new Error("Nodecode did not become ready within 20 seconds. Check its logs and retry.");
  };
  let runtimeRestart: Promise<RuntimeStatus> | undefined;
  type ModelFavorite = {provider:string;model:string};
  let favoriteWrite: Promise<ModelFavorite[]> = Promise.resolve(context.globalState.get<ModelFavorite[]>("nodecode.modelFavorites", []));
  const panelCallbacks: PanelCallbacks = {
    pickLocalAttachments: async (): Promise<SelectedFileInput[]> => {
      const uris=await vscode.window.showOpenDialog({canSelectFiles:true,canSelectFolders:false,canSelectMany:true,openLabel:"Attach from this computer"});
      if(!uris)return [];
      if(uris.length>12)throw new Error("Choose up to twelve files.");
      const files:SelectedFileInput[]=[];let total=0;
      for(const uri of uris){
        const info=await vscode.workspace.fs.stat(uri);
        if(info.size>MAX_SELECTED_FILE_BYTES)throw new Error(`${path.basename(uri.path)} exceeds the 12 MiB file limit.`);
        const data=await vscode.workspace.fs.readFile(uri);total+=data.byteLength;
        if(total>MAX_SELECTED_TOTAL_BYTES)throw new Error("Selected files exceed 24 MiB. Attach a smaller group.");
        files.push({name:path.basename(uri.path),data,originalPath:uri.scheme==="file"?uri.fsPath:uri.toString()});
      }
      return files;
    },
    runtimeStatus,
    runtimeMetadata: () => readRuntimeMetadata(cli.resolve(), cli.version),
    retryRuntime: async () => {
      const status = await cli.ensureReady();
      if (status !== "ok" && status.reason === "gateway-unavailable") { cli.ensureDaemon(true); await waitForRuntime(); }
      bootPromise = undefined;
      await boot();
      const after = await runtimeStatus();
      if (after.state === "ready") for (const controller of controllers.values()) controller.connect();
      return after;
    },
    restartRuntime: () => {
      if (!runtimeRestart) runtimeRestart = (async () => {
        try {
          const service = await api.service();
          if (!service.restart.able) throw new Error(service.restart.text || "This Nodecode runtime cannot restart itself.");
          await api.restart();
          await waitForRuntime(service.pid);
          for (const controller of controllers.values()) controller.connect();
          return await runtimeStatus();
        } finally { runtimeRestart = undefined; }
      })();
      return runtimeRestart;
    },
    installRuntime: () => {
      const terminal = vscode.window.createTerminal({name:"Install Nodecode",...(process.platform === "win32" ? {shellPath:"powershell.exe"} : {})});
      terminal.show();
      terminal.sendText(process.platform === "win32" ? NODECODE_WINDOWS_INSTALL_COMMAND : NODECODE_INSTALL_COMMAND);
    },
    modelOptions: async (sid) => {
      const [catalog,target,header,auxiliary,decider,failover] = await Promise.all([api.models(),api.target(sid),api.header(sid),api.auxiliaryModel(),api.deciderModel(),api.failover()]);
      const models=Array.isArray(catalog)?catalog:catalog.models;
      const current=models.find((row)=>row.provider===target.provider&&row.model===target.model);
      await favoriteWrite;
      return {models,target,auxiliary,decider,failover,favorites:context.globalState.get<ModelFavorite[]>("nodecode.modelFavorites", []),context:{used:header.context_usage?.input,limit:current?.context}};
    },
    selectModel: async (sid,provider,model) => {
      const result=await api.setModel(sid,provider,model) as {shared_config_error?:string};
      if(result.shared_config_error)return `Model selected; new-session default could not be saved: ${result.shared_config_error}`;
    },
    selectEffort: async (sid,effort) => { await api.setEffort(sid,effort); },
    selectAuxiliary: (provider,model,effort) => api.setAuxiliaryModel(provider,model,effort),
    selectDecider: (provider,model) => api.setDeciderModel(provider,model),
    updateBackups: (update) => api.setFailover(update),
    testBackups: () => api.testFailover(),
    favoriteModel: (provider,model,starred) => {
      favoriteWrite = favoriteWrite.catch(() => context.globalState.get<ModelFavorite[]>("nodecode.modelFavorites", [])).then(async () => {
        const current=context.globalState.get<ModelFavorite[]>("nodecode.modelFavorites", []);
        const next=current.filter((item)=>item.provider!==provider||item.model!==model);
        if(starred)next.push({provider,model});
        await context.globalState.update("nodecode.modelFavorites",next);
        return next;
      });
      return favoriteWrite;
    },
    listSessions: async (query) => {
      const rows = query?.trim() ? await api.searchSessions(query) : await api.sessions();
      return query?.trim() ? rows : rows.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
    },
    searchFiles: async (query) => {
      const root = workspaceRoot();
      if (!root) return [];
      const literal = query.trim().slice(0, 512).replace(/[{}\[\]*?!\\]/g, "");
      const pattern = literal ? `**/*${literal.replace(/\s+/g, "*")}*` : "**/*";
      const matches = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, pattern),
        "**/{node_modules,.git,dist,out,.turbo,.next,coverage}/**", 40,
      );
      return matches.map((uri) => ({ path: path.relative(root, uri.fsPath).split(path.sep).join("/"), isDir: false as const }))
        .sort((a, b) => a.path.localeCompare(b.path));
    },
    openInEditor: (sid) => SessionPanel.createOrShow(context.extensionUri, controllerFor(sid, { connect: true }), panelCallbacks, notes),
    newSession: () => { void vscode.commands.executeCommand("nodecode.newSession"); },
    openSession: (sid) => openPanel(sid),
    forkAtMessage: async (sid, turnId) => {
      const forked = await controllerFor(sid).forkAtMessage(turnId);
      SessionPanel.createOrShow(context.extensionUri, controllerFor(forked, {connect:true}), panelCallbacks, notes);
    },
    forkSession: (sid) =>
      void (async () => {
        const forked = await api.forkSession(sid, undefined, bootCwd);
        if (forked) {
          openPanel(forked);
        } else {
          void vscode.window.showErrorMessage("nodecode: fork failed.");
        }
      })(),
    renameSession: async (sid, proposedName) => {
      const name = proposedName ?? await vscode.window.showInputBox({ prompt: "New name for this session" });
      if (name?.trim()) {
        const renamed = await api.setTitle(sid, name.trim());
        controllers.get(sid)?.refreshHeader();
        return renamed.title || undefined;
      }
    },
    exportSession: (sid) =>
      void (async () => {
        const lines = await api.exportJsonl(sid);
        const uri = await vscode.window.showSaveDialog({
          defaultUri: bootCwd ? vscode.Uri.file(path.join(bootCwd, `${sid}.jsonl`)) : undefined,
          filters: { "JSON Lines": ["jsonl"], "All Files": ["*"] },
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(lines, "utf8"));
          await vscode.window.showTextDocument(uri);
        }
      })(),
    revealTerminal: (sid) => revealTerminal(sid),
    deleteSession: async (sid) => {
      const choice = await vscode.window.showWarningMessage(
        `Delete session ${sid} and its child threads? This cannot be undone.`,
        { modal: true },
        "Delete",
      );
      if (choice !== "Delete") return;
      try {
        const ids = await deleteSessionTree(api, controllers, sid);
        SessionPanel.closeSessions(ids);
        sidebar.clearSessions(ids);
        for (const id of ids) forgetController(id);
        const activeSession = context.workspaceState.get<string>("nodecode.activeSession");
        if (activeSession && ids.includes(activeSession)) await context.workspaceState.update("nodecode.activeSession", undefined);
      } catch (error) {
        notes.log(`delete: ${String(error)}`);
        const message = String(error).includes('"code":"session_open"')
          ? "This thread or one of its children is open in another window or terminal. Close it there, then delete it again."
          : String(error);
        void vscode.window.showErrorMessage(`Nodecode: delete failed — ${message}`);
      }
    },
    showCheckpointHistory: (sid, controller) =>
      void (async () => {
        const checkpoints = await api.checkpoints(sid, 100);
        const rows = Array.isArray(checkpoints) ? checkpoints : checkpoints.checkpoints;
        const pick = await vscode.window.showQuickPick(
          rows.map((c) => ({
            label:
              typeof c.prompt === "string"
                ? c.prompt.replace(/\s+/g, " ").slice(0, 60)
                : `turn ${c.turn_number ?? c.turn_id ?? "?"}`,
            description: c.is_head ? "current" : undefined,
            detail: String(c.turn_id ?? c.id ?? ""),
          })),
          { placeHolder: "Pick a checkpoint to restore (changes files)" },
        );
        if (pick) await controller.navigateCheckpoint({ targetTurnId: pick.detail });
      })(),
    pickModel: (sid, controller) =>
      void (async () => {
        const models = await api.models();
        const list = Array.isArray(models) ? models : models.models;
        const pick = await vscode.window.showQuickPick(
          list.map((m) => ({
            label: m.display_name ?? m.id ?? m.model ?? "unknown",
            description: m.provider,
          })),
          { placeHolder: "Choose a model" },
        );
        if (!pick) return;
        const chosen = list.find((m) => (m.display_name ?? m.id ?? m.model) === pick.label);
        if (chosen) await api.setModel(sid, chosen.provider ?? null, chosen.model ?? null);
      })(),
    pickEffort: (sid, controller) =>
      void (async () => {
        const target = await api.target(sid).catch(() => undefined);
        const ladder = [
          ...new Set<string>([
            ...(target?.efforts ?? []),
            ...(target?.effort ? [target.effort] : []),
          ]),
        ];
        const pick = await vscode.window.showQuickPick(ladder, { placeHolder: "Choose effort" });
        if (pick) await api.setEffort(sid, pick);
      })(),
    revealSessionsView: () => sidebar.showHistory(),
  };

  const sidebar = new SessionSidebar(context.extensionUri, panelCallbacks, notes);
  context.subscriptions.push(sidebar, vscode.window.registerWebviewViewProvider("nodecodeChat", sidebar, { webviewOptions: { retainContextWhenHidden: true } }));

  const openPanel: CommandDeps["openPanel"] = (sessionId: string) => {
    void context.workspaceState.update("nodecode.activeSession", sessionId);
    sidebar.show(controllerFor(sessionId, { connect: true }));
  };

  // Send editor context into a draft; the user decides when to submit it.
  const addEditorContext = async (selectionOnly: boolean): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { void vscode.window.showInformationMessage("Nodecode: open a file first."); return; }
    const text = selectionOnly ? editor.document.getText(editor.selection) : editor.document.getText();
    if (!text) { void vscode.window.showInformationMessage("Nodecode: select some text first."); return; }
    let panel = SessionPanel.active();
    if (!panel) {
      await boot();
      const rows = await api.sessions();
      const selected = await vscode.window.showQuickPick(rows.map((row) => ({ label: row.title || row.prompt || row.id, description: row.id })), { placeHolder: "Choose a Nodecode conversation for this context" });
      if (!selected) return;
      openPanel(selected.description!);
      panel = SessionPanel.get(selected.description!);
    }
    const file = vscode.workspace.asRelativePath(editor.document.uri);
    const location = selectionOnly ? `:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}` : "";
    const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1)));
    const content = `${file}${location}\n${fence}${editor.document.languageId}\n${text}\n${fence}`;
    if (panel) panel.addContext(content);
    else sidebar.addContext(content);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("nodecode.addSelectionToChat", () => addEditorContext(true)),
    vscode.commands.registerCommand("nodecode.addActiveFileToChat", () => addEditorContext(false)),
  );

  void boot().then(async () => {
    const id = context.workspaceState.get<string>("nodecode.activeSession");
    if (!id) return;
    try {
      if ((await api.sessions()).some((row) => row.id === id)) sidebar.restore(controllerFor(id, { connect: true }));
    } catch (error) { notes.log(`restore conversation failed: ${String(error)}`); }
  });

  const deps: CommandDeps = {
    context,
    api,
    cli,
    discovery,
    notes,
    controllerFor,
    openPanel,
    revealTerminal,
    forgetController,
    deleteSession: (sid) => panelCallbacks.deleteSession(sid),
    workspaceRoot,
    showHistory: () => sidebar.showHistory(),
  };
  registerSessions(deps);
  context.subscriptions.push(vscode.commands.registerCommand("nodecode.newSession", async () => {
    try {
      await boot();
      const created = await api.createSession({ cwd: workspaceRoot() });
      const id = created.session_id ?? created.id;
      if (!id) throw new Error("Gateway did not return a session ID");
      openPanel(id);
    } catch (error) {
      notes.log(`new session failed: ${String(error)}`);
      void vscode.window.showErrorMessage(`Nodecode: ${String(error)}`);
    }
  }));

  context.subscriptions.push({
    dispose: () => {
      for (const controller of controllers.values()) controller.dispose();
      controllers.clear();
    },
  });
}

export function deactivate(): void {}

// Activation: wires the session tree, the per-session webview panel, the
// terminal shims and the status bar onto the controller/api/cli modules.
import * as path from "path";
import * as vscode from "vscode";

import { NodecodeApi } from "./api";
import { NodecodeCli } from "./cli";
import { NodecodeDiscovery, Notifications } from "./discovery";
import { SessionController } from "./manager";
import { SessionPanel, type PanelCallbacks } from "./panel";
import { registerSessions, type CommandDeps } from "./sessions";

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
      controller = new SessionController(cli, notes, api, bootCwd ?? "", sessionId);
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

  // One `nodecode rpc SID` terminal per session; reveal reuses it.
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
      const name = `nodecode rpc ${short}`;
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
        shellArgs: ["rpc", sessionId],
      });
      terminal.show();
    })();
  };

  // --- panel callbacks: the webview's actions against real api/manager -------
  const panelCallbacks: PanelCallbacks = {
    forkSession: (sid) =>
      void (async () => {
        const forked = await api.forkSession(sid, undefined, bootCwd);
        if (forked) {
          await trees.refresh();
          openPanel(forked);
        } else {
          void vscode.window.showErrorMessage("nodecode: fork failed.");
        }
      })(),
    renameSession: (sid) =>
      void (async () => {
        const name = await vscode.window.showInputBox({ prompt: "New name for this session" });
        if (name) {
          await api.setTitle(sid, name);
          await trees.refresh();
        }
      })(),
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
    deleteSession: (sid) =>
      void (async () => {
        const choice = await vscode.window.showWarningMessage(
          `Delete session ${sid}? This cannot be undone.`,
          { modal: true },
          "Delete",
        );
        if (choice !== "Delete") return;
        await api.deleteSession(sid);
        forgetController(sid);
        await trees.refresh();
      })(),
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
        const target = await api.target().catch(() => undefined);
        const ladder = [
          ...new Set<string>([
            ...(target?.efforts ?? []),
            ...(target?.effort ? [target.effort] : []),
          ]),
        ];
        const pick = await vscode.window.showQuickPick(ladder, { placeHolder: "Choose effort" });
        if (pick) await api.setEffort(sid, pick);
      })(),
    revealSessionsView: () => void vscode.commands.executeCommand("nodecodeSessions.focus"),
  };

  const openPanel: CommandDeps["openPanel"] = (sessionId: string) => {
    SessionPanel.createOrShow(
      context.extensionUri,
      controllerFor(sessionId, { connect: true }),
      panelCallbacks,
      notes,
    );
  };

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
    workspaceRoot,
  };
  const trees = registerSessions(deps);

  context.subscriptions.push({
    dispose: () => {
      for (const controller of controllers.values()) controller.dispose();
      controllers.clear();
    },
  });
}

export function deactivate(): void {}

// Session commands; the searchable history popover lives in panel.ts.

import * as path from "path";
import * as vscode from "vscode";
import { NodecodeApi, SessionRow } from "./api";
import { NodecodeCli } from "./cli";
import { NodecodeDiscovery, Notifications } from "./discovery";
import { SessionController } from "./manager";

export interface CommandDeps {
  context: vscode.ExtensionContext;
  api: NodecodeApi;
  cli: NodecodeCli;
  discovery: NodecodeDiscovery;
  notes: Notifications;
  controllerFor(sessionId: string, opts?: { connect?: boolean }): SessionController;
  openPanel(sessionId: string): void;
  revealTerminal(sessionId: string): void;
  forgetController(sessionId: string): void;
  deleteSession(sessionId: string): void | Promise<void>;
  workspaceRoot(): string;
  showHistory(): void;
}

function rowTitle(row: SessionRow): string {
  const semantic = (row as { semantic_summary?: { title?: string } }).semantic_summary?.title;
  return (
    row.semanticTitle ||
    semantic ||
    row.title ||
    (typeof row.prompt === "string" ? row.prompt.replace(/\s+/g, " ").slice(0, 60) : "") ||
    row.id
  );
}

function rowsFrom(input: unknown): SessionRow[] {
  if (Array.isArray(input)) return input as SessionRow[];
  const boxed = input as { sessions?: SessionRow[] };
  return Array.isArray(boxed?.sessions) ? boxed.sessions : [];
}

async function sessionIdOf(deps: CommandDeps, arg: unknown): Promise<string | undefined> {
  const direct =
    typeof arg === "string"
      ? arg
      : (arg as { row?: SessionRow; id?: string } | undefined) &&
        (((arg as { row?: SessionRow }).row?.id ?? (arg as SessionRow).id) as string | undefined);
  if (direct) return direct;
  const rows = rowsFrom(await deps.api.sessions().catch(() => []));
  if (!rows.length) {
    void vscode.window.showInformationMessage("Nodecode: no sessions found.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    rows.map((row) => ({ label: rowTitle(row), description: row.id, detail: row.working_directory })),
    { placeHolder: "Choose a Nodecode session" },
  );
  return pick?.description;
}

// The nodecode.md contents `Write nodecode.md to Workspace` starts from.
const NODECODE_MD = [
  "# Nodecode",
  "",
  "This folder is watched by the nodecode CLI.",
  "Run `nodecode` in a terminal to start a session; use the",
  "Nodecode side panel to open, fork and export sessions.",
  "",
].join("\n");

/** Register session commands without a second sidebar view. */
export function registerSessions(deps: CommandDeps): void {
  const subs: vscode.Disposable[] = [];
  const cmd = (id: string, fn: (...args: any[]) => unknown): void => {
    subs.push(vscode.commands.registerCommand(id, fn));
  };
  const retry = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (error) {
      deps.notes.log(`${label}: ${String(error)}`);
      void vscode.window.showErrorMessage(`nodecode: ${label} failed — ${String(error)}`);
      return undefined;
    }
  };

  cmd("nodecode.refreshSessions", () => deps.showHistory());

  cmd("nodecode.openPanel", async (arg: unknown) => {
    const sid = await sessionIdOf(deps, arg);
    if (sid) deps.openPanel(sid);
  });

  cmd("nodecode.openSessionPicker", () => deps.showHistory());

  cmd("nodecode.newSessionInTerminal", async () => {
    const ready = await deps.cli.ensureReady();
    if (ready !== "ok") {
      void vscode.window.showErrorMessage(`nodecode: ${ready.failure}`);
      return;
    }
    const binary = deps.cli.resolve();
    if (!binary) {
      void vscode.window.showErrorMessage("nodecode: CLI vanished after the readiness check.");
      return;
    }
    const name = "nodecode";
    const existing = vscode.window.terminals.find(
      (t) => (t.creationOptions as { name?: string } | undefined)?.name === name,
    );
    if (existing) existing.show();
    else {
      vscode.window.createTerminal({
        name,
        cwd: deps.workspaceRoot() || undefined,
        shellPath: binary,
      }).show();
    }

  });

  cmd("nodecode.focusSessionTerminal", async (arg: unknown) => {
    const sid = await sessionIdOf(deps, arg);
    if (sid) deps.revealTerminal(sid);
  });

  cmd("nodecode.forkSession", async (arg: unknown) => {
    const sid = await sessionIdOf(deps, arg);
    if (!sid) return;
    const forked = await retry("fork", () => deps.api.forkSession(sid, undefined, deps.workspaceRoot()));
    if (forked) {
      deps.openPanel(forked);
    }
  });

  cmd("nodecode.renameSession", async (arg: unknown) => {
    const sid = await sessionIdOf(deps, arg);
    if (!sid) return;
    const name = await vscode.window.showInputBox({ prompt: "New name for this Nodecode session" });
    if (!name) return;
    await retry("rename", () => deps.api.setTitle(sid, name));
  });

  cmd("nodecode.deleteSession", async (arg: unknown) => {
    const sid = await sessionIdOf(deps, arg);
    if (!sid) return;
    await deps.deleteSession(sid);
  });

  cmd("nodecode.viewSessionLogs", async (arg: unknown) => {
    const sid = await sessionIdOf(deps, arg);
    if (!sid) return;
    const lines = await retry("export", () => deps.api.exportJsonl(sid));
    if (!lines) return;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: deps.workspaceRoot()
        ? vscode.Uri.file(path.join(deps.workspaceRoot(), `${sid}.jsonl`))
        : undefined,
      filters: { "JSON Lines": ["jsonl"], "All Files": ["*"] },
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(String(lines), "utf8"));
    await vscode.window.showTextDocument(uri);
  });

  cmd("nodecode.cancelActiveTurn", async (arg: unknown) => {
    const sid = await sessionIdOf(deps, arg);
    if (!sid) return;
    const controller = deps.controllerFor(sid);
    controller.cancelActive(controller.store.view().activeTurnId);
  });

  cmd("nodecode.undoLastTurn", async (arg: unknown) => {
    const sid = await sessionIdOf(deps, arg);
    if (!sid) return;
    await deps.controllerFor(sid).navigateCheckpoint({ direction: "undo" });
  });

  cmd("nodecode.pickModel", async (arg: unknown) => {
    const sid = await sessionIdOf(deps, arg);
    if (!sid) return;
    const models = await retry("models", () => deps.api.models());
    if (!models) return;
    const list = Array.isArray(models) ? models : models.models;
    const pick = await vscode.window.showQuickPick(
      list.map((m) => ({
        label: m.display_name ?? m.id ?? m.model ?? "unknown",
        description: m.provider,
      })),
      { placeHolder: "Choose a model for this session" },
    );
    if (!pick) return;
    const chosen = list.find((m) => (m.display_name ?? m.id ?? m.model) === pick.label);
    if (chosen) await retry("setModel", () => deps.api.setModel(sid, chosen.provider ?? null, chosen.model ?? null));
  });

  cmd("nodecode.pickEffort", async (arg: unknown) => {
    const sid = await sessionIdOf(deps, arg);
    if (!sid) return;
    const target = await retry("target", () => deps.api.target(sid));
    if (!target) return;
    const ladder = [
      ...new Set<string>([
        ...(target.efforts ?? []),
        ...(target.effort ? [target.effort] : []),
      ]),
    ];
    if (!ladder.length) {
      void vscode.window.showInformationMessage("nodecode: the gateway reported no effort ladder.");
      return;
    }
    const pick = await vscode.window.showQuickPick(ladder, { placeHolder: "Choose effort for this session" });
    if (pick) await retry("setEffort", () => deps.api.setEffort(sid, pick));
  });

  cmd("nodecode.storeNodecodeMd", async () => {
    const root = deps.workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage("nodecode: open a workspace folder first.");
      return;
    }
    const uri = vscode.Uri.joinPath(vscode.Uri.file(root), "nodecode.md");
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(NODECODE_MD, "utf8"));
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  });

  cmd("nodecode.showActivationLog", () => deps.notes.show());
  cmd("nodecode.viewExtensionLogs", () => deps.notes.show());

  deps.context.subscriptions.push(vscode.Disposable.from(...subs));
}

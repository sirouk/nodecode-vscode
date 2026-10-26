// Sessions feature module: the tree view and every contributed nodecode.*
// command, riding on the api/cli/discovery/manager modules. Panel callbacks
// for the webview live in extension.ts; this file owns the roster UI.

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
  workspaceRoot(): string;
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

function fmtAgo(iso?: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function rowsFrom(input: unknown): SessionRow[] {
  if (Array.isArray(input)) return input as SessionRow[];
  const boxed = input as { sessions?: SessionRow[] };
  return Array.isArray(boxed?.sessions) ? boxed.sessions : [];
}

export class SessionItem extends vscode.TreeItem {
  constructor(readonly row: SessionRow) {
    super(rowTitle(row), vscode.TreeItemCollapsibleState.None);
    this.id = row.id;
    this.contextValue = "session";
    const ago = fmtAgo(row.updated_at);
    this.description = [ago, row.depth ? `fork d${row.depth}` : ""].filter(Boolean).join(" · ");
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**${rowTitle(row)}**\n\n`);
    if (row.prompt) tip.appendMarkdown(`${row.prompt.slice(0, 400)}\n\n`);
    tip.appendMarkdown(`\`${row.id}\``);
    if (row.working_directory) tip.appendMarkdown(`  ·  \`${row.working_directory}\``);
    if (row.parent_id) tip.appendMarkdown(`  ·  fork of \`${row.parent_id as string}\``);
    this.tooltip = tip;
    this.iconPath = new vscode.ThemeIcon(row.fork ? "git-branch" : "comment-discussion");
    this.command = { command: "nodecode.openPanel", title: "Open Session Panel", arguments: [row] };
  }
}

export class SessionsProvider implements vscode.TreeDataProvider<SessionItem> {
  private readonly emitter = new vscode.EventEmitter<SessionItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private rows: SessionRow[] = [];

  constructor(private readonly api: NodecodeApi, private readonly notes: Notifications) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  async load(): Promise<void> {
    try {
      const rows = rowsFrom(await this.api.sessions());
      rows.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
      this.rows = rows;
    } catch (error) {
      this.notes.log(`sessions load failed: ${String(error)}`);
    }
    this.refresh();
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SessionItem[] {
    return this.rows.map((row) => new SessionItem(row));
  }

  find(id: string): SessionRow | undefined {
    return this.rows.find((row) => row.id === id);
  }
}

async function sessionIdOf(deps: CommandDeps, arg: unknown): Promise<string | undefined> {
  const direct =
    typeof arg === "string"
      ? arg
      : (arg as SessionItem | SessionRow | undefined) &&
        (((arg as SessionItem).row?.id ?? (arg as SessionRow).id) as string | undefined);
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

/**
 * Register the Sessions tree view and every nodecode.* command in
 * package.json. Returns a handle whose `refresh` reloads from the gateway
 * (used by panel callbacks in extension.ts after rename/delete/fork).
 */
export function registerSessions(deps: CommandDeps): { refresh(): Promise<void> } {
  const provider = new SessionsProvider(deps.api, deps.notes);
  const tree = vscode.window.createTreeView("nodecodeSessions", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  const subs: vscode.Disposable[] = [tree];
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

  // --- tree view commands ------------------------------------------------
  cmd("nodecode.refreshSessions", () => void provider.load());

  cmd("nodecode.openPanel", async (arg: unknown) => {
    const sid = await sessionIdOf(deps, arg);
    if (sid) deps.openPanel(sid);
  });

  cmd("nodecode.openSessionPicker", async () => {
    const sid = await sessionIdOf(deps, undefined);
    if (sid) deps.openPanel(sid);
  });

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
    setTimeout(() => void provider.load(), 800);
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
      void provider.load();
      deps.openPanel(forked);
    }
  });

  cmd("nodecode.renameSession", async (arg: unknown) => {
    const sid = await sessionIdOf(deps, arg);
    if (!sid) return;
    const name = await vscode.window.showInputBox({ prompt: "New name for this Nodecode session" });
    if (!name) return;
    await retry("rename", () => deps.api.setTitle(sid, name));
    void provider.load();
  });

  cmd("nodecode.deleteSession", async (arg: unknown) => {
    const sid = await sessionIdOf(deps, arg);
    if (!sid) return;
    const choice = await vscode.window.showWarningMessage(
      `Delete Nodecode session ${sid}? The session history will be removed.`,
      { modal: true },
      "Delete",
    );
    if (choice !== "Delete") return;
    if (await retry("delete", () => deps.api.deleteSession(sid))) {
      deps.forgetController(sid);
      void provider.load();
    }
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
    const target = await retry("target", () => deps.api.target());
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

  // --- self-healing: reload the roster whenever the gateway state shifts ---
  subs.push(deps.discovery.onDidChange(() => void provider.load()));
  subs.push(vscode.window.onDidCloseTerminal(() => void provider.load()));
  deps.context.subscriptions.push(vscode.Disposable.from(...subs));

  void provider.load();
  return { refresh: () => provider.load() };
}

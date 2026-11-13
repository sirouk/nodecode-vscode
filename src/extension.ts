// Activation: the status bar, one webview view (and editor tab) framing the
// gateway's own page, and the commands that fix the three things standing in
// front of it — a missing nodecode, a stopped gateway, a web cell that is off.

import * as vscode from "vscode";

import { NodecodeCli } from "./cli";
import { NodecodeDiscovery, Notifications } from "./discovery";
import { Gateway, GatewayStatus } from "./gateway";
import { NodecodeView } from "./view";

export function activate(context: vscode.ExtensionContext): void {
  const notes = new Notifications("Nodecode");
  const discovery = new NodecodeDiscovery(notes);
  const cli = new NodecodeCli(discovery, notes);
  const gateway = new Gateway(cli, discovery, notes);
  const view = new NodecodeView(gateway, notes, { install: () => cli.installInTerminal() });

  discovery.watch(context);

  // --- status bar: what stands between the page and this window -----------
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.name = "Nodecode";
  item.command = "nodecode.open";
  const reflect = (status: GatewayStatus): void => {
    const ready = status.state === "ready";
    item.text = `${ready ? "$(chip)" : "$(warning)"} Nodecode`;
    item.tooltip = new vscode.MarkdownString(
      ready
        ? `**Nodecode** ${status.version}\n\n${status.baseUrl ?? ""}\nthe gateway's own page, in this window`
        : `**Nodecode** ${status.version}\n\n${status.message}`,
    );
    item.show();
  };
  context.subscriptions.push(item, notes);

  let refreshing: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (!refreshing) {
      refreshing = (async () => {
        const status = await gateway.status();
        reflect(status);
        await view.refresh();
      })().finally(() => {
        refreshing = undefined;
      });
    }
    return refreshing;
  };

  context.subscriptions.push(
    discovery.onDidChange(() => void refresh()),
    view,
    vscode.window.registerWebviewViewProvider("nodecodeWeb", view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    { dispose: () => gateway.dispose() },
  );

  const commands: Array<[string, (...args: unknown[]) => unknown]> = [
    ["nodecode.open", () => vscode.commands.executeCommand("nodecodeWeb.focus")],
    ["nodecode.openInEditor", () => view.openInEditor()],
    ["nodecode.openInBrowser", () => cli.openInBrowser()],
    ["nodecode.reload", () => view.refresh(true)],
    ["nodecode.install", () => cli.installInTerminal()],
    [
      "nodecode.startGateway",
      async () => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Starting the Nodecode gateway…" },
          () => gateway.startGateway(),
        );
        await refresh();
      },
    ],
    [
      "nodecode.enableWebCell",
      async () => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Turning on the Nodecode web cell…" },
          () => gateway.enableWebCell(),
        );
        await refresh();
      },
    ],
    [
      "nodecode.copyLink",
      async () => {
        const link = await gateway.link();
        if (!link) {
          void vscode.window.showWarningMessage("Nodecode: there is no gateway running to link to yet.");
          return;
        }
        await vscode.env.clipboard.writeText(link);
        void vscode.window.showInformationMessage("Copied the Nodecode link. It carries the operator token: keep it to yourself.");
      },
    ],
    ["nodecode.showDiagnostics", () => notes.show()],
  ];
  context.subscriptions.push(...commands.map(([id, run]) => vscode.commands.registerCommand(id, run)));

  void refresh();

  // --- the one ask: say what is missing, once per install -----------------
  // A reload, a new window or a reopened folder activates again; the operator
  // who already said "Not now" should not be told again. The view and the status
  // bar keep saying it, so nothing is hidden by staying quiet.
  const asked = (key: string): boolean => context.globalState.get<boolean>(`asked.${key}`, false) === true;
  const remember = (key: string): void => void context.globalState.update(`asked.${key}`, true);
  void gateway.status().then((status) => {
    if (status.state === "missing-cli" && !asked("install")) {
      remember("install");
      void vscode.window
        .showInformationMessage("Nodecode is not installed. Install it to show its page in this window.", "Install", "Docs")
        .then((choice) => {
          if (choice === "Install") cli.installInTerminal();
          if (choice === "Docs") void vscode.env.openExternal(vscode.Uri.parse(status.docsUrl));
        });
    } else if (status.state === "web-cell-off" && !asked("web-cell")) {
      remember("web-cell");
      void vscode.window
        .showInformationMessage("Nodecode is running, but its web cell is off — the cell that serves the page this view shows.", "Turn on the web cell", "Not now")
        .then(async (choice) => {
          if (choice !== "Turn on the web cell") return;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Turning on the Nodecode web cell…" },
            () => gateway.enableWebCell(),
          );
          await refresh();
        });
    }
  });
}

export function deactivate(): void {}

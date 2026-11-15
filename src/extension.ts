// Activation: the status bar, one webview view (and editor tab) framing the
// gateway's own page, and the commands that fix the two things standing in front
// of it — a stopped gateway, and a web cell its gateway has not loaded. Nothing
// is installed or downloaded from here: nodecode, and its cell, are the
// operator's own, and the only code this extension runs is in its own package.

import * as vscode from "vscode";

import { NodecodeCli } from "./cli";
import { NodecodeDiscovery, Notifications } from "./discovery";
import { Gateway, GatewayStatus } from "./gateway";
import { RemoteRead, RemoteState, TailnetMachine, actRemote, readMachines, readRemote } from "./remote";
import { REMOTE_CELL, installBundledCell, nodecodeHome } from "./cells";
import { NodecodeView } from "./view";

export function activate(context: vscode.ExtensionContext): void {
  const notes = new Notifications("Nodecode");
  const discovery = new NodecodeDiscovery(notes);
  const cli = new NodecodeCli(discovery, notes);
  const gateway = new Gateway(cli, discovery, notes);
  // What the page's own tailnet panel asks for: the state of this machine's
  // tailnet access, an action on it, or the cell put in place.
  // The panel's state with the machines beside it, each marked with whether
  // this window has taken a code for it.
  const withMachines = (state: RemoteState, found: TailnetMachine[]): Record<string, unknown> => {
    const machines = found.map((machine) => ({
      ...machine,
      // This machine is not paired with itself: it is where we are.
      paired: !machine.current && machine.address ? gateway.isPaired(machine.address) : false,
    }));
    const host = machines.find((machine) => machine.host)?.host;
    if (host) gateway.tailnetSuffix = host.split(".").slice(1).join(".");
    return { state: { ...state, machines } };
  };
  const tailnet = {
    state: async (): Promise<Record<string, unknown>> => {
      const endpoint = discovery.current();
      if (!endpoint) return { problem: "This home's gateway is not answering. Start it, then look again." };
      // Two questions the gateway answers on its own: asked together, the
      // panel waits for the slower one rather than for both in turn.
      const [read, found]: [RemoteRead, TailnetMachine[]] = await Promise.all([readRemote(endpoint), readMachines(endpoint)]);
      if (read.kind === "ok") return withMachines(read.state, found);
      if (read.kind === "missing")
        return { problem: `Tailnet access is the ${REMOTE_CELL} cell, and this home does not have it.`, installable: true };
      return { problem: `Could not read tailnet access: ${read.why}` };
    },
    act: async (body: { action: string; index?: number }): Promise<Record<string, unknown>> => {
      const endpoint = discovery.current();
      if (!endpoint) return { problem: "This home's gateway is not answering." };
      const read = await actRemote(endpoint, body);
      // Turning access on or off adds or takes away this machine's address, so
      // the list is read again after the action rather than kept from before it.
      if (read.kind === "ok") return withMachines(read.state, await readMachines(endpoint));
      if (read.kind === "missing") return { problem: "Tailnet access is not installed on this home.", installable: true };
      return { problem: read.why };
    },
    install: async (): Promise<Record<string, unknown>> => {
      try {
        const done = installBundledCell(context.extensionPath, nodecodeHome());
        notes.log(`tailnet: cell ${done.copied ? "installed" : "already present"} at ${done.path}`);
      } catch (error) {
        return { problem: `The cell could not be written: ${error instanceof Error ? error.message : String(error)}` };
      }
      const restarted = await cli.restartGateway();
      if (restarted.code !== 0) await cli.startGateway();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const said = await tailnet.state();
        if (!said.problem) return said;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      return tailnet.state();
    },
  };
  const view = new NodecodeView(gateway, notes, tailnet);

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
    [
      "nodecode.reload",
      async () => {
        await refresh();
        await view.refresh(true);
      },
    ],
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
          { location: vscode.ProgressLocation.Notification, title: "Loading the Nodecode web cell…" },
          () => gateway.reloadWebCell(),
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
    ["nodecode.remoteAccess", () => vscode.commands.executeCommand("nodecodeWeb.focus")],
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
        .showInformationMessage("Nodecode is not installed: the page this view shows is its own process on this machine.", "Docs", "Not now")
        .then((choice) => {
          if (choice === "Docs") void vscode.env.openExternal(vscode.Uri.parse(status.docsUrl));
        });
    } else if (status.state === "web-cell-off" && status.webCellInstalled && !asked("web-cell")) {
      remember("web-cell");
      void vscode.window
        .showInformationMessage("Nodecode is running, but its web cell is off — the cell that serves the page this view shows.", "Turn on the web cell", "Not now")
        .then(async (choice) => {
          if (choice !== "Turn on the web cell") return;
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Loading the Nodecode web cell…" },
            () => gateway.reloadWebCell(),
          );
          await refresh();
        });
    }
  });
}

export function deactivate(): void {}

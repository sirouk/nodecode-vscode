# Nodecode for VS Code

Watch and steer live [Nodecode](https://nodecode.ai) sessions without leaving VS Code: streaming replies, queued prompts, checkpoints, forks and background processes, surfaced in the sidebar and a session panel. The extension talks to the `nodecode` CLI's RPC protocol — the same session data you see in the terminal TUI, projected into the editor.

## Features

- **Sessions tree** — every session with its status (new, queued, running, completed), model and effort badge, and inline open / fork / reveal actions. One click to watch a session; one command to make a new terminal session.
- **Session panel** — streaming turn output, the queued prompt, checkpoint and fork counts, and active background processes, updating live as the CLI runs.
- **Turn controls** — cancel the active turn or undo the last turn (checkpoint restore) without switching to the terminal.
- **Steering** — pick the model or effort budget for a session, and write `nodecode.md` into any workspace to guide the agent there.
- **Diagnostics** — an output channel shows activation and CLI protocol traffic when `nodecode.diagnostics` is enabled.

## Requirements

- VS Code 1.96 or newer.
- The [nodecode](https://nodecode.ai) CLI installed and reachable on PATH (or set `nodecode.cliPath`).
- Untrusted and virtual workspaces are not supported: the extension launches the local CLI and reads workspace files.

## Install

From the VS Code Marketplace: search **Nodecode** (publisher `sirouk`), or run:

```sh
code --install-extension sirouk.nodecode-vscode
```

From a release asset: download the latest `.vsix` from the [Releases](https://github.com/sirouk/nodecode-vscode/releases) page, then **Extensions → … → Install from VSIX…**.

## Getting started

1. Start a session in your terminal: `nodecode` inside the project you want to work on.
2. Click the **Nodecode** icon in the activity bar. The Sessions view lists open sessions, refreshed automatically and on demand.
3. Click a session to open its panel, or **New Session in Terminal** to have VS Code create the terminal and run the CLI for you.

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| `nodecode.cliPath` | `nodecode` | Path to the CLI binary, or a bare name resolved against PATH. |
| `nodecode.diagnostics` | `false` | Verbose extension/CLI protocol logging in the Nodecode output channel. |

## Commands

| Command | What it does |
| --- | --- |
| `nodecode.openPanel` | Open the session panel (same as clicking a session). |
| `nodecode.openSessionPicker` | Quick Pick over running sessions to attach one. |
| `nodecode.newSessionInTerminal` | Create a VS Code terminal and run `nodecode` in it. |
| `nodecode.refreshSessions` | Re-scan discovery sources for sessions. |
| `nodecode.forkSession` | Fork a session from its checkpoint window. |
| `nodecode.renameSession` | Rename a session. |
| `nodecode.deleteSession` | Delete a session (asks for confirmation). |
| `nodecode.focusSessionTerminal` | Reveal the terminal that owns the session. |
| `nodecode.viewSessionLogs` | Export the session history to a file. |
| `nodecode.cancelActiveTurn` | Interrupt the active turn. |
| `nodecode.undoLastTurn` | Restore the session's last checkpoint. |
| `nodecode.pickModel` | Choose the model for a session. |
| `nodecode.pickEffort` | Choose the effort budget for a session. |
| `nodecode.storeNodecodeMd` | Write a `nodecode.md` file into the workspace. |
| `nodecode.showActivationLog` | Show the activation log (session troubleshooting). |
| `nodecode.viewExtensionLogs` | Show the diagnostics output channel. |

## Development

```sh
git clone https://github.com/sirouk/nodecode-vscode
cd nodecode-vscode
npm install
npm run compile
```

Press **F5** for an Extension Development Host. `npm test` runs the IPC + HTTP parity probe (CLI sections skip cleanly when `nodecode` is not on PATH); `npm run icon` writes `media/icon.png` from the embedded official mark — it must stay committed, CI fails if it drifts; `npm run typecheck` typechecks without emitting; `npm run package` builds the `.vsix`.

## Releasing

This repo follows the same release discipline as [prime-agent-vscode](https://github.com/sirouk/prime-agent-vscode):

1. `./release.sh --dry-run` runs every gate and prints the plan without editing anything.
2. `./release.sh --version vX.Y.Z` — bumps `package.json`, promotes `[Unreleased]` changelog entries, runs the full battery (compile, parity, icon freshness), packages the vsix and asserts exactly the intended file set ships, then commits, tags, pushes, and creates the GitHub release with the vsix asset.
3. The Marketplace publish belongs to CI: publishing the GitHub release triggers `.github/workflows/publish.yml`, which re-runs the gates and runs `vsce publish`.
4. Once, set the secret: an Azure DevOps PAT with **Marketplace → Manage** scope, stored as an actions secret named `VSCE_PAT` in the `CI` environment (Settings → Environments → CI → Add environment secret) or at repo level. `release.sh` reports whether it can read it.
5. Local-publish alternative: `.env` with `VSCE_PAT` plus `VSCE_PUBLISH=1` (see `release.sh --help`). `.env` is excluded from git and from every vsix by `.vscodeignore` and the package allowlist — never commit it.

## License

MIT — see [LICENSE](LICENSE).

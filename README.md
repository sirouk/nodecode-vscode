# Nodecode for VS Code

Watch and steer live [Nodecode](https://nodecode.ai) sessions without leaving VS Code: streaming replies, queued prompts, checkpoints, forks and background processes, surfaced in the sidebar and a session panel. The extension talks to the `nodecode` CLI's RPC protocol — the same session data you see in the terminal TUI, projected into the editor.

## Features

- **Session picker** — browse, rename and delete conversations in a scrollable popover without leaving the chat. Switch between recent sessions and their explicit parent/child lineage; selecting a session keeps the picker and search open. Click the conversation title to rename it; the workspace path is in its tooltip. The chat is the sole view in the Nodecode container; history stays in the popover.
- **Chat sidebar and editor panel** — a Nodecode-branded conversation with the official axolotl, warm orange accents, theme-aware surfaces, compact session actions and model/effort controls. Replies use a small inline avatar; clipboard icons appear on their own message, thought or code area on hover or keyboard focus. Streaming replies and tool results retain their reading position during updates. Long conversations open at the latest messages and reveal earlier history as you scroll up, keeping your reading position. Expanded thinking grows with its content, capped at eight lines or one-third of the chat viewport. It follows new thoughts until you scroll away or select text; return to its bottom to follow again.
- **Threads** — open direct child threads or history forks from the conversation strip, see which are running, and return to the parent. Nodecode fresh threads and inherited-history forks remain distinct. Completed assistant messages offer a Fork action that opens a new editor conversation through that recorded turn; the original stays open. Bookmark controls mark existing recorded checkpoints without creating a new file snapshot; draft forks show their native save state.
- **Rich conversation** — the safe Markdown renderer from Prime Agent brings aligned tables, task lists, all heading levels, fenced code with language labels, copy controls and clickable source-file links. Native tool states, image results, workspace diffs and metadata stay inspectable. Attach, paste or drop PNG, JPEG, GIF and WebP images; restore image previews from session history.
- **File references** — type `@` to find a workspace file, then use arrow keys and Tab or Enter, or click, to attach it. Suggestions follow the caret inside the composer. Selected @files stay inline at the caret as editable references. Removing the reference removes its context; Nodecode receives the current contents of selected references when you send. Files selected through + remain separate attachment chips.
- **Editor context** — add a selected range or the active file to the draft with the editor context menu; nothing is submitted until you send.
- **Reliable composition** — draft text survives webview reloads and is cleared only after Nodecode accepts it. Queue or steer an active turn, stop work, and jump back to the newest message after reading history.
- **Turn controls** — cancel the active turn or undo the last turn (checkpoint restore) without switching to the terminal.
- **Model controls** — search the inline model menu, star favorites, inspect reported context limits, and choose only reasoning levels supplied by Nodecode. Sticky Main, Aux, Decider and Backup tabs control their separate native settings; backup tests run only when clicked.
- **Attachments** — large text becomes a retained text-file attachment; add multiple files/images, preview them, and retry failed staging without losing the draft. The + dropdown immediately lists Nodecode files; type to filter without changing the draft, or use its footer to choose files in this computer’s native file dialog. Native browsing requires a verified local runtime; a separate host is reported as unavailable rather than showing the wrong filesystem.
- **Native commands and runtime** — slash commands use Nodecode's catalog and dialogs; missing installs offer the official installer and Retry, and the menu can restart the native service. The Nodecode CLI version links to its matching GitHub release when available, with verified release or binary-update dates in the tooltip.
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

1. Click the **Nodecode** icon in the activity bar and choose **New Conversation** to start directly in the editor. Existing terminal sessions also appear automatically.
2. Use **Browse sessions** in the chat toolbar to choose an existing conversation from the popover. Search titles and conversation content directly in the popover.
3. Click a session to open it in Chat. **Session actions → Open in editor** opens a full editor tab. **New Session in Terminal** starts the CLI instead. The last selected conversation is restored in that workspace.

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| `nodecode.cliPath` | `nodecode` | Path to the CLI binary, or a bare name resolved against PATH. |
| `nodecode.diagnostics` | `false` | Verbose extension/CLI protocol logging in the Nodecode output channel. |

## Commands

| Command | What it does |
| --- | --- |
| `nodecode.openPanel` | Open the session panel (same as clicking a session). |
| `nodecode.openSessionPicker` | Open searchable session history with recent and lineage views. |
| `nodecode.newSession` | Start a conversation directly in the editor. |
| `nodecode.newSessionInTerminal` | Create a VS Code terminal and run `nodecode` in it. |
| `nodecode.refreshSessions` | Open the searchable history popover. |
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

Press **F5** for an Extension Development Host. `npm test` compiles the extension and runs reducer regression tests plus the IPC + HTTP parity probe (CLI sections skip when `nodecode` is not on PATH); `npm run icon` writes `media/icon.png` from the embedded official mark — it must stay committed, CI fails if it drifts; `npm run typecheck` typechecks without emitting; `npm run package` builds the `.vsix`.

For the optional Chromium interaction checks, use an existing Playwright installation: `PLAYWRIGHT_PATH=/path/to/installed/playwright node test/browser-smoke.mjs`. No browser dependency is added to the extension.

## Releasing

This repo follows the same release discipline as [prime-agent-vscode](https://github.com/sirouk/prime-agent-vscode):

1. `./release.sh --dry-run` runs every gate and prints the plan without editing anything.
2. `./release.sh --version vX.Y.Z` — bumps `package.json`, promotes `[Unreleased]` changelog entries, runs the full battery (compile, parity, icon freshness), packages the vsix and asserts exactly the intended file set ships, then commits, tags, pushes, and creates the GitHub release with the vsix asset.
3. The Marketplace publish belongs to CI: publishing the GitHub release triggers `.github/workflows/publish.yml`, which re-runs the gates and runs `vsce publish`.
4. Once, set the secret: an Azure DevOps PAT with **Marketplace → Manage** scope, stored as an actions secret named `VSCE_PAT` in the `CI` environment (Settings → Environments → CI → Add environment secret) or at repo level. `release.sh` reports whether it can read it.
5. Local-publish alternative: `.env` with `VSCE_PAT` plus `VSCE_PUBLISH=1` (see `release.sh --help`). `.env` is excluded from git and from every vsix by `.vscodeignore` and the package allowlist — never commit it.

## License

MIT — see [LICENSE](LICENSE).

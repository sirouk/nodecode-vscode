# Nodecode for VS Code

The Nodecode gateway's own page, in your sidebar or an editor tab — not a copy of it. Nodecode already serves a complete interface at `http://127.0.0.1:<port>/web/` from its web cell: sessions, threads, the board, settings, the composer, model controls. This extension puts that page in VS Code and gets out of the way. There is no second client to keep in step, because there is no second client.

![Nodecode in the VS Code sidebar](media/icon.png)

## What it asks for, in order

1. **Is nodecode installed?** If not, the view says so and offers the installer.
2. **Is the gateway running?** If not, it offers **Start the gateway** (`nodecode gateway on`), which also keeps it running at login.
3. **Is the web cell on?** If not, it asks once, by name, and turns it on with `nodecode add nc://web` — the cell ships with Nodecode, so it stays current with the release you run.

Once all three hold, the view shows the page. Nothing else to configure.

## Install

From the VS Code Marketplace: search **Nodecode** (publisher `sirouk`), or:

```sh
code --install-extension sirouk.nodecode-vscode
```

From a release asset: download the latest `.vsix` from the [Releases](https://github.com/sirouk/nodecode-vscode/releases) page, then **Extensions → … → Install from VSIX…**.

Requires VS Code 1.96 or newer and the [nodecode](https://nodecode.ai) CLI on PATH (or `nodecode.cliPath`).

## Commands

| Command | What it does |
| --- | --- |
| **Nodecode: Open Nodecode** | Focus the sidebar view |
| **Nodecode: Open Nodecode in an Editor Tab** | The same page, full width, where the layout has room |
| **Nodecode: Open the Page in Your Browser** | Runs `nodecode web`, which opens your own browser |
| **Nodecode: Copy the Page Link** | Copies the link, token and all — keep it to yourself |
| **Nodecode: Reload the Page** | Re-probes the gateway and reloads the frame |
| **Nodecode: Turn On the Web Cell** | `nodecode add nc://web --yes` |
| **Nodecode: Start the Gateway** | `nodecode gateway on` |
| **Nodecode: Install Nodecode** | Runs the official installer in a terminal |
| **Nodecode: Show Diagnostics Output** | Activation log and CLI calls (`nodecode.diagnostics`) |

The view's title bar carries **Reload**, **Open in an Editor Tab** and **Open in Your Browser**.

## How it works

Nodecode's page is deliberately unframable: the web cell serves it with `Content-Security-Policy: frame-ancestors 'none'`, and the gateway refuses a socket whose `Origin` is not the same loopback authority it is asked under. Both are good defaults, so this extension does not ask Nodecode to relax them.

Instead it starts a small proxy on `127.0.0.1` in front of the gateway's port and changes exactly one thing on the way through: it drops that single `frame-ancestors` directive. The page, its assets, its requests, the operator token in its URL fragment, and the `/gateway` socket all pass through untouched. The webview frames the proxy's loopback origin, so the page runs as itself, on its own origin, with its own CSP — and when the web cell changes, this extension shows the change the moment it ships, because it is showing the cell.

Nothing about a session, a model, a checkpoint or a setting is modelled here. The extension knows four facts (CLI path, gateway port, operator token, whether `/web/` answers) and one trick (lifting the framing refusal).

The operator token is read from `~/.nodecode/operator-token` and placed in the framed page's URL fragment, which a browser never sends to a server; it is never written to disk, logged, or sent anywhere.

## Requirements and caveats

- **Untrusted and virtual workspaces are supported:** the extension reads only `~/.nodecode` (port, token) and never touches workspace files.
- **Remote (SSH, WSL, dev containers):** the gateway runs on the remote host, and the frame is resolved through VS Code's port forwarding (`vscode.env.asExternalUri`). Loopback-only setups work; a gateway reachable another way does not yet.
- **Profiles:** the extension follows `NODECODE_HOME` and the home the CLI reports. Multiple profiles are not switched between inside the view; run `nodecode -p NAME web` for another home.

## Development

```sh
npm install
npm run compile
npm test            # unit tests, the activation walk, and the CLI/gateway parity probe
npm run package     # nodecode-vscode-<version>.vsix
```

`npm test` skips the gateway probes when none is running, so it stays green on a machine that has not started Nodecode. `test/live-gateway.test.mjs` and `test/parity.mjs` exercise the real thing: the page served, framing lifted, assets loaded, the token accepted, the page's socket opened through the proxy — and a foreign origin refused.

## Publishing

`./release.sh` is the whole pipeline: pre-flight gates (branch, tree, remote), version bump in `package.json` and `package-lock.json`, promotion of `[Unreleased]` in this changelog, the verification battery (compile, `npm test`, icon), packaging, tag, push, GitHub release with the `.vsix`, and the tag-triggered workflow that publishes to the Marketplace with `VSCE_PAT`. `--dry-run` prints the plan and changes nothing.

## License

MIT — see [LICENSE](LICENSE).

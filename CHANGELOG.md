# Changelog

All notable changes to the Nodecode VS Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Replaced the extension icon with the official Nodecode axolotl mark: the activity bar icon (`media/icon.svg`) and the marketplace tile (`media/icon.png`) now carry the real brand mark.

## [0.1.0] - 2026-10-26

### Added

- Initial public release. Manage live Nodecode sessions from inside VS Code:
  - Sessions tree view with status badges (new, queued, running, completed), model and effort labels, and inline open/fork/reveal actions.
  - Attach any open session: streaming replies, queued prompt input, checkpoint and fork state, and background process listings.
  - Turn controls: cancel the active turn and undo the last turn via checkpoint restore.
  - Session lifecycle from the tree: open panel, fork, rename, reveal terminal, export history, delete.
  - Model and effort pickers, `nodecode.md` workspace-file writer, activation log and diagnostics output channel.

[Unreleased]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sirouk/nodecode-vscode/releases/tag/v0.1.0

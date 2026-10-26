# Changelog

All notable changes to the Nodecode VS Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Match native Markdown fences, tables, task lists and emphasis; preserve tool stream hydration, interruption details, image/diff metadata and workspace file links.
- Open long histories at recent messages, load earlier rows on scroll, and preserve selected text and the visible reading anchor across streaming and replay.

- Preserve native string user messages such as short follow-ups in live and replayed conversations.

- Keep Nodecode as a single permanent chat view without a second Sessions section or duplicate session heading; search titles and native conversation content inside history.

- Rename titles inline, keep the workspace path in a tooltip, and attach workspace file contents through an `@` picker.
- Close only this extension's own session readers before deletion, retaining the gateway protection for sessions open elsewhere.

- Keep streaming thoughts in a compact, content-sized viewport with independent tail following and preserved reading selections.
- Browse conversations in an anchored session popover and retain disclosure state across streaming updates.

- Keep raw turn identifiers in the status tooltip, with concise Sending, Working and Ready labels in the conversation footer.
- Send prompts and steering in Nodecode's native request envelope, and report protocol rejections immediately instead of waiting for an acknowledgement timeout.

### Added

- Persistent history browsing with nested lineage and recent-session views; fork completed assistant turns into a separate editor conversation.
- Compact inline reply avatars and contextual icon-only copy controls preserve selections; bookmark recorded checkpoints and show native draft/save state.
- Keep selected @file references inline at the caret with edit-aware context tracking, separate from + attachments.
- Inline searchable model and reasoning menus with persisted favorites, native context limits, and separate Main, Aux, Decider and Backup role settings.
- Automatic long-text attachments, multiple file/image previews, retryable staging, and separate native-runtime browsing and local-computer file selection.
- Native slash autocomplete and dialogs, installation detection/retry, a service restart action, and linked CLI version metadata.
- Nested session navigation, spawn notices, per-session recorded file changes, and background process output with independent scrolling.

- Nodecode-native conversation layout with official axolotl branding, editor-tab icon, compact SVG actions, model and effort controls.
- Direct child-thread and history-fork navigation with live activity and return-to-parent links.
- Durable thinking display, collapsible tool results, preserved reading positions, latest-message navigation and acknowledged draft submission.
- Reducer regression coverage for reasoning, replay, tools and child-thread scoping.

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

[Unreleased]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sirouk/nodecode-vscode/releases/tag/v0.1.0

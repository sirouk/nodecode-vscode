# Changelog

All notable changes to the Nodecode VS Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.11]

### Fixed

- Keep response Copy, Fork and Bookmark controls inside the response body so they stay clickable without overlapping the separate thought-process copy control.
- Reserve the response control strip instead of listing the markdown shapes it must avoid, so reply controls never steal a click from a code copy button below a leading rule, a link at the end of the first line or the zoom corner of a wide image, and an empty streaming body no longer leaves them hanging over the next message.

## [0.1.10]

### Fixed

- Preserve selected workspace-file references when a long draft becomes a text attachment.
- Open attached workspace-file links from the same workspace used to capture their contents, without changing session-relative Markdown and recorded-change links.
- Connect and synchronize unopened sessions before cancelling their current turn; never cancel with a missing or cached turn ID.
- Keep session readers suspended throughout deletion, including pending cache validation and repeated selections, and restore them if deletion fails.
- Cancel incomplete text-upload reservations before restarting restored or retried uploads, preventing false attachment-limit errors after reloads.
- Mark running processes as unconfirmed when their connection drops; retain their output but withhold Stop until a fresh runtime update confirms they are running.
- Retain the most recently updated idle thread separately within each parent’s family level instead of grouping unrelated branches together.
- Reveal the selected thread again when navigation is explicitly restored, while preserving deliberate scrolling during live updates.

## [0.1.9]

### Fixed

- Keep Agents & threads open when navigating children, siblings or parents, including from spawned-fork links and editor conversations; retain the Idle disclosure without mixing conversation drafts.
- Show persistent parent links above an indented family list, highlight the current thread without reloading it on click, and keep selected threads and ancestors of visible work out of the Idle fold.

## [0.1.8]

### Changed

- Compact the conversation header with smaller text, avatar and action icons, less vertical padding, and stable sizing while renaming to leave more room for messages.
- Move the work, save-state and usage row below the chat input and its action buttons, above the keyboard hint.
- Indent activity children beneath Background processes, Agents & threads and Modified files, with another inset for Idle rows; widen the chat input to the available panel width with small side gutters.
- Keep non-idle agents and threads newest-started first, with the most recently updated idle thread above a collapsed, newest-first Idle subsection; retain its disclosure state and cap the compact list’s height.
- Shorten spawned-fork notices to “Spawned:” and give each compact row a left-edge color cap matching its thread.
- Reduce eval/tool card header text and spacing; match expanded input, output and result details to the 11px headers with tighter insets, preserving full scrollable contents.
- Tighten footer disclosure rows and remove their horizontal separators; omit trailing blank thought lines and bottom padding from display without changing saved or copied text.

### Fixed

- Render inline Markdown in Thought process, including bold instead of literal asterisks, while preserving streamed selections, scrolling and copied source text.
- Load saved conversation images through authenticated binary gateway requests, keeping credentials out of image URLs and restoring history and full-size previews.
- Show the streaming reply cursor only after reply text arrives and hide it when a tool follows, avoiding an isolated orange marker under thinking or a preceding reply.
- Keep automatic transcript following through thought-height and incoming-content reflows, without overriding deliberate scrolling or text selection.

## [0.1.7]

### Fixed

- Restore complete local thread projections on reopen, validate native history before cursor catch-up, and publish replay as one transaction rather than rebuilding the growing transcript for each fact; preserve recorded files, agent relationships and older messages.
- Keep cached history read-only until sync completes, retain the last complete checkpoint through interrupted replay, and replace invalidated branch history instead of merging stale state.
- Show compact current-context and cumulative token counts with exact usage details; include cache writes in normalized totals and clear omitted authoritative header counters.
- Give the tag-only Marketplace publish job access to its existing CI environment secret, and report environment/repository PAT configuration accurately in the release script.

## [0.1.6]

### Fixed

- Make Enter and Send steer active responses by default, with a separate explicit Queue action; retain steering targets through attachment preparation, reject stale or unavailable steering without silently queuing, and distinguish pending steers from follow-ups.
- Track native turn starts and prompt promotions directly so fresh turns remain steerable and historical queue snapshots cannot revive delivered inputs or completed turns.
- Replace plain-text workspace patches with shared, theme-aware unified diff previews, compact file rows, line-number gutters and independent file-opening controls; retain selection, focus, expansion and scroll state across updates and webview recreation.
- Show the latest completed recorded change per file, distinguish unknown counts from zero, and isolate repeated tool IDs across turns; label binary, missing, incomplete and explicitly truncated previews honestly.

- Preserve image drafts, prompt-history navigation and in-flight submissions across webview recreation; correlate send acknowledgements without resubmitting or clearing newer edits.
- Retain admitted and outcome-unknown text attachments, reclaim explicitly discarded unsent files, and preserve saved drafts and inherited-history attachment access.
- Verify local-runtime identity for text-file staging and reject reproduced file/symlink substitutions before reading selected file contents.
- Propagate native menu and turn-control failures, preserve provider identity when model names match, and recover failed favorite and attachment-browser controls.
- Settle fork/bookmark buttons without waiting for another session update, and refresh thread navigation when only the parent changes.
- Reconcile replay/header accounting without double-counting, distinguish cumulative tokens from current context usage, and isolate inherited session state and delayed tool results.
- Preserve native eviction counts and explicit process-output truncation markers.
- Handle broken RPC input streams, truncated HTTP responses, detached daemon spawn failures and stale discovery probes; reconnect every detached controller when deletion fails.
- Bound pathological Markdown blockquote nesting and preserve mixed-list indentation, ordering and ownership.
- Gate tag publication on verification, synchronize lockfile versions, and align changelog promotion, secret checks and release-run monitoring with the tag-push workflow.

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

[Unreleased]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.11...HEAD
[0.1.11]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sirouk/nodecode-vscode/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sirouk/nodecode-vscode/releases/tag/v0.1.0

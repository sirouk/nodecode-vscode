import type { SessionRow } from "./api";
import { sessionFamily, type SessionThread } from "./session-family";
import { BackgroundProcesses, recordedFileChanges, type BackgroundProcessView, type RecordedFileChange } from "./session-activity";
export type { SessionThread } from "./session-family";
import { splitFileReferences } from "./file-context";
import { splitTextFileReferences } from "./text-attachments";
// The fact reducer: applies gateway frames into durable conversation state,
// idempotent across replays (sequence-gated), with a live streaming overlay
// that durable messages replace as they land.

import {
  GatewayTurnCommandResultFrame,
  OrganismFrame,
  PendingPrompt,
  RpcFrame,
  RpcUsage,
  SessionMessage,
  SessionStreamEvent,
  SessionStreamEventFrame,
  SessionStreamResumedFrame,
  TurnQueueSnapshot,
  TextFileAttachment,
  isTerminalEventType,
  isReplayComplete,
} from "./protocol";

export interface ChatToolCall {
  callId: string;
  sessionId?: string;
  name: string;
  arguments: string;
  result?: string;
  durationMs?: number;
  failed?: boolean;
  done: boolean;
  streamIndex?: number;
  metadata?: Record<string, unknown>;
  status?: "running" | "done" | "failed" | "stopped" | "background";
}

export interface ChatImage { id: string; mediaType: string }

export type ChatPart =
  | { kind: "user"; text: string; files?: string[]; textFiles?: TextFileAttachment[]; images?: ChatImage[]; promptId?: string; turnNumber: number }
  | { kind: "assistant"; text: string; images?: ChatImage[]; reasoning: string; turnNumber: number; streaming: boolean; durable: boolean; voided?: string; forkTurnId?: string }
  | { kind: "tool"; call: ChatToolCall; turnNumber: number }
  | { kind: "system"; text: string; level: "info" | "warn" | "error"; childSessionId?: string };

export type BgProcess = BackgroundProcessView;

export interface UsageTotals {
  input: number;
  output: number;
  cached: number;
  total: number;
  costUsd: number;
  costKnown: boolean;
  turns: number;
}

export interface StoreView {
  replayComplete: boolean;
  threads: SessionThread[];
  ancestors: SessionThread[];
  siblings: SessionThread[];
  descendants: SessionThread[];
  modifiedFiles: RecordedFileChange[];
  parentId?: string;
  title: string;
  cwd: string;
  sessionId?: string;
  parts: ChatPart[];
  queue: PendingPrompt[];
  activeTurnId: string | null;
  activeTurnSteerable: boolean;
  running: boolean;
  lastUsage: RpcUsage | null;
  totals: UsageTotals;
  model?: string;
  provider?: string;
  effort?: string;
  processes: BgProcess[];
  noticeCount: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function messageImages(payload: Record<string, unknown>): ChatImage[] {
  const images = asRecord(payload.metadata).images;
  return Array.isArray(images) ? images.flatMap((value) => {
    const row = asRecord(value);
    return typeof row.id === "string" && typeof row.media_type === "string"
      ? [{ id: row.id, mediaType: row.media_type }] : [];
  }) : [];
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function continuedText(text: string, prefix: unknown): string {
  return typeof prefix === "number" && Number.isInteger(prefix) && prefix >= 0
    ? Array.from(text).slice(prefix).join("") : text;
}

/** Defensive text extraction from a gateway message object. */
export function messageText(message: SessionMessage | string | undefined): string {
  // Native input_committed facts contain a string; assistant messages use objects.
  if (typeof message === "string") return message;
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const item of content) {
      const rec = asRecord(item);
      const kind = asString(rec.type) || asString(rec.part_type);
      if (["reasoning", "thinking", "redacted_thinking", "tool_use", "tool_result"].includes(kind)) continue;
      const t = asString(rec.text) || asString(rec.content);
      if (t) out.push(t);
    }
    if (out.length) return out.join("\n");
  }
  if (Array.isArray(message.parts)) {
    const out: string[] = [];
    for (const part of message.parts) {
      const rec = asRecord(part) as { part_type?: string; text?: string };
      if (rec.part_type === "text" && rec.text) out.push(rec.text);
    }
    if (out.length) return out.join("\n");
  }
  return "";
}

/** Only provider-exposed reasoning is rendered; signatures and redacted blocks stay private. */
export function messageReasoning(message: SessionMessage | undefined): string {
  if (!message) return "";
  if (typeof message.reasoning_content === "string") return message.reasoning_content;
  const blocks = Array.isArray(message.reasoning_blocks) ? message.reasoning_blocks
    : Array.isArray(message.parts) ? message.parts
    : Array.isArray(message.content) ? message.content : [];
  return blocks.map((block) => {
    const row = asRecord(block);
    const kind = asString(row.type) || asString(row.part_type);
    if (!["reasoning", "thinking"].includes(kind)) return "";
    return asString(row.thinking) || asString(row.summary) || asString(row.text) || asString(row.content);
  }).filter(Boolean).join("\n");
}

export class SessionStore {
  private replayCompleteValue = false;
  private parts: ChatPart[] = [];
  private queueSnapshot: TurnQueueSnapshot | null = null;
  private lastSequence = 0;
  private turnNumber = 0;
  private activeTurnId: string | null = null;
  private runningSinceTurn = false;
  private durableTurnTexts: string[] = [];
  private liveText = "";
  private liveReasoning = "";
  private lastUsageValue: RpcUsage | null = null;
  private totalsValue: UsageTotals = { input: 0, output: 0, cached: 0, total: 0, costUsd: 0, costKnown: false, turns: 0 };
  private titleValue = "";
  private cwdValue = "";
  private sessionIdValue: string | undefined;
  private modelValue: string | undefined;
  private providerValue: string | undefined;
  private effortValue: string | undefined;
  private readonly processes = new BackgroundProcesses();
  private noticeCountValue = 0;
  private revision = 0;
  private threadRows: SessionRow[] = [];
  private activeSessions: Map<string, string | undefined> | undefined;
  private seenChildIds: Set<string> | undefined;
  private readonly pendingSpawnIds = new Set<string>();
  private readonly notifiedSpawnIds = new Set<string>();

  onDidChange: (revision: number) => void = () => {};
  private readonly listeners = new Set<(revision: number) => void>();

  subscribe(listener: (revision: number) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  // ------------------------------------------------------------------ frames

  applyFrames(frames: RpcFrame[]): void {
    for (const frame of frames) this.applyFrame(frame);
  }

  applyFrame(frame: RpcFrame): void {
    switch (frame.type) {
      case "session_stream_resumed":
        this.applyResumed(frame as SessionStreamResumedFrame);
        return;
      case "session_stream_event":
        this.applyEvent(frame as SessionStreamEventFrame);
        return;
      case "item_delta":
        this.applyDelta(frame as { delta?: { type?: string; text?: string; arguments?: string } });
        return;
      case "gateway_turn_command_result":
        this.applyCommandResult(frame as GatewayTurnCommandResultFrame);
        return;
      case "session_input_queue_snapshot_updated":
        this.queueSnapshot = (frame as { snapshot?: TurnQueueSnapshot }).snapshot ?? null;
        const active = this.queueSnapshot?.active_turn;
        if (active !== undefined) this.activeTurnId = active ?? null;
        break;
      case "session_titled":
        this.titleValue = (frame as { title?: string }).title ?? this.titleValue;
        break;
      case "session_background_process_updated":
        if (typeof frame.session_id === "string" && this.sessionIdValue && frame.session_id !== this.sessionIdValue) return;
        this.applyProcess(frame as { process?: Record<string, unknown> });
        break;
      case "model_changed": {
        const f = frame as { model?: string; provider?: string; effort?: string };
        if (f.model) this.modelValue = f.model;
        if (f.provider) this.providerValue = f.provider;
        if (f.effort) this.effortValue = f.effort;
        break;
      }
      case "organism.activity":
        this.activeSessions = new Map(((frame as OrganismFrame).sessions ?? []).filter((row) => typeof row.id === "string").map((row) => [row.id as string, typeof row.started_at === "string" ? row.started_at : undefined]));
        break;
      case "organism.notice":
      case "organism.notices":
        this.applyNotices(frame as OrganismFrame);
        break;
      default:
        return; // frames the store does not track should not bump the view
    }
    this.bump();
  }

  private applyResumed(frame: SessionStreamResumedFrame): void {
    // A full replay can arrive in chunks; only its first chunk replaces state.
    if (frame.resumed_after == null && (frame.replay_chunk_index == null || frame.replay_chunk_index === 0)) this.reset();
    else if (!frame.replay_tail && (frame.replay_chunk_index == null || frame.replay_chunk_index === 0)) {
      // The gateway replays the active round's complete transient overlay after
      // cursor catch-up. Drop the old connection's uncommitted copy first.
      this.parts = this.parts.filter((part) => !(part.kind === "assistant" && !part.durable) && !(part.kind === "tool" && part.call.streamIndex !== undefined));
      this.liveText = ""; this.liveReasoning = "";
    }
    this.replayCompleteValue = isReplayComplete(frame);
    this.sessionIdValue = frame.session_id ?? this.sessionIdValue;
    for (const inner of frame.accumulated_frames ?? []) this.applyEvent(inner);
    if (frame.title) this.titleValue = frame.title;
    if (isReplayComplete(frame) && frame.admission_state === "ready") {
      this.runningSinceTurn = false;
      this.activeTurnId = null;
    }
    this.bump();
  }

  private reset(): void {
    this.replayCompleteValue = false;
    this.parts = [];
    this.turnNumber = 0;
    this.queueSnapshot = null;
    this.activeTurnId = null;
    this.lastUsageValue = null;
    this.totalsValue = { input: 0, output: 0, cached: 0, total: 0, costUsd: 0, costKnown: false, turns: 0 };
    this.processes.clear();
    this.lastSequence = 0;
    this.durableTurnTexts = [];
    this.liveText = "";
    this.liveReasoning = "";
    this.runningSinceTurn = false;
  }

  private bump(): void {
    this.revision += 1;
    this.onDidChange(this.revision);
    for (const listener of this.listeners) listener(this.revision);
  }

  // ----------------------------------------------------------------- events

  private applyEvent(frame: SessionStreamEventFrame): void {
    const seq = typeof frame.sequence === "number" ? frame.sequence : 0;
    if (seq && seq <= this.lastSequence) return; // replay idempotence
    if (seq) this.lastSequence = seq;
    const event = frame.event as SessionStreamEvent | undefined;
    if (!event || typeof event.type !== "string") return;
    const payload = asRecord((event as { payload?: unknown }).payload);
    const eventSessionId = typeof frame.session_id === "string" ? frame.session_id : this.sessionIdValue;
    switch (event.type) {
      case "session.created": {
        const cwd = asString(payload.cwd);
        if (cwd) this.cwdValue = cwd;
        const id = asString(payload.id);
        if (id && !this.sessionIdValue) this.sessionIdValue = id;
        break;
      }
      case "session_input_queue_snapshot_updated":
        this.queueSnapshot = payload.snapshot as TurnQueueSnapshot ?? null;
        this.activeTurnId = this.queueSnapshot?.active_turn ?? null;
        break;
      case "turn.input_committed": {
        // Queued inputs become conversation rows only when their started fact arrives.
        if (payload.disposition === "follow-up") break;
        const text = messageText(payload.message as SessionMessage | string | undefined) || asString(payload.text);
        const role = asString(payload.role) || "user";
        const images = messageImages(payload);
        if (text || images.length) {
          if (role === "user") {
            const referenced = splitFileReferences(text);
            const attached = splitTextFileReferences(referenced.text);
            this.parts.push({
              kind: "user",
              ...referenced,
              ...attached,
              images,
              promptId: asString(payload["prompt-id"]) || undefined,
              turnNumber: this.turnNumber,
            });
          } else {
            this.parts.push({ kind: "system", text, level: "info" });
          }
        }
        break;
      }
      case "turn.started": {
        this.turnNumber += 1;
        this.runningSinceTurn = true;
        this.lastUsageValue = null;
        if (typeof frame.turn_id === "string") this.activeTurnId = frame.turn_id;
        this.liveText = "";
        this.liveReasoning = "";
        break;
      }
      case "turn.assistant_message_completed": {
        const message = payload.message as SessionMessage | undefined;
        const text = continuedText(messageText(message), payload["continued-content-chars"]);
        const reasoning = continuedText(messageReasoning(message), payload["continued-reasoning-chars"]);
        const images = messageImages(payload);
        // Tool input may stream after text but before the round's durable message.
        const last = this.parts.find((part) => part.kind === "assistant" && part.streaming && part.turnNumber === this.turnNumber);
        if (last && last.kind === "assistant") {
          if (text) last.text = text;
          if (reasoning) last.reasoning = reasoning;
          if (images.length) last.images = images;
          last.streaming = false;
          last.durable = true;
          if (typeof frame.turn_id === "string") last.forkTurnId = frame.turn_id;
          this.parts = this.parts.filter((part) => part === last || !(part.kind === "assistant" && part.streaming && part.turnNumber === this.turnNumber));
        } else if (text || reasoning || images.length) {
          this.parts.push({
            kind: "assistant",
            text,
            images,
            reasoning,
            turnNumber: this.turnNumber,
            streaming: false,
            durable: true,
            ...(typeof frame.turn_id === "string" ? {forkTurnId: frame.turn_id} : {}),
          });
        }
        break;
      }
      case "turn.tool_call_started": {
        const callId = asString(payload["call-id"]);
        const name = asString(payload["tool-name"]) || "tool";
        const args = asString(payload.arguments);
        const existing = (callId ? this.findTool(callId) : undefined) ?? this.parts.find((part): part is Extract<ChatPart, { kind: "tool" }> =>
          part.kind === "tool" && part.turnNumber === this.turnNumber && part.call.streamIndex !== undefined && !part.call.done && part.call.name === name);
        if (existing) {
          existing.call.callId = callId || existing.call.callId;
          if (eventSessionId) existing.call.sessionId = eventSessionId;
          delete existing.call.streamIndex;
          existing.call.name = name;
          if (args) existing.call.arguments = args;
        } else {
          this.parts.push({
            kind: "tool",
            call: { callId: callId || `tool-${this.parts.length}`, ...(eventSessionId ? {sessionId:eventSessionId} : {}), name, arguments: args, done: false },
            turnNumber: this.turnNumber,
          });
        }
        break;
      }
      case "turn.tool_result": {
        const callId = asString(payload["call-id"]);
        const failed = payload.failed === true;
        const result = asString(payload.result);
        const metadata = asRecord(payload.metadata);
        const background = asRecord(metadata.background_shell);
        if (typeof background.shell_session_id === "number" && eventSessionId === this.sessionIdValue) this.processes.update({...background,tool_call_id:callId});
        const status = metadata.stopped ? "stopped" : failed ? "failed" : asRecord(metadata.background_shell).status === "running" ? "background" : "done";
        const durationMs = typeof payload["duration-ms"] === "number" ? (payload["duration-ms"] as number) : undefined;
        const existing = callId ? this.findTool(callId) : undefined;
        if (existing) {
          if (eventSessionId) existing.call.sessionId = eventSessionId;
          existing.call.result = result;
          existing.call.metadata = metadata;
          existing.call.status = status;
          existing.call.failed = failed;
          if (durationMs !== undefined) existing.call.durationMs = durationMs;
          existing.call.done = true;
        } else {
          this.parts.push({
            kind: "tool",
            call: {
              callId: callId || `tool-${this.parts.length}`,
              ...(eventSessionId ? {sessionId:eventSessionId} : {}),
              name: asString(payload["tool-name"]) || "tool",
              arguments: "",
              result,
              failed,
              durationMs,
              done: true,
              metadata,
              status,
            },
            turnNumber: this.turnNumber,
          });
        }
        break;
      }
      case "turn.usage": {
        const usage = payload as RpcUsage;
        this.lastUsageValue = usage;
        const input = typeof usage["input-tokens"] === "number" ? (usage["input-tokens"] as number) : 0;
        const output = typeof usage["output-tokens"] === "number" ? (usage["output-tokens"] as number) : 0;
        const cached = typeof usage["cached-input-tokens"] === "number" ? (usage["cached-input-tokens"] as number) : 0;
        const total = typeof usage["total-tokens"] === "number" ? (usage["total-tokens"] as number) : 0;
        this.totalsValue.turns += 1;
        this.totalsValue.output += output;
        this.totalsValue.input = Math.max(this.totalsValue.input, input);
        this.totalsValue.cached = Math.max(this.totalsValue.cached, cached);
        this.totalsValue.total = Math.max(this.totalsValue.total, total);
        if (usage.cost_known === true && typeof usage.cost_usd === "number") {
          this.totalsValue.costUsd += usage.cost_usd;
          this.totalsValue.costKnown = true;
        }
        if (!this.modelValue && typeof usage.model === "string" && usage.model) this.modelValue = usage.model;
        if (!this.providerValue && typeof usage.provider === "string" && usage.provider) this.providerValue = usage.provider;
        break;
      }
      case "turn.completed":
        this.runningSinceTurn = false;
        this.activeTurnId = null;
        if (this.queueSnapshot) this.queueSnapshot = { ...this.queueSnapshot, active_turn: null, active_turn_steerable: false };
        this.sealLive();
        if (this.lastUsageValue?.["finish-reason"] && !["stop", "tool_calls"].includes(this.lastUsageValue["finish-reason"])) {
          this.parts.push({ kind: "system", text: `Response ended: ${this.lastUsageValue["finish-reason"]}`, level: "warn" });
        }
        break;
      case "turn.failed": {
        this.runningSinceTurn = false;
        this.activeTurnId = null;
        if (this.queueSnapshot) this.queueSnapshot = { ...this.queueSnapshot, active_turn: null, active_turn_steerable: false };
        this.sealLive();
        const message = asString(payload.detail) || asString(payload.message) || "Turn failed.";
        this.parts.push({ kind: "system", text: message, level: "error" });
        break;
      }
      case "turn.cancelled":
        this.runningSinceTurn = false;
        this.activeTurnId = null;
        if (this.queueSnapshot) this.queueSnapshot = { ...this.queueSnapshot, active_turn: null, active_turn_steerable: false };
        this.sealLive();
        this.parts.push({ kind: "system", text: "Turn cancelled.", level: "info" });
        break;
      case "turn.attempt_voided": {
        const text = asString(payload.text), reasoning = asString(payload.reasoning);
        const detail = asString(payload.detail);
        const next = payload.disposition === "rerun" ? "Trying again." : payload.disposition === "continued" ? "Continued below." : "Not retried.";
        const label = `Attempt ${asString(payload.attempt) || "1"} cut off${detail ? `: ${detail}` : ""}. ${next}`;
        const last = [...this.parts].reverse().find((part) => part.kind === "assistant" && part.streaming && part.turnNumber === this.turnNumber);
        if (text || reasoning) {
          if (last?.kind === "assistant" && last.streaming && last.turnNumber === this.turnNumber) {
            Object.assign(last, { text, reasoning, streaming: false, durable: true, voided: label });
          } else this.parts.push({ kind: "assistant", text, reasoning, streaming: false, durable: true, voided: label, turnNumber: this.turnNumber });
        }
        this.parts.push({ kind: "system", text: label, level: "warn" });
        break;
      }
      case "turn.provider_retry":
        this.parts.push({ kind: "system", text: `Retrying ${asString(payload.provider) || "provider"}${typeof payload["delay-seconds"] === "number" ? ` in ${payload["delay-seconds"]}s` : ""}${payload.detail ? `: ${asString(payload.detail)}` : ""}`, level: "warn" });
        break;
      case "turn.provider_fallback":
        this.parts.push({ kind: "system", text: `Model fallback: ${asString(payload["from-model"])} → ${asString(payload["to-model"])}${payload.detail ? `: ${asString(payload.detail)}` : ""}`, level: "warn" });
        break;
      case "session.context.evicted":
        this.parts.push({ kind: "system", text: `Context trimmed: ${asString(payload["turn-count"]) || "0"} turns, ${asString(payload["message-count"]) || "0"} messages; ${asString(payload["retained-message-count"]) || "0"} retained. Earlier messages remain in history.`, level: "info" });
        break;
      default:
        if (isTerminalEventType(event.type)) {
          this.runningSinceTurn = false;
          this.sealLive();
        }
        break;
    }
    this.bump();
  }

  private findTool(callId: string): Extract<ChatPart, { kind: "tool" }> | undefined {
    for (let i = this.parts.length - 1; i >= 0; i -= 1) {
      const part = this.parts[i];
      if (part.kind === "tool" && part.call.callId === callId) return part;
      if (part.kind === "user") return undefined;
    }
    return undefined;
  }

  private liveAssistant(): Extract<ChatPart, { kind: "assistant" }> {
    const last = this.parts[this.parts.length - 1];
    if (last && last.kind === "assistant" && last.streaming && last.turnNumber === this.turnNumber) return last;
    const part: Extract<ChatPart, { kind: "assistant" }> = {
      kind: "assistant",
      text: "",
      reasoning: "",
      turnNumber: this.turnNumber,
      streaming: true,
      durable: false,
    };
    this.parts.push(part);
    return part;
  }

  private sealLive(): void {
    for (const part of this.parts) if (part.kind === "assistant" && part.streaming) part.streaming = false;
  }

  private applyDelta(frame: { delta?: { type?: string; text?: string; arguments?: string; name?: string; index?: number } }): void {
    const delta = frame.delta;
    if (!delta || typeof delta.type !== "string") return;
    if (delta.type === "text" || delta.type === "fallback") {
      const text = delta.text ?? "";
      if (!text) return;
      const part = this.liveAssistant();
      part.text += text;
      this.bump();
    } else if (delta.type === "reasoning") {
      const part = this.liveAssistant();
      part.reasoning += delta.text ?? "";
      this.bump();
    } else if (delta.type === "stream_reset") {
      for (const part of this.parts) if (part.kind === "assistant" && part.streaming) { part.text = ""; part.reasoning = ""; }
      this.parts = this.parts.filter((part) => !(part.kind === "tool" && part.call.streamIndex !== undefined));
      this.bump();
    } else if (delta.type === "tool_call") {
      const index = delta.index ?? 0;
      const current = this.parts.find((part): part is Extract<ChatPart, { kind: "tool" }> => part.kind === "tool" && part.turnNumber === this.turnNumber && part.call.streamIndex === index);
      if (current) {
        current.call.name = delta.name || current.call.name;
        current.call.arguments = delta.arguments ?? current.call.arguments;
      } else this.parts.push({ kind: "tool", turnNumber: this.turnNumber, call: { callId: `stream-${this.turnNumber}-${index}`, streamIndex: index, name: delta.name || "tool", arguments: delta.arguments || "", done: false, status: "running" } });
      this.bump();
    }
  }

  private applyCommandResult(frame: GatewayTurnCommandResultFrame): void {
    const result = frame.result;
    if (!result) return;
    if (result.status === "rejected") {
      const text = result.message || result.code || `${result.command} was rejected.`;
      this.parts.push({ kind: "system", text, level: "error" });
      this.bump();
    }
  }

  private applyProcess(frame: { process?: Record<string, unknown> }): void {
    this.processes.update(asRecord(frame.process));
  }

  private applyNotices(frame: OrganismFrame): void {
    const list =
      Array.isArray(frame.notices)
        ? frame.notices
        : frame.text !== undefined
          ? [{ text: frame.text, level: frame.level }]
          : [];
    for (const notice of list) {
      this.noticeCountValue += 1;
      const level = (typeof notice.level === "string" ? notice.level : "info").toLowerCase();
      const text = asString(notice.text);
      if (text && (level === "warn" || level === "warning" || level === "error")) {
        this.parts.push({ kind: "system", text, level: level === "error" ? "error" : "warn" });
      }
    }
  }

  // -------------------------------------------------------------- projection

  applyHeader(header: {
    title?: string;
    session_usage?: {
      input?: number;
      output?: number;
      cached?: number;
      total?: number;
      cost_known?: boolean;
      cost?: number;
    };
    context_usage?: { model?: string };
  }): void {
    if (header.title) this.titleValue = header.title;
    const u = header.session_usage;
    if (u) {
      this.totalsValue = {
        input: u.input ?? this.totalsValue.input,
        output: u.output ?? this.totalsValue.output,
        cached: u.cached ?? this.totalsValue.cached,
        total: u.total ?? this.totalsValue.total,
        costUsd: u.cost ?? this.totalsValue.costUsd,
        costKnown: u.cost_known ?? this.totalsValue.costKnown,
        turns: this.totalsValue.turns,
      };
    }
    const model = header.context_usage?.model;
    if (model) this.modelValue = model;
    this.bump();
  }

  setModelEffort(model?: string, provider?: string, effort?: string): void {
    if (model) this.modelValue = model;
    if (provider) this.providerValue = provider;
    if (effort !== undefined) this.effortValue = effort || undefined;
    this.bump();
  }

  setThreads(rows: SessionRow[], sessionId: string): void {
    const children = rows.filter((row)=>row.parent_id===sessionId);
    if (!this.seenChildIds || this.sessionIdValue !== sessionId) {
      this.seenChildIds = new Set(children.map((row)=>row.id));
      this.pendingSpawnIds.clear(); this.notifiedSpawnIds.clear();
    } else {
      for (const child of children) {
        if (!this.seenChildIds.has(child.id)) this.pendingSpawnIds.add(child.id);
        this.seenChildIds.add(child.id);
        if (child.source === "fork" && this.pendingSpawnIds.has(child.id) && !this.notifiedSpawnIds.has(child.id)) {
          this.notifiedSpawnIds.add(child.id); this.pendingSpawnIds.delete(child.id);
          this.parts.push({kind:"system",text:`Spawned subagent: ${child.title || child.prompt || child.id}`,level:"info",childSessionId:child.id});
        }
      }
    }
    this.sessionIdValue = sessionId;
    this.threadRows = rows;
    this.bump();
  }

  userPrompts(): string[] {
    const out: string[] = [];
    for (const part of this.parts) if (part.kind === "user") out.push(part.text);
    return out;
  }

  view(): StoreView {
    const snapshot = this.queueSnapshot;
    const queue = snapshot && Array.isArray(snapshot.pending_prompts) ? snapshot.pending_prompts : [];
    const activeTurnId = snapshot && snapshot.active_turn !== undefined ? (snapshot.active_turn ?? null) : this.activeTurnId;
    const liveStreaming = this.parts.some(
      (part) => part.kind === "assistant" && part.streaming && (part.text.length > 0 || part.reasoning.length > 0),
    );
    return {
      replayComplete: this.replayCompleteValue,
      ...sessionFamily(this.threadRows, this.sessionIdValue, this.activeSessions),
      modifiedFiles: recordedFileChanges(this.parts, this.sessionIdValue),
      title: this.titleValue,
      cwd: this.cwdValue,
      sessionId: this.sessionIdValue,
      parts: [...this.parts],
      queue,
      activeTurnId,
      activeTurnSteerable: snapshot?.active_turn_steerable === true,
      running: this.runningSinceTurn || activeTurnId !== null || liveStreaming,
      lastUsage: this.lastUsageValue,
      totals: this.totalsValue,
      model: this.modelValue ?? (typeof this.lastUsageValue?.model === "string" ? this.lastUsageValue.model : undefined),
      provider:
        this.providerValue ?? (typeof this.lastUsageValue?.provider === "string" ? this.lastUsageValue.provider : undefined),
      effort: this.effortValue,
      processes: this.processes.view(),
      noticeCount: this.noticeCountValue,
    };
  }
}

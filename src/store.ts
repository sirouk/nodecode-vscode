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
  isTerminalEventType,
} from "./protocol";

export interface ChatToolCall {
  callId: string;
  name: string;
  arguments: string;
  result?: string;
  durationMs?: number;
  failed?: boolean;
  done: boolean;
}

export type ChatPart =
  | { kind: "user"; text: string; promptId?: string; turnNumber: number }
  | { kind: "assistant"; text: string; reasoning: string; turnNumber: number; streaming: boolean; durable: boolean }
  | { kind: "tool"; call: ChatToolCall; turnNumber: number }
  | { kind: "system"; text: string; level: "info" | "warn" | "error" };

export interface BgProcess {
  id: string;
  command: string;
  status: string;
  execId?: string | number;
  toolCallId?: string;
}

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

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Defensive text extraction from a gateway message object. */
export function messageText(message: SessionMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const item of content) {
      const rec = asRecord(item);
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

export class SessionStore {
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
  private readonly processes = new Map<string, BgProcess>();
  private noticeCountValue = 0;
  private revision = 0;

  onDidChange: (revision: number) => void = () => {};

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
        this.applyProcess(frame as { process?: Record<string, unknown> });
        break;
      case "model_changed": {
        const f = frame as { model?: string; provider?: string; effort?: string };
        if (f.model) this.modelValue = f.model;
        if (f.provider) this.providerValue = f.provider;
        if (f.effort) this.effortValue = f.effort;
        break;
      }
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
    // A resume always restarts the durable view from the replay it carries.
    this.reset();
    this.sessionIdValue = frame.session_id ?? this.sessionIdValue;
    for (const inner of frame.accumulated_frames ?? []) this.applyEvent(inner);
    this.bump();
  }

  private reset(): void {
    this.parts = [];
    this.lastSequence = 0;
    this.durableTurnTexts = [];
    this.liveText = "";
    this.liveReasoning = "";
    this.runningSinceTurn = false;
  }

  private bump(): void {
    this.revision += 1;
    this.onDidChange(this.revision);
  }

  // ----------------------------------------------------------------- events

  private applyEvent(frame: SessionStreamEventFrame): void {
    const seq = typeof frame.sequence === "number" ? frame.sequence : 0;
    if (seq && seq <= this.lastSequence) return; // replay idempotence
    if (seq) this.lastSequence = seq;
    const event = frame.event as SessionStreamEvent | undefined;
    if (!event || typeof event.type !== "string") return;
    const payload = asRecord((event as { payload?: unknown }).payload);
    switch (event.type) {
      case "session.created": {
        const cwd = asString(payload.cwd);
        if (cwd) this.cwdValue = cwd;
        const id = asString(payload.id);
        if (id) this.sessionIdValue = id;
        break;
      }
      case "turn.input_committed": {
        const text = messageText(payload.message as SessionMessage | undefined) || asString(payload.text);
        const role = asString(payload.role) || "user";
        if (text) {
          if (role === "user") {
            this.parts.push({
              kind: "user",
              text,
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
        this.liveText = "";
        this.liveReasoning = "";
        break;
      }
      case "turn.assistant_message_completed": {
        const message = payload.message as SessionMessage | undefined;
        const text = messageText(message);
        const last = this.parts[this.parts.length - 1];
        if (last && last.kind === "assistant" && last.streaming && last.turnNumber === this.turnNumber) {
          if (text) last.text = text;
          last.streaming = false;
          last.durable = true;
        } else if (text) {
          this.parts.push({
            kind: "assistant",
            text,
            reasoning: "",
            turnNumber: this.turnNumber,
            streaming: false,
            durable: true,
          });
        }
        break;
      }
      case "turn.tool_call_started": {
        const callId = asString(payload["call-id"]);
        const name = asString(payload["tool-name"]) || "tool";
        const args = asString(payload.arguments);
        const existing = callId ? this.findTool(callId) : undefined;
        if (existing) {
          existing.call.name = name;
          if (args) existing.call.arguments = args;
        } else {
          this.parts.push({
            kind: "tool",
            call: { callId: callId || `tool-${this.parts.length}`, name, arguments: args, done: false },
            turnNumber: this.turnNumber,
          });
        }
        break;
      }
      case "turn.tool_result": {
        const callId = asString(payload["call-id"]);
        const failed = payload.failed === true;
        const result = asString(payload.result);
        const durationMs = typeof payload["duration-ms"] === "number" ? (payload["duration-ms"] as number) : undefined;
        const existing = callId ? this.findTool(callId) : undefined;
        if (existing) {
          if (result) existing.call.result = result;
          existing.call.failed = failed;
          if (durationMs !== undefined) existing.call.durationMs = durationMs;
          existing.call.done = true;
        } else {
          this.parts.push({
            kind: "tool",
            call: {
              callId: callId || `tool-${this.parts.length}`,
              name: asString(payload["tool-name"]) || "tool",
              arguments: "",
              result,
              failed,
              durationMs,
              done: true,
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
        this.sealLive();
        break;
      case "turn.failed": {
        this.runningSinceTurn = false;
        this.sealLive();
        const message = asString(payload.message) || "Turn failed.";
        this.parts.push({ kind: "system", text: message, level: "error" });
        break;
      }
      case "turn.cancelled":
        this.runningSinceTurn = false;
        this.sealLive();
        this.parts.push({ kind: "system", text: "Turn cancelled.", level: "info" });
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
    const last = this.parts[this.parts.length - 1];
    if (last && last.kind === "assistant" && last.streaming) last.streaming = false;
  }

  private applyDelta(frame: { delta?: { type?: string; text?: string; arguments?: string } }): void {
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
      const last = this.parts[this.parts.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        last.text = "";
        this.bump();
      }
    }
    // tool_call deltas are superseded by the durable tool facts and not rendered
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
    const proc = asRecord(frame.process);
    const id =
      asString(proc.shell_session_id) ||
      asString(proc.exec_id) ||
      asString(proc.tool_call_id) ||
      JSON.stringify(proc).slice(0, 40);
    const command = asString(proc.command) || "(background process)";
    const status = asString(proc.status) || "updated";
    const execId =
      (proc.exec_id as string | number | undefined) ?? (proc.shell_session_id as string | number | undefined);
    const toolCallId = asString(proc.tool_call_id) || undefined;
    this.processes.set(id, { id, command, status, execId, toolCallId });
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

  userPrompts(): string[] {
    const out: string[] = [];
    for (const part of this.parts) if (part.kind === "user") out.push(part.text);
    return out;
  }

  view(): StoreView {
    const snapshot = this.queueSnapshot;
    const queue = snapshot && Array.isArray(snapshot.pending_prompts) ? snapshot.pending_prompts : [];
    const activeTurnId = snapshot && snapshot.active_turn !== undefined ? (snapshot.active_turn ?? null) : null;
    const liveStreaming = this.parts.some(
      (part) => part.kind === "assistant" && part.streaming && (part.text.length > 0 || part.reasoning.length > 0),
    );
    return {
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
      processes: [...this.processes.values()],
      noticeCount: this.noticeCountValue,
    };
  }
}

// Wire protocol for `nodecode rpc` newline-delimited JSON frames.
//
// One rpc child process per attached session. Commands are written to stdin
// as single-line JSON; frames arrive on stdout, one JSON object per line.
// Durable facts arrive as `session_stream_event` frames carrying a monotonic
// `sequence`; positional deltas (`item_delta`) and command replies
// (`gateway_turn_command_result`) are not part of the fact stream.

export const NODECODE_CLI_UNKNOWN_VERSION = "unknown";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "failed";
export type TurnCommandStatus = "accepted" | "queued" | "rejected";
export type TurnAdmission = "started" | "follow-up";
export type Effort = string; // ladder comes from GET /api/gateway/target .efforts

// ---------------------------------------------------------------------------
// Commands (extension -> gateway)
// ---------------------------------------------------------------------------

export interface RpcCommandBase {
  type: string;
  command_id?: string;
  session_id?: string;
}

export interface StartTurnCommand extends RpcCommandBase {
  type: "start_turn";
  prompt: string;
}

export interface SteerTurnCommand extends RpcCommandBase {
  type: "steer_turn";
  expected_turn_id: string;
  prompt: string;
}

export interface WithdrawPromptCommand extends RpcCommandBase {
  type: "withdraw_prompt";
  prompt_id: string;
}

export interface CancelTurnCommand extends RpcCommandBase {
  type: "cancel_turn";
  turn_id?: string;
  retract?: boolean;
}

export interface InterruptExecCommand extends RpcCommandBase {
  type: "interrupt_exec";
  exec_id: string | number;
}

export interface NavigateCheckpointCommand extends RpcCommandBase {
  type: "navigate_checkpoint";
  target_turn_id?: string;
  direction?: "undo" | "redo";
  restore_files?: boolean;
}

export interface SetSessionSubscriptionsCommand extends RpcCommandBase {
  type: "set_session_subscriptions";
  session_ids: string[];
}

export interface GetStateCommand extends RpcCommandBase {
  type: "get_state";
}

export type RpcCommand =
  | StartTurnCommand
  | SteerTurnCommand
  | WithdrawPromptCommand
  | CancelTurnCommand
  | InterruptExecCommand
  | NavigateCheckpointCommand
  | SetSessionSubscriptionsCommand
  | GetStateCommand;

// ---------------------------------------------------------------------------
// Frames (gateway -> extension)
// ---------------------------------------------------------------------------

export interface RpcFrameBase {
  type: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface SessionStreamEventFrame extends RpcFrameBase {
  type: "session_stream_event";
  sequence: number;
  event: SessionStreamEvent;
}

export interface SessionStreamResumedFrame extends RpcFrameBase {
  type: "session_stream_resumed";
  session_id: string;
  accumulated_frames: SessionStreamEventFrame[];
  cursor?: number | null;
  resumed_after?: number | null;
}

export interface ItemDelta {
  type: "text" | "reasoning" | "tool_call" | "stream_reset" | "fallback";
  text?: string;
  arguments?: string;
  [key: string]: unknown;
}

export interface ItemDeltaFrame extends RpcFrameBase {
  type: "item_delta";
  delta: ItemDelta;
}

export interface GatewayTurnCommandResult {
  command: string;
  command_id?: string;
  status: TurnCommandStatus;
  code?: string;
  message?: string;
  turn_id?: string;
  queue_depth?: number;
  turn_admission?: TurnAdmission;
}

export interface GatewayTurnCommandResultFrame extends RpcFrameBase {
  type: "gateway_turn_command_result";
  result: GatewayTurnCommandResult;
}

export interface PendingPrompt {
  prompt_id: string;
  command_id?: string;
  content?: string;
  sequence?: number;
}

export interface TurnQueueSnapshot {
  version?: number;
  active_turn?: string | null;
  active_turn_steerable?: boolean;
  count?: number;
  pending_prompts?: PendingPrompt[];
}

export interface SessionInputQueueSnapshotFrame extends RpcFrameBase {
  type: "session_input_queue_snapshot_updated";
  session_id: string;
  snapshot: TurnQueueSnapshot;
}

export interface BackgroundProcess {
  shell_session_id?: string | number;
  tool_call_id?: string;
  command?: string;
  status?: string;
  exec_id?: string | number;
  session_id?: string;
  [key: string]: unknown;
}

export interface SessionBackgroundProcessFrame extends RpcFrameBase {
  type: "session_background_process_updated";
  session_id: string;
  process: BackgroundProcess;
}

export interface SessionTitledFrame extends RpcFrameBase {
  type: "session_titled";
  session_id: string;
  title: string;
}

export interface ModelChangedFrame extends RpcFrameBase {
  type: "model_changed";
  session_id?: string;
  model?: string;
  provider?: string;
  effort?: string;
}

export interface SessionResyncRequiredFrame extends RpcFrameBase {
  type: "session_resync_required";
  session_id?: string;
  reason?: string;
}

export interface OrganismNotice {
  text?: string;
  level?: string;
  [key: string]: unknown;
}

export interface OrganismFrame extends RpcFrameBase {
  type: "organism.notices" | "organism.notice" | "organism.activity" | "organism.cells";
  notices?: OrganismNotice[];
  text?: string;
  level?: string;
  sessions?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export type RpcFrame =
  | SessionStreamEventFrame
  | SessionStreamResumedFrame
  | ItemDeltaFrame
  | GatewayTurnCommandResultFrame
  | SessionInputQueueSnapshotFrame
  | SessionBackgroundProcessFrame
  | SessionTitledFrame
  | ModelChangedFrame
  | SessionResyncRequiredFrame
  | OrganismFrame
  | RpcFrameBase;

// ---------------------------------------------------------------------------
// Durable stream events (payloads of session_stream_event)
// ---------------------------------------------------------------------------

export interface SessionMessage {
  role?: string;
  content?: unknown;
  parts?: MessagePart[];
  [key: string]: unknown;
}

export interface ToolCallInfo {
  callId?: string;
  name?: string;
  arguments?: string;
  result?: string;
  durationMs?: number;
  failed?: boolean;
  metadata?: Record<string, unknown>;
}

export type SessionStreamEvent =
  | { type: "session.created"; payload: { id?: string; cwd?: string; parent?: string | null; "created-at"?: string } }
  | { type: "turn.input_committed"; payload: { role?: string; message?: SessionMessage; "prompt-id"?: string; sequence?: number; disposition?: string } }
  | { type: "turn.started"; payload: { input?: unknown } }
  | { type: "turn.assistant_message_completed"; payload: { message?: SessionMessage } }
  | { type: "turn.usage"; payload: RpcUsage }
  | { type: "turn.tool_call_started"; payload: { "call-id"?: string; "tool-name"?: string; arguments?: string } }
  | { type: "turn.tool_result"; payload: { "call-id"?: string; "tool-name"?: string; result?: string; "duration-ms"?: number; failed?: boolean; metadata?: Record<string, unknown> } }
  | { type: "turn.completed"; payload: { "turn-number"?: number; "message-count"?: number } }
  | { type: "turn.failed"; payload: { message?: string; code?: string } }
  | { type: "turn.cancelled"; payload: Record<string, unknown> }
  | { type: string; payload?: Record<string, unknown> };

export interface RpcUsage {
  "input-tokens"?: number;
  "output-tokens"?: number;
  "cached-input-tokens"?: number;
  "total-tokens"?: number;
  cost_known?: boolean;
  cost_usd?: number;
  "finish-reason"?: string;
  model?: string;
  provider?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Message parts as rendered by the panel
// ---------------------------------------------------------------------------

export type MessagePart =
  | { part_type: "text"; text: string }
  | { part_type: "reasoning"; summary?: string; content?: string }
  | { part_type: "image"; url: string }
  | { part_type: "tool_call"; tool: ToolCallInfo; id?: string };

export function isStreamEventFrame(f: RpcFrame): f is SessionStreamEventFrame {
  return f.type === "session_stream_event";
}

export function isTerminalEventType(t: string): boolean {
  return t === "turn.completed" || t === "turn.failed" || t === "turn.cancelled";
}

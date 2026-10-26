// One `nodecode rpc SESSION-ID` child per attached session: newline-delimited
// JSON both ways, pending-command correlation by command_id, and exponential-
// backoff restart with native cursor replay on reconnect.

import { ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { NodecodeCli } from "./cli";
import { Notifications } from "./discovery";
import {
  ConnectionState,
  GatewayTurnCommandResult,
  RpcCommand,
  RpcFrame,
  normalizeRpcFrame,
  isReplayComplete,
} from "./protocol";

export interface SentCommand {
  commandId: string;
  done: Promise<GatewayTurnCommandResult>;
}

interface PendingEntry {
  command: string;
  resolve: (result: GatewayTurnCommandResult) => void;
  timer: NodeJS.Timeout;
}

const BACKOFF_STEPS_MS = [250, 500, 1000, 2000, 4000, 8000, 15000, 30000];
const FAILED_AFTER_ATTEMPTS = 12;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class RpcProcess {
  private readonly cli: NodecodeCli;
  private readonly notes: Notifications;
  private readonly workspaceRoot: string;
  private sessionId: string | undefined;

  private proc: ChildProcess | undefined;
  private state: ConnectionState = "disconnected";
  private restartAttempts = 0;
  private everConnected = false;
  private stopping = false;
  private disposed = false;
  private closing = false;
  private closingPromise: Promise<void> | undefined;
  private resumeCursor: number | undefined;
  private reportedAttempts = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private pendingLine = "";
  private pendingStderr = "";
  private readonly pending = new Map<string, PendingEntry>();

  onFrame: (frame: RpcFrame) => void = () => {};
  onStateChanged: (state: ConnectionState, attempts: number) => void = () => {};

  constructor(cli: NodecodeCli, notes: Notifications, workspaceRoot: string, sessionId?: string) {
    this.cli = cli;
    this.notes = notes;
    this.workspaceRoot = workspaceRoot;
    this.sessionId = sessionId;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get attempts(): number {
    return this.restartAttempts;
  }

  setSession(sessionId: string): void {
    if (this.disposed) return;
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.resumeCursor = undefined;
    this.stop();
    this.start();
  }

  start(): void {
    if (this.disposed || this.closing || this.proc) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.stopping = false;
    const child = this.cli.spawnRpc(this.sessionId, this.workspaceRoot, this.resumeCursor);
    if (!child) {
      this.setState("failed");
      return;
    }
    this.proc = child;
    this.pendingLine = "";
    this.pendingStderr = "";
    this.setState(this.everConnected ? "disconnected" : "connecting");

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { if (this.proc === child) this.consume(chunk); });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (this.proc !== child) return;
      this.pendingStderr = (this.pendingStderr + chunk).slice(-8192);
    });
    child.on("error", (error) => {
      if (this.proc !== child) return;
      this.notes.log(`rpc spawn error: ${String(error)}`);
    });
    // close follows stdout/stderr drainage, and also fires when spawning fails.
    child.on("close", (code, signal) => {
      if (this.proc !== child) return;
      this.proc = undefined;
      this.rejectPending("Connection closed before acknowledgement; outcome unknown. Check session state before retrying.");
      const tail = this.pendingLine.trim();
      if (tail) {
        this.notes.log(`discarding partial rpc line on exit: ${tail.slice(0, 200)}`);
        this.pendingLine = "";
      }
      if (this.stopping) return;
      const detail = this.pendingStderr.trim().split(/\r?\n/).pop() ?? "";
      this.notes.log(
        `rpc exited (code ${String(code)} signal ${String(signal)})${detail ? ` — ${detail}` : ""}`,
      );
      this.scheduleRestart();
    });
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.proc;
    this.proc = undefined;
    this.setState("disconnected");
    this.rejectPending("connection closed");
    try {
      child?.stdin?.end();
      child?.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /** Let the CLI close its gateway subscription before deleting its session. */
  async stopAndWait(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    const child = this.proc;
    if (!child) { this.stop(); return; }
    this.stopping = true;
    this.closing = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.setState("disconnected");
    this.rejectPending("connection closed");
    this.closingPromise = new Promise<void>((resolve, reject) => {
      let forceTimer: NodeJS.Timeout;
      const timer = setTimeout(() => child.kill("SIGTERM"), 1500);
      const closed = (): void => {
        clearTimeout(timer);
        clearTimeout(forceTimer);
        if (this.proc === child) this.proc = undefined;
        resolve();
      };
      child.once("close", closed);
      forceTimer = setTimeout(() => {
        child.removeListener("close", closed);
        if (this.proc === child) this.proc = undefined;
        try { child.kill("SIGKILL"); } catch { /* owned CLI already ended */ }
        reject(new Error("Nodecode session connection did not close; deletion cancelled"));
      }, 3500);
      child.stdin?.end();
    });
    try { await this.closingPromise; }
    finally { this.closingPromise = undefined; this.closing = false; }
  }

  /** Restart immediately (used for session_resync_required / resubscribe). */
  resync(): void {
    this.resumeCursor = undefined;
    this.reconnect(true);
  }

  private reconnect(immediate = false): void {
    if (this.disposed || this.closing) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.proc;
    this.proc = undefined;
    this.stopping = false;
    this.rejectPending("Connection interrupted before acknowledgement; outcome unknown. Check session state before retrying.");
    try {
      child?.kill("SIGTERM");
    } catch {
      /* noop */
    }
    this.setState("disconnected");
    this.scheduleRestart(immediate ? 0 : undefined);
  }

  sendCommand(command: RpcCommand): SentCommand | undefined {
    if (this.disposed || this.closing) return undefined;
    if (!this.proc || !this.proc.stdin?.writable) {
      this.start();
      if (!this.proc) return undefined;
    }
    // The gateway remembers ids across reconnects; a per-process counter collides.
    const commandId = `vscode-${randomUUID()}`;
    let wire: Record<string, unknown> = { type: command.type, command_id: commandId };
    for (const [key, value] of Object.entries(command)) {
      if (key === "type" || key === "command_id" || value === undefined) continue;
      wire[key] = value;
    }
    if (this.sessionId && !wire.session_id) wire.session_id = this.sessionId;
    // The CLI accepts turn inputs under request; control commands stay flat.
    if (command.type === "start_turn" || command.type === "steer_turn") {
      const { type, command_id, ...request } = wire;
      wire = { type, command_id, request };
    }

    let resolveFn: ((result: GatewayTurnCommandResult) => void) | undefined;
    const done = new Promise<GatewayTurnCommandResult>((resolve) => {
      resolveFn = resolve;
    });
    const timer = setTimeout(() => {
      const entry = this.pending.get(commandId);
      if (!entry) return;
      this.pending.delete(commandId);
      entry.resolve({ command: command.type, command_id: commandId, status: "rejected", code:"acknowledgement_unknown", message: "Command acknowledgement timed out; outcome unknown. Check session state before retrying." });
    }, 30000);
    this.pending.set(commandId, { command: command.type, resolve: resolveFn!, timer });

    try {
      const proc = this.proc;
      proc.stdin!.write(JSON.stringify(wire) + "\n");
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(commandId);
      resolveFn!({
        command: command.type,
        command_id: commandId,
        status: "rejected",
        message: `failed to write to rpc stdin: ${String(error)}`,
      });
    }
    return { commandId, done };
  }

  private consume(chunk: string): void {
    this.pendingLine += chunk;
    const lines = this.pendingLine.split(/\r?\n/);
    this.pendingLine = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (Buffer.byteLength(trimmed,"utf8") > MAX_FRAME_BYTES) { this.notes.log("rpc frame exceeds native 16 MiB limit"); this.reconnect(); return; }
      let frame: RpcFrame;
      try {
        const decoded = normalizeRpcFrame(JSON.parse(trimmed));
        if (!decoded) {
          this.notes.log("rpc frame missing a payload type");
          this.reconnect();
          return;
        }
        frame = decoded;
      } catch {
        this.notes.log(`unparseable rpc line: ${trimmed.slice(0, 200)}`);
        this.reconnect();
        return;
      }
      this.dispatch(frame);
      if (this.stopping || !this.proc) return;
    }
    if (Buffer.byteLength(this.pendingLine,"utf8") > MAX_FRAME_BYTES) { this.notes.log("rpc frame exceeds native 16 MiB limit"); this.reconnect(); }
  }

  private dispatch(frame: RpcFrame): void {
    if (frame.type === "session_stream_resumed") {
      const replay = frame as import("./protocol").SessionStreamResumedFrame;
      if (replay.resumed_after == null && (replay.replay_chunk_index == null || replay.replay_chunk_index === 0)) this.resumeCursor = undefined;
      if (isReplayComplete(replay)) {
        const cursor = replay.cursor ?? replay.accumulated_frames.reduce((latest,fact) => Math.max(latest,fact.sequence),0);
        if (Number.isSafeInteger(cursor) && cursor >= 0) this.resumeCursor = cursor;
        this.markConnected();
      }
    } else if (frame.type === "session_stream_event" && this.state === "connected") {
      const cursor = (frame as import("./protocol").SessionStreamEventFrame).sequence;
      if (Number.isSafeInteger(cursor) && cursor >= 0) this.resumeCursor = Math.max(this.resumeCursor ?? 0,cursor);
    } else if (frame.type === "gateway_turn_command_result") {
      const result = (frame as { result: GatewayTurnCommandResult }).result;
      if (result?.command_id) {
        const entry = this.pending.get(result.command_id);
        if (entry) {
          this.pending.delete(result.command_id);
          clearTimeout(entry.timer);
          entry.resolve(result);
        }
      }
    } else if (frame.type === "sync_protocol_error") {
      this.notes.log(`rpc protocol error: ${JSON.stringify(frame).slice(0, 300)}`);
      // The CLI's parser errors have no command_id. None of the outstanding
      // commands can safely be reported as accepted after an uncorrelated error.
      this.rejectPending(`Nodecode protocol error: ${String(frame.message ?? frame.code ?? "command rejected")}`);
    } else if (frame.type === "session_resync_required") {
      this.onFrame(frame);
      this.resync();
      return;
    }
    this.onFrame(frame);
  }

  private rejectPending(message: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ command: entry.command, command_id: id, status: "rejected", code:"acknowledgement_unknown", message });
    }
    this.pending.clear();
  }

  private markConnected(): void {
    const was = this.state;
    this.everConnected = true;
    this.restartAttempts = 0;
    this.setState("connected");
    if (was !== "connected") this.notes.log("rpc connected");
  }

  private setState(next: ConnectionState): void {
    if (this.state === next && this.reportedAttempts === this.restartAttempts) return;
    this.state = next;
    this.reportedAttempts = this.restartAttempts;
    this.onStateChanged(next, this.restartAttempts);
  }

  private scheduleRestart(delayOverride?: number): void {
    if (this.stopping || this.disposed || this.closing || this.restartTimer) return;
    this.restartAttempts += 1;
    this.setState(this.restartAttempts >= FAILED_AFTER_ATTEMPTS ? "failed" : "disconnected");
    const delay =
      delayOverride ?? BACKOFF_STEPS_MS[Math.min(this.restartAttempts - 1, BACKOFF_STEPS_MS.length - 1)];
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.stopping = false;
      this.start();
    }, delay);
  }
}

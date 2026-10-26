// One `nodecode rpc SESSION-ID` child per attached session: newline-delimited
// JSON both ways, pending-command correlation by command_id, and exponential-
// backoff restart with full replay on reconnect.

import { ChildProcess } from "child_process";
import { NodecodeCli } from "./cli";
import { Notifications } from "./discovery";
import {
  ConnectionState,
  GatewayTurnCommandResult,
  RpcCommand,
  RpcFrame,
} from "./protocol";

export interface SentCommand {
  commandId: string;
  done: Promise<GatewayTurnCommandResult>;
}

interface PendingEntry {
  command: string;
  resolve: (result: GatewayTurnCommandResult) => void;
}

const BACKOFF_STEPS_MS = [250, 500, 1000, 2000, 4000, 8000, 15000, 30000];
const FAILED_AFTER_ATTEMPTS = 12;

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
  private restartTimer: NodeJS.Timeout | undefined;
  private pendingLine = "";
  private pendingStderr = "";
  private commandCounter = 0;
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
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.stop();
    this.start();
  }

  start(): void {
    this.stopping = false;
    if (this.proc) return;
    const child = this.cli.spawnRpc(this.sessionId, this.workspaceRoot);
    if (!child) {
      this.setState("failed");
      return;
    }
    this.proc = child;
    this.pendingLine = "";
    this.pendingStderr = "";
    this.setState(this.everConnected ? "disconnected" : "connecting");

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.consume(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.pendingStderr = (this.pendingStderr + chunk).slice(-8192);
    });
    child.on("error", (error) => {
      this.notes.log(`rpc spawn error: ${String(error)}`);
    });
    child.on("exit", (code, signal) => {
      this.proc = undefined;
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
    for (const [id, entry] of this.pending) {
      entry.resolve({ command: entry.command, command_id: id, status: "rejected", message: "connection closed" });
    }
    this.pending.clear();
    try {
      child?.stdin?.end();
      child?.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  dispose(): void {
    this.stop();
  }

  /** Restart immediately (used for session_resync_required / resubscribe). */
  resync(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.proc;
    this.proc = undefined;
    this.stopping = false;
    try {
      child?.kill("SIGTERM");
    } catch {
      /* noop */
    }
    this.setState("disconnected");
    this.scheduleRestart(0);
  }

  sendCommand(command: RpcCommand): SentCommand | undefined {
    if (!this.proc || !this.proc.stdin?.writable) {
      this.start();
      if (!this.proc) return undefined;
    }
    const commandId = `c${++this.commandCounter}`;
    const wire: Record<string, unknown> = { type: command.type, command_id: commandId };
    for (const [key, value] of Object.entries(command)) {
      if (key === "type" || key === "command_id" || value === undefined) continue;
      wire[key] = value;
    }
    if (this.sessionId && !wire.session_id) wire.session_id = this.sessionId;

    let resolveFn: ((result: GatewayTurnCommandResult) => void) | undefined;
    const done = new Promise<GatewayTurnCommandResult>((resolve) => {
      resolveFn = resolve;
    });
    this.pending.set(commandId, { command: command.type, resolve: resolveFn! });

    try {
      const proc = this.proc;
      proc.stdin!.write(JSON.stringify(wire) + "\n");
    } catch (error) {
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
      let frame: RpcFrame;
      try {
        frame = JSON.parse(trimmed) as RpcFrame;
      } catch {
        this.notes.log(`unparseable rpc line: ${trimmed.slice(0, 200)}`);
        continue;
      }
      this.dispatch(frame);
    }
  }

  private dispatch(frame: RpcFrame): void {
    if (frame.type === "session_stream_resumed") {
      this.markConnected();
    } else if (frame.type === "gateway_turn_command_result") {
      const result = (frame as { result: GatewayTurnCommandResult }).result;
      if (result?.command_id) {
        const entry = this.pending.get(result.command_id);
        if (entry) {
          this.pending.delete(result.command_id);
          entry.resolve(result);
        }
      } else if (result?.command) {
        for (const [id, entry] of this.pending) {
          if (entry.command === result.command) {
            this.pending.delete(id);
            entry.resolve({ ...result, command_id: id });
            break;
          }
        }
      }
    } else if (frame.type === "sync_protocol_error") {
      this.notes.log(`rpc protocol error: ${JSON.stringify(frame).slice(0, 300)}`);
    } else if (frame.type === "session_resync_required") {
      this.onFrame(frame);
      this.resync();
      return;
    }
    this.onFrame(frame);
  }

  private markConnected(): void {
    const was = this.state;
    this.everConnected = true;
    this.restartAttempts = 0;
    this.setState("connected");
    if (was !== "connected") this.notes.log("rpc connected");
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChanged(next, this.restartAttempts);
  }

  private scheduleRestart(delayOverride?: number): void {
    if (this.stopping) return;
    this.restartAttempts += 1;
    if (!this.everConnected || this.restartAttempts >= FAILED_AFTER_ATTEMPTS) {
      this.setState("failed");
      return;
    }
    this.setState("disconnected");
    const delay =
      delayOverride ?? BACKOFF_STEPS_MS[Math.min(this.restartAttempts - 1, BACKOFF_STEPS_MS.length - 1)];
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.stopping = false;
      this.start();
    }, delay);
  }
}

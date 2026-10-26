// A SessionController owns one RpcProcess + one SessionStore for a session,
// and refreshes the session header (usage totals, title, model) after turn
// boundaries, debounced.

import { NodecodeApi } from "./api";
import { NodecodeCli } from "./cli";
import { Notifications } from "./discovery";
import {
  ConnectionState,
  GatewayTurnCommandResult,
  RpcFrame,
  SessionStreamEventFrame,
  isTerminalEventType,
} from "./protocol";
import { RpcProcess, SentCommand } from "./rpc";
import { SessionStore } from "./store";

export class SessionController {
  readonly store = new SessionStore();
  readonly rpc: RpcProcess;
  sessionId: string;
  onConnectionChanged: (state: ConnectionState, attempts: number) => void = () => {};
  private headerTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly cli: NodecodeCli,
    private readonly notes: Notifications,
    private readonly api: NodecodeApi,
    private readonly workspaceRoot: string,
    sessionId: string,
  ) {
    this.sessionId = sessionId;
    this.rpc = new RpcProcess(cli, notes, workspaceRoot, sessionId);
    this.rpc.onFrame = (frame: RpcFrame) => {
      this.store.applyFrame(frame);
      if (frame.type === "session_stream_resumed") {
        this.scheduleHeaderRefresh(50);
      } else if (frame.type === "session_stream_event") {
        const event = (frame as SessionStreamEventFrame).event;
        if (event && isTerminalEventType(event.type)) this.scheduleHeaderRefresh();
      }
    };
    this.rpc.onStateChanged = (state, attempts) => this.onConnectionChanged(state, attempts);
  }

  connect(): void {
    this.rpc.start();
    this.refreshHeader();
    this.refreshTarget();
  }

  private scheduleHeaderRefresh(delayMs = 600): void {
    if (this.headerTimer) clearTimeout(this.headerTimer);
    this.headerTimer = setTimeout(() => {
      this.headerTimer = undefined;
      this.refreshHeader();
    }, delayMs);
  }

  refreshHeader(): void {
    this.api
      .header(this.sessionId)
      .then((header) => this.store.applyHeader(header))
      .catch((error) => this.notes.log(`header refresh failed: ${String(error)}`));
  }

  refreshTarget(): void {
    this.api
      .target()
      .then((target) => {
        this.store.setModelEffort(
          typeof target.model === "string" ? target.model : undefined,
          typeof target.provider === "string" ? target.provider : undefined,
          typeof target.effort === "string" ? target.effort : undefined,
        );
      })
      .catch((error) => this.notes.log(`target refresh failed: ${String(error)}`));
  }

  sendPrompt(text: string): SentCommand | undefined {
    return this.rpc.sendCommand({ type: "start_turn", prompt: text });
  }

  withdraw(promptId: string): SentCommand | undefined {
    return this.rpc.sendCommand({ type: "withdraw_prompt", prompt_id: promptId });
  }

  cancelActive(turnId?: string | null): SentCommand | undefined {
    return this.rpc.sendCommand({ type: "cancel_turn", ...(turnId ? { turn_id: turnId } : {}) });
  }

  steer(expectedTurnId: string, text: string): SentCommand | undefined {
    return this.rpc.sendCommand({ type: "steer_turn", expected_turn_id: expectedTurnId, prompt: text });
  }

  interruptExec(execId: string | number): SentCommand | undefined {
    return this.rpc.sendCommand({ type: "interrupt_exec", exec_id: execId });
  }

  navigateCheckpoint(opts: {
    direction?: "undo" | "redo";
    targetTurnId?: string;
    restoreFiles?: boolean;
  }): Promise<GatewayTurnCommandResult> | undefined {
    const sent = this.rpc.sendCommand({
      type: "navigate_checkpoint",
      ...(opts.direction ? { direction: opts.direction } : {}),
      ...(opts.targetTurnId ? { target_turn_id: opts.targetTurnId } : {}),
      restore_files: opts.restoreFiles ?? true,
    });
    return sent?.done;
  }

  dispose(): void {
    if (this.headerTimer) clearTimeout(this.headerTimer);
    this.rpc.dispose();
  }
}

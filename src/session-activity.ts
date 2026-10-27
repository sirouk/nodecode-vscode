export interface RecordedFileChange {
  path: string;
  added?: number;
  removed?: number;
  binary: boolean;
  patch?: string;
  callId: string;
  changeCount: number;
  truncated?: true;
}

/** Latest call-scoped diff per path, never a global working-tree attribution. */
export function recordedFileChanges(parts: Array<{kind:string;turnNumber?:number;call?:{callId:string;sessionId?:string;turnId?:string;diffOrder?:number;metadata?:Record<string,unknown>}}>, sessionId?:string): RecordedFileChange[] {
  const files = new Map<string, RecordedFileChange>();
  const calls = new Map<string, Set<string>>();
  // Tool rows stay in start order; a background result may arrive much later.
  const ordered = [...parts].sort((a,b) => (a.call?.diffOrder ?? 0) - (b.call?.diffOrder ?? 0));
  for (const part of ordered) {
    if (part.kind !== "tool" || !part.call) continue;
    if (sessionId && part.call.sessionId !== sessionId) continue;
    const document = part.call.metadata?.workspace_diff as {files?:unknown;truncated?:unknown} | undefined;
    if (!Array.isArray(document?.files)) continue;
    for (const value of document.files) {
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.path !== "string" || !value.path) continue;
      const seen = calls.get(value.path) ?? new Set<string>();
      seen.add(JSON.stringify([part.call.sessionId, part.call.turnId ?? part.turnNumber, part.call.callId])); calls.set(value.path, seen);
      files.set(value.path, {
        path:value.path, callId:part.call.callId, changeCount:seen.size,
        added:Number.isSafeInteger(value.added) && value.added >= 0 ? value.added : undefined,
        removed:Number.isSafeInteger(value.removed) && value.removed >= 0 ? value.removed : undefined,
        binary:value.binary === true, patch:typeof value.patch === "string" ? value.patch : undefined,
        ...(document.truncated === true ? {truncated:true as const} : {}),
      });
    }
  }
  return [...files.values()];
}

export interface BackgroundProcessView {
  id: string;
  command: string;
  status: string;
  execId?: number;
  toolCallId?: string;
  output: string;
  preview?: string;
  outputTruncated: boolean;
  exitCode?: number;
  shellExit?: number;
  backgrounded?: boolean;
  error?: string;
  stopped?: unknown;
}

export interface ProcessCheckpoint { view: BackgroundProcessView; bytes: string; offset: number }

interface ProcessState { view:BackgroundProcessView; bytes:Buffer; offset:number }
const MAX_OUTPUT_BYTES = 64 * 1024;

/** Native byte offsets make repeated snapshots and overlapping chunks idempotent. */
export class BackgroundProcesses {
  private readonly rows = new Map<string, ProcessState>();
  clear():void { this.rows.clear(); }
  view():BackgroundProcessView[] { return [...this.rows.values()].map((row)=>({...row.view})); }
  markUnconfirmed(): void {
    for (const row of this.rows.values()) if (row.view.status === "running") row.view = {...row.view, status:"unknown"};
  }
  snapshot(): ProcessCheckpoint[] { return [...this.rows.values()].map(row => ({view:row.view, bytes:row.bytes.toString("base64"), offset:row.offset})); }
  restore(rows: ProcessCheckpoint[]): void {
    this.rows.clear();
    for (const row of rows) this.rows.set(row.view.id, {view:row.view, bytes:Buffer.from(row.bytes,"base64"), offset:row.offset});
  }

  update(process:Record<string,unknown>):void {
    const execId = typeof process.shell_session_id === "number" && Number.isSafeInteger(process.shell_session_id)
      ? process.shell_session_id : typeof process.exec_id === "number" && Number.isSafeInteger(process.exec_id) ? process.exec_id : undefined;
    const id = execId !== undefined ? String(execId) : typeof process.tool_call_id === "string" ? process.tool_call_id : undefined;
    if (!id) return;
    let prior = this.rows.get(id);
    // Registry IDs may be reused after a gateway restart; a new owning call
    // or a fresh running transition must not inherit old output/exit details.
    if (prior && ((process.status === "running" && prior.view.status === "exited") ||
        (typeof process.tool_call_id === "string" && prior.view.toolCallId && process.tool_call_id !== prior.view.toolCallId))) prior = undefined;
    let bytes = prior?.bytes ?? Buffer.alloc(0), offset = prior?.offset ?? 0;
    let truncated = (prior?.view.outputTruncated ?? false) || process.tail_cut === true;
    if (typeof process.output_b64 === "string") {
      const chunk = Buffer.from(process.output_b64,"base64");
      const incoming = typeof process.offset === "number" && Number.isSafeInteger(process.offset) && process.offset >= 0 ? process.offset : offset + bytes.length;
      const end = offset + bytes.length;
      if (!prior || incoming > end) {
        bytes=chunk;offset=incoming;truncated=truncated||incoming>0;
      } else if (incoming + chunk.length > end) bytes=Buffer.concat([bytes,chunk.subarray(end-incoming)]);
      if (bytes.length > MAX_OUTPUT_BYTES) {
        let drop=bytes.length-MAX_OUTPUT_BYTES;
        while(drop<bytes.length && (bytes[drop]&0xc0)===0x80)drop++;
        offset+=drop;bytes=bytes.subarray(drop);truncated=true;
      }
    }
    // A chunk can end midway through a UTF-8 code point. Keep those bytes for
    // the next append rather than flashing a replacement glyph in the stream.
    const output = bytes.length ? new TextDecoder("utf-8").decode(bytes,{stream:process.status !== "exited"})
      : typeof process.tail === "string" ? process.tail : prior?.view.output ?? "";
    const preview = typeof process.preview_b64 === "string" ? Buffer.from(process.preview_b64,"base64").toString("utf8") : prior?.view.preview;
    this.rows.set(id,{bytes,offset,view:{
      id,execId,command:typeof process.command === "string" ? process.command : prior?.view.command ?? "Background process",
      status:typeof process.status === "string" ? process.status : prior?.view.status ?? "unknown",
      toolCallId:typeof process.tool_call_id === "string" ? process.tool_call_id : prior?.view.toolCallId,
      output,preview,outputTruncated:truncated,
      exitCode:typeof process.exit_code === "number" ? process.exit_code : prior?.view.exitCode,
      shellExit:typeof process.shell_exit === "number" ? process.shell_exit : prior?.view.shellExit,
      backgrounded:process.backgrounded === true || prior?.view.backgrounded === true,
      error:typeof process.error === "string" ? process.error : prior?.view.error,
      stopped:process.stopped ?? prior?.view.stopped,
    }});
  }
}

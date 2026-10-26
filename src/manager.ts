// A SessionController owns one RpcProcess + one SessionStore for a session,
// and refreshes the session header (usage totals, title, model) after turn
// boundaries, debounced.

import { NodecodeApi, SlashCommand, SlashResult } from "./api";
import { NodecodeCli } from "./cli";
import { Notifications } from "./discovery";
import {
  ConnectionState,
  ImageAttachment,
  TextFileAttachment,
  PromptContent,
  GatewayTurnCommandResult,
  RpcFrame,
  SessionStreamEventFrame,
  isTerminalEventType,
} from "./protocol";
import { RpcProcess, SentCommand } from "./rpc";
import { SessionStore } from "./store";
import { withFileReferences } from "./file-context";
import { TextAttachmentStore, TextAttachmentChunk, MAX_PROMPT_TEXT_CHARS, appendTextFileReferences } from "./text-attachments";
import { AttachmentSelection, FileBrowserOptions, FileBrowserListing, SelectedFileInput, browseRuntimeDirectory, readSelectedRuntimeFiles, selectedImage, MAX_SELECTED_TOTAL_BYTES } from "./file-browser";

export class SessionController {
  readonly store = new SessionStore();
  readonly rpc: RpcProcess;
  sessionId: string;
  onActivity: (sessions: string[]) => void = () => {};
  onConnectionChanged: (state: ConnectionState, attempts: number) => void = () => {};
  private readonly connectionListeners = new Set<(state: ConnectionState, attempts: number) => void>();

  subscribeConnection(listener: (state: ConnectionState, attempts: number) => void): { dispose(): void } {
    this.connectionListeners.add(listener);
    return { dispose: () => this.connectionListeners.delete(listener) };
  }

  private headerTimer: NodeJS.Timeout | undefined;
  private threadsTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private headerRevision = 0;
  private targetRevision = 0;
  private threadsRevision = 0;
  private readonly textAttachments: TextAttachmentStore;
  private readonly browsedFiles = new WeakMap<object, Set<string>>();

  constructor(
    private readonly cli: NodecodeCli,
    private readonly notes: Notifications,
    private readonly api: NodecodeApi,
    private readonly workspaceRoot: string,
    sessionId: string,
    storageRoot?: string,
  ) {
    this.sessionId = sessionId;
    this.textAttachments = new TextAttachmentStore(storageRoot, sessionId);
    this.rpc = new RpcProcess(cli, notes, workspaceRoot, sessionId);
    this.rpc.onFrame = (frame: RpcFrame) => {
      if (this.disposed) return;
      this.store.applyFrame(frame);
      if (frame.type === "organism.activity" && Array.isArray(frame.sessions)) {
        this.onActivity(frame.sessions.flatMap((row: { id?: unknown }) => typeof row.id === "string" ? [row.id] : []));
      }
      if (frame.type === "model_changed") this.refreshTarget();
      if (frame.type === "organism.activity" || frame.type === "session_titled") this.scheduleThreadsRefresh();
      if (frame.type === "session_stream_resumed") {
        this.scheduleHeaderRefresh(50);
        this.scheduleThreadsRefresh();
      } else if (frame.type === "session_stream_event") {
        const event = (frame as SessionStreamEventFrame).event;
        if (event && isTerminalEventType(event.type)) this.scheduleHeaderRefresh();
      }
    };
    this.rpc.onStateChanged = (state, attempts) => {
      if (this.disposed) return;
      this.onConnectionChanged(state, attempts);
      for (const listener of this.connectionListeners) listener(state, attempts);
    };
  }

  connect(): void {
    if (this.disposed) return;
    this.rpc.start();
    this.refreshHeader();
    this.refreshTarget();
    this.refreshThreads();
  }

  private scheduleHeaderRefresh(delayMs = 600): void {
    if (this.disposed) return;
    if (this.headerTimer) clearTimeout(this.headerTimer);
    this.headerTimer = setTimeout(() => {
      this.headerTimer = undefined;
      this.refreshHeader();
    }, delayMs);
  }

  imageUrl(id: string): string {
    return this.api.imageUrl(this.sessionId, id);
  }

  refreshHeader(): void {
    if (this.disposed) return;
    const revision = ++this.headerRevision;
    this.api.sessionDetail(this.sessionId)
      .then(detail => { if (!this.disposed && revision === this.headerRevision) this.store.setSessionDetail(detail); })
      .catch(error => this.notes.log(`session detail refresh failed: ${String(error)}`));
    this.api
      .header(this.sessionId)
      .then((header) => { if (!this.disposed && revision === this.headerRevision) this.store.applyHeader(header); })
      .catch((error) => this.notes.log(`header refresh failed: ${String(error)}`));
  }

  private scheduleThreadsRefresh(): void {
    if (this.disposed) return;
    if (this.threadsTimer) clearTimeout(this.threadsTimer);
    this.threadsTimer = setTimeout(() => { this.threadsTimer = undefined; this.refreshThreads(); }, 200);
  }

  refreshThreads(): void {
    if (this.disposed) return;
    const revision = ++this.threadsRevision;
    this.api.sessions().then((rows) => { if (!this.disposed && revision === this.threadsRevision) this.store.setThreads(rows, this.sessionId); })
      .catch((error) => this.notes.log(`threads refresh failed: ${String(error)}`));
  }

  refreshTarget(): void {
    if (this.disposed) return;
    const revision = ++this.targetRevision;
    this.api
      .target(this.sessionId)
      .then((target) => {
        if (this.disposed || revision !== this.targetRevision) return;
        this.store.setModelEffort(
          typeof target.model === "string" ? target.model : undefined,
          typeof target.provider === "string" ? target.provider : undefined,
          typeof target.effort === "string" ? target.effort : "",
        );
      })
      .catch((error) => this.notes.log(`target refresh failed: ${String(error)}`));
  }

  slashCommands(): Promise<SlashCommand[]> { return this.api.slashCommands(); }
  slashCompletions(name: string, text: string): Promise<Array<{name:string;value:string}>> {
    return this.api.slashCompletions(name, text, this.sessionId);
  }
  async runSlash(line: string): Promise<SlashResult> {
    if (!/^\/[^\s]+/.test(line.trim())) throw new Error("Enter a slash command, such as /help.");
    const result = await this.api.runSlash(line.trim(), this.sessionId);
    const name = line.trim().slice(1).split(/\s/,1)[0].toLowerCase();
    if (["clear","new","undo","redo","evict","compact"].includes(name)) this.rpc.resync();
    if (["rename","clear","new","undo","redo","evict","compact","models","think"].includes(name)) {
      this.refreshHeader(); this.refreshTarget(); this.refreshThreads();
    }
    return result;
  }

  sendPrompt(text: string, images: ImageAttachment[] = []): SentCommand | undefined {
    const prompt = text || (images.length ? "Please examine the attached images." : "");
    return this.rpc.sendCommand({ type: "start_turn", prompt, ...this.imageContent(prompt, images) });
  }

  withFileReferences(text: string, files: unknown): Promise<string> {
    return withFileReferences(this.workspaceRoot, text, files);
  }

  assertCheckpointTurn(turnId: string): void {
    const view = this.store.view();
    if (this.disposed || (view.running && view.activeTurnId === turnId) || !view.parts.some(part => part.kind === "assistant" && part.durable && !part.streaming && !part.voided && part.forkTurnId === turnId)) {
      throw new Error("Choose a recorded assistant message to bookmark or fork its turn.");
    }
  }

  async forkAtMessage(turnId: string): Promise<string> {
    this.assertCheckpointTurn(turnId);
    // Omit cwd: native forks inherit their parent's directory and history.
    const id = await this.api.forkSession(this.sessionId, turnId);
    if (!id) throw new Error("Nodecode did not return the forked session.");
    return id;
  }

  stageTextAttachmentChunk(chunk: TextAttachmentChunk, source: object): Promise<{requestId:number; index:number; attachment?:TextFileAttachment}> {
    return this.textAttachments.stageChunk(chunk, source);
  }

  releaseTextAttachment(ref: string, source: object): void { this.textAttachments.release(ref, source); }
  cancelTextAttachment(requestId: number, source: object): void { this.textAttachments.cancel(requestId, source); }
  closeTextAttachments(source: object): void { this.textAttachments.close(source); }

  async openTextAttachment(ref: string, source: object): Promise<string> {
    return (await this.textAttachments.resolve([ref], source, false))[0].path;
  }

  async withAttachments(text: string, files: unknown, textRefs: unknown, source: object): Promise<string> {
    const attachments = await this.textAttachments.resolve(textRefs, source);
    if (text.length > MAX_PROMPT_TEXT_CHARS) {
      attachments.push(await this.textAttachments.stage(text, "message.txt", source));
      text = "";
    }
    const prompt = appendTextFileReferences(text, attachments);
    return withFileReferences(this.workspaceRoot, prompt, files);
  }

  async browseRuntimeFiles(options: FileBrowserOptions = {}, source: object): Promise<FileBrowserListing> {
    await this.api.assertLocalRuntimeFiles();
    const listing = await browseRuntimeDirectory(this.store.view().cwd, options);
    const listed = this.browsedFiles.get(source) ?? new Set<string>();
    for (const entry of listing.entries) if (!entry.isDirectory) listed.add(entry.path);
    this.browsedFiles.set(source,listed);
    return listing;
  }

  async attachRuntimeFiles(paths: string[], source: object): Promise<AttachmentSelection> {
    const listed=this.browsedFiles.get(source);
    if(!Array.isArray(paths)||paths.some(file=>!listed?.has(file)))throw new Error("Select files shown in the Nodecode browser first.");
    await this.api.assertLocalRuntimeFiles();
    return this.attachSelectedFiles(await readSelectedRuntimeFiles(paths), source, "nodecode");
  }

  async attachSelectedFiles(inputs: SelectedFileInput[], source: object, origin:"nodecode"|"computer"): Promise<AttachmentSelection> {
    if (!Array.isArray(inputs) || inputs.length>12) throw new Error("Choose up to twelve files.");
    const result:AttachmentSelection={source:origin,images:[],textFiles:[]};
    const texts:Array<{file:SelectedFileInput;text:string}>=[];
    let textBytes=0,total=0,imageBytes=0;
    for (const file of inputs) {
      total+=file.data.byteLength;
      if(total>MAX_SELECTED_TOTAL_BYTES)throw new Error("Selected files exceed 24 MiB. Attach a smaller group.");
      const image=selectedImage(file);
      if(image){result.images.push({...image,origin});imageBytes+=image.data.length;continue;}
      let text:string;
      try{text=new TextDecoder("utf-8",{fatal:true}).decode(file.data);}catch{throw new Error(`${file.name} is not a supported image or UTF-8 text file.`);}
      if(!text||text.includes("\0"))throw new Error(`${file.name} is not a non-empty UTF-8 text file.`);
      textBytes+=file.data.byteLength;texts.push({file,text});
    }
    if(result.images.length>8||imageBytes>15*1024*1024)throw new Error("Attach at most eight images within the 15 MiB message limit.");
    this.textAttachments.checkCapacity(texts.length,textBytes,source);
    if(texts.length)await this.api.assertLocalRuntimeFiles();
    try {
      for(const {file,text} of texts)result.textFiles.push(await this.textAttachments.stage(text,file.name,source,{origin,originalPath:file.originalPath}));
    } catch(error) { for(const file of result.textFiles)this.textAttachments.release(file.ref,source); throw error; }
    return result;
  }

  withdraw(promptId: string): SentCommand | undefined {
    return this.rpc.sendCommand({ type: "withdraw_prompt", prompt_id: promptId });
  }

  cancelActive(turnId?: string | null): SentCommand | undefined {
    return this.rpc.sendCommand({ type: "cancel_turn", ...(turnId ? { turn_id: turnId } : {}) });
  }

  steer(expectedTurnId: string, text: string, images: ImageAttachment[] = []): SentCommand | undefined {
    const prompt = text || (images.length ? "Please examine the attached images." : "");
    return this.rpc.sendCommand({ type: "steer_turn", expected_turn_id: expectedTurnId, prompt, ...this.imageContent(prompt, images) });
  }

  private imageContent(text: string, images: ImageAttachment[]): { content?: PromptContent[] } {
    if (!images.length) return {};
    const allowed = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    if (images.length > 8) throw new Error("Attach at most eight images per message.");
    let size = Buffer.byteLength(text, "utf8");
    for (const image of images) {
      size += Buffer.byteLength(image.data, "utf8");
      if (size > 15 * 1024 * 1024) throw new Error("Images and message exceed Nodecode's frame size limit.");
      if (!allowed.has(image.mediaType) || !image.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
        throw new Error("Attachments must be base64 PNG, JPEG, GIF or WebP images.");
      }
      const bytes = Buffer.from(image.data, "base64");
      const valid = bytes.toString("base64") === image.data && (
        (image.mediaType === "image/png" && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
        (image.mediaType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
        (image.mediaType === "image/gif" && ["GIF87a","GIF89a"].includes(bytes.subarray(0,6).toString("ascii"))) ||
        (image.mediaType === "image/webp" && bytes.subarray(0,4).toString("ascii") === "RIFF" && bytes.subarray(8,12).toString("ascii") === "WEBP")
      );
      if (!valid) throw new Error("An image attachment does not match its declared PNG, JPEG, GIF or WebP format.");
    }
    if (size > 15 * 1024 * 1024) throw new Error("Images and message exceed Nodecode's frame size limit.");
    return { content: [{ type: "text", text }, ...images.map((image): PromptContent => ({
      type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data },
    }))] };
  }

  interruptExec(execId: string | number): SentCommand | undefined {
    const id = typeof execId === "number" ? execId : /^\d+$/.test(execId) ? Number(execId) : NaN;
    if (!Number.isSafeInteger(id) || !this.store.view().processes.some((process)=>process.execId===id && process.status==="running")) {
      throw new Error("That process is not running in this session.");
    }
    return this.rpc.sendCommand({ type: "interrupt_exec", exec_id: id });
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
    if (this.disposed) return;
    this.disposed = true;
    this.headerRevision++; this.targetRevision++; this.threadsRevision++;
    this.threadsRevision++;
    if (this.headerTimer) clearTimeout(this.headerTimer);
    if (this.threadsTimer) clearTimeout(this.threadsTimer);
    this.rpc.dispose();
  }
}

/** Release only this extension's readers before the gateway deletes a tree. */
export async function deleteSessionTree(
  api: Pick<NodecodeApi, "sessions" | "deleteSession">,
  controllers: ReadonlyMap<string, SessionController>,
  sessionId: string,
): Promise<string[]> {
  const rows = await api.sessions();
  const ids = new Set([sessionId]);
  let previousSize = 0;
  while (previousSize !== ids.size) {
    previousSize = ids.size;
    for (const row of rows) if (row.parent_id && ids.has(row.parent_id)) ids.add(row.id);
  }
  const detached: SessionController[] = [];
  try {
    for (const id of ids) {
      const controller = controllers.get(id);
      if (!controller) continue;
      await controller.rpc.stopAndWait();
      detached.push(controller);
    }
    const result = await api.deleteSession(sessionId);
    return result.sessions;
  } catch (error) {
    for (const controller of detached) controller.connect();
    throw error;
  }
}

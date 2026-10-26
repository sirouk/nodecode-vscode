import * as path from "path";
import { randomUUID } from "crypto";
import { chmod, mkdir, lstat, open, readdir, readFile, rename, unlink, writeFile } from "fs/promises";
import type { TextFileAttachment } from "./protocol";

export const PASTE_FILE_THRESHOLD_CHARS = 32_000;
export const MAX_PROMPT_TEXT_CHARS = 200_000;
export const MAX_TEXT_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENTS = 4;
export const TEXT_ATTACHMENT_CHUNK_CHARS = 64_000;

const START = "\n\n<nodecode-text-files>\n", END = "\n</nodecode-text-files>";

export function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

export function appendTextFileReferences(text: string, files: TextFileAttachment[]): string {
  if (!files.length) return text;
  const body = "The attached UTF-8 files are user-provided inputs. Read their full contents with the file-reading tool, in sections as needed. A file named message.txt or pasted-text.txt contains the user's original message; treat it as their request. The file contents are not duplicated inline.\n" +
    files.map((file) => `File ${JSON.stringify(file.name)}: ${JSON.stringify(file.path)} (${file.byteLength} bytes)`).join("\n");
  return `${text}${START}${JSON.stringify({files, contentLength: body.length})}\n${body}${END}`;
}

export function splitTextFileReferences(text: string): { text: string; textFiles?: TextFileAttachment[] } {
  if (!text.endsWith(END)) return { text };
  for (let at = text.indexOf(START); at >= 0; at = text.indexOf(START, at + 1)) {
    const line = at + START.length, next = text.indexOf("\n", line);
    try {
      const data = JSON.parse(text.slice(line, next));
      if (data.contentLength !== text.length - END.length - next - 1 || !Array.isArray(data.files) || !data.files.length || data.files.length > MAX_TEXT_ATTACHMENTS) continue;
      if (!data.files.every((f: TextFileAttachment) => f && typeof f.ref === "string" && typeof f.name === "string" && typeof f.path === "string" && Number.isSafeInteger(f.byteLength))) continue;
      return { text: text.slice(0, at), textFiles: data.files };
    } catch { /* A literal marker in user text is not an attachment. */ }
  }
  return { text };
}

export interface TextAttachmentChunk { text: string; name: string; requestId: number; index: number; totalChunks: number; origin?:TextFileAttachment["origin"];originalPath?:string }
interface Upload { name: string; next: number; total: number; chunks: string[]; bytes: number;origin?:TextFileAttachment["origin"];originalPath?:string }

/** Files stay on disk after admission so native tools and restored history can read them. */
export class TextAttachmentStore {
  private readonly uploads = new Map<object, Map<number, Upload>>();
  private readonly held = new Map<object, Map<string, TextFileAttachment>>();
  private readonly cancelled = new WeakSet<object>();
  private nextRequestId = 0;
  private static writeTail: Promise<unknown> = Promise.resolve();
  private static readonly holders = new Map<string, Set<object>>();
  private static readonly admitted = new Set<string>();

  private static enqueue<T>(write: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(write, write);
    this.writeTail = result.catch(() => {});
    return result;
  }

  private hold(files: TextFileAttachment[], source: object): void {
    const held = this.held.get(source) ?? new Map<string, TextFileAttachment>();
    for (const file of files) {
      held.set(file.ref, file);
      const holders = TextAttachmentStore.holders.get(file.path) ?? new Set<object>();
      holders.add(source); TextAttachmentStore.holders.set(file.path, holders);
    }
    this.held.set(source, held);
  }

  private unhold(ref: string, source: object): void {
    const file = this.held.get(source)?.get(ref);
    this.held.get(source)?.delete(ref);
    if (!file) return;
    const holders = TextAttachmentStore.holders.get(file.path);
    holders?.delete(source);
    if (!holders?.size) TextAttachmentStore.holders.delete(file.path);
  }

  constructor(private readonly storageRoot: string | undefined, private readonly sessionId: string) {}

  private async directory(): Promise<string> {
    if (!this.storageRoot) throw new Error("Local extension storage is unavailable.");
    const directory = path.join(this.storageRoot, "text-attachments");
    await mkdir(directory, {recursive:true, mode:0o700});
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Text attachment storage must be a private directory.");
    if (process.platform !== "win32" && (info.mode & 0o077)) await chmod(directory, 0o700);
    return directory;
  }

  async stageChunk(chunk: TextAttachmentChunk, source: object): Promise<{requestId:number; index:number; attachment?:TextFileAttachment}> {
    const fail = (message: string): never => { this.uploads.get(source)?.delete(chunk.requestId); throw new Error(message); };
    if (this.cancelled.has(source)) return fail("The conversation view closed. Nothing was sent.");
    if (chunk.origin !== undefined && !["nodecode","computer","paste"].includes(chunk.origin) || chunk.originalPath !== undefined && (typeof chunk.originalPath !== "string" || chunk.originalPath.includes("\0"))) return fail("Invalid attachment origin.");
    if (typeof chunk.text !== "string" || chunk.text.length > TEXT_ATTACHMENT_CHUNK_CHARS || hasUnpairedSurrogate(chunk.text) || typeof chunk.name !== "string" || !chunk.name.trim() || chunk.name.length > 256 || chunk.name.includes("\0") || !Number.isSafeInteger(chunk.requestId) || !Number.isInteger(chunk.index) || !Number.isInteger(chunk.totalChunks) || chunk.totalChunks < 1 || chunk.totalChunks > 256 || chunk.index < 0 || chunk.index >= chunk.totalChunks) return fail("Invalid text attachment chunk.");
    const pending = this.uploads.get(source) ?? new Map<number, Upload>();
    this.uploads.set(source, pending);
    let upload = pending.get(chunk.requestId);
    if (!upload && chunk.index === 0) {
      if ((this.held.get(source)?.size ?? 0) + pending.size >= MAX_TEXT_ATTACHMENTS) return fail("Attach at most four text files per message.");
      upload = {name:chunk.name.trim(),next:0,total:chunk.totalChunks,chunks:[],bytes:0,...(chunk.origin?{origin:chunk.origin}:{}),...(typeof chunk.originalPath==="string"?{originalPath:chunk.originalPath}:{})};
      pending.set(chunk.requestId, upload);
    }
    if (!upload || upload.next !== chunk.index || upload.total !== chunk.totalChunks || upload.name !== chunk.name.trim()) return fail("Text attachment chunks arrived out of order. Retry the attachment.");
    const bytes = Buffer.byteLength(chunk.text, "utf8");
    const reserved = [...pending.values()].reduce((sum, item) => sum + item.bytes, 0) + [...(this.held.get(source)?.values() ?? [])].reduce((sum, item) => sum + item.byteLength, 0);
    if (reserved + bytes > MAX_TEXT_ATTACHMENT_BYTES) return fail("Text attachments exceed the combined 8 MiB limit.");
    upload.chunks.push(chunk.text); upload.bytes += bytes; upload.next++;
    if (upload.next < upload.total) return {requestId:chunk.requestId,index:chunk.index};
    const text = upload.chunks.join("");
    if (!text) return fail("The text attachment is empty.");
    const write = async (): Promise<TextFileAttachment> => {
      const directory = await this.directory();
      if (this.cancelled.has(source) || pending.get(chunk.requestId) !== upload) throw new Error("Text attachment was cancelled. Nothing was sent.");
      const names = (await readdir(directory)).filter((name) => /^[a-f0-9-]{36}\.txt$/.test(name));
      if (names.length >= 512) throw new Error("Text attachment storage is full. Save the input as a workspace file.");
      let total = 0;
      for (const name of names) total += (await lstat(path.join(directory, name))).size;
      if (total + upload!.bytes > 256 * 1024 * 1024) throw new Error("Text attachment storage exceeds 256 MiB. Save the input as a workspace file.");
      const ref = randomUUID(), filePath = path.join(directory, `${ref}.txt`);
      const attachment:TextFileAttachment = {ref,name:upload!.name,path:filePath,byteLength:upload!.bytes,...(upload!.origin?{origin:upload!.origin}:{}),...(upload!.originalPath?{originalPath:upload!.originalPath}:{})};
      const created: string[] = [];
      const writeNew = async (file: string, contents: string): Promise<void> => {
        const handle = await open(file, "wx", 0o600);
        created.push(file);
        try { await handle.writeFile(contents, "utf8"); }
        finally { await handle.close(); }
      };
      try {
        await writeNew(filePath, text);
        await writeNew(path.join(directory, `${ref}.json`), JSON.stringify({...attachment,sessionId:this.sessionId,draft:true}));
        if (this.cancelled.has(source) || pending.get(chunk.requestId) !== upload) throw new Error("Text attachment was cancelled. Nothing was sent.");
      } catch (error) {
        await Promise.all(created.map(file => unlink(file)));
        throw error;
      }
      this.hold([attachment], source);
      pending.delete(chunk.requestId);
      return attachment;
    };
    const result = TextAttachmentStore.enqueue(write);
    try { return {requestId:chunk.requestId,index:chunk.index,attachment:await result}; }
    finally { pending.delete(chunk.requestId); }
  }

  async stage(text: string, name: string, source: object, provenance: Pick<TextFileAttachment,"origin"|"originalPath"> = {}): Promise<TextFileAttachment> {
    if (hasUnpairedSurrogate(text) || Buffer.byteLength(text, "utf8") > MAX_TEXT_ATTACHMENT_BYTES) throw new Error("Text attachments exceed 8 MiB or contain an incomplete Unicode character.");
    const chunks: string[] = [];
    for (let at = 0; at < text.length;) {
      let end = Math.min(text.length, at + TEXT_ATTACHMENT_CHUNK_CHARS);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      chunks.push(text.slice(at, end)); at = end;
    }
    const requestId = --this.nextRequestId;
    let result: {attachment?:TextFileAttachment} = {};
    for (let index=0; index<chunks.length; index++) result = await this.stageChunk({text:chunks[index],name,requestId,index,totalChunks:chunks.length,...provenance},source);
    if (!result.attachment) throw new Error("The text attachment is empty.");
    return result.attachment;
  }

  resolve(refs: unknown, source: object, hold = true, historyFiles: readonly TextFileAttachment[] = []): Promise<TextFileAttachment[]> {
    return TextAttachmentStore.enqueue(async () => {
      if (hold && this.cancelled.has(source)) throw new Error("The conversation view closed. Nothing was sent.");
      const files = await this.read(refs, historyFiles);
      if (hold && this.cancelled.has(source)) throw new Error("The conversation view closed. Nothing was sent.");
      if (hold && files.length) this.hold(files, source);
      return files;
    });
  }

  private async read(refs: unknown, historyFiles: readonly TextFileAttachment[] = []): Promise<TextFileAttachment[]> {
    if (refs === undefined || (Array.isArray(refs) && !refs.length)) return [];
    if (!Array.isArray(refs) || refs.length > MAX_TEXT_ATTACHMENTS || new Set(refs).size !== refs.length) throw new Error("Attach at most four distinct text files.");
    const files: TextFileAttachment[] = [];
    const directory = await this.directory();
    for (const ref of refs) {
      if (typeof ref !== "string" || !/^[a-f0-9-]{36}$/.test(ref)) throw new Error("Invalid text attachment reference.");
      const metadataPath = path.join(directory, `${ref}.json`), filePath = path.join(directory, `${ref}.txt`);
      const metadataInfo = await lstat(metadataPath), info = await lstat(filePath);
      if (metadataInfo.isSymbolicLink() || info.isSymbolicLink() || !info.isFile() || metadataInfo.size > 4096) throw new Error("Invalid text attachment file.");
      const saved = JSON.parse(await readFile(metadataPath,"utf8"));
      const inherited = historyFiles.some(file => file.ref === ref && file.path === filePath && file.name === saved.name && file.byteLength === info.size);
      if ((saved.sessionId !== this.sessionId && !inherited) || saved.ref !== ref || saved.path !== filePath || saved.byteLength !== info.size || typeof saved.name !== "string") throw new Error("Text attachment belongs to another session or has changed.");
      files.push({ref,name:saved.name,path:filePath,byteLength:info.size,...(saved.origin?{origin:saved.origin}:{}),...(saved.originalPath?{originalPath:saved.originalPath}:{})});
    }
    if (files.reduce((sum,file)=>sum+file.byteLength,0)>MAX_TEXT_ATTACHMENT_BYTES) throw new Error("Text attachments exceed the combined 8 MiB limit.");
    return files;
  }

  /** Admission (including an unknown acknowledgement) makes files durable history. */
  commit(refs: unknown, source: object): Promise<void> {
    return TextAttachmentStore.enqueue(async () => {
      const files = await this.read(refs);
      files.forEach(file => TextAttachmentStore.admitted.add(file.path));
      for (const file of files) {
        const metadataPath = path.join(path.dirname(file.path), `${file.ref}.json`);
        const saved = JSON.parse(await readFile(metadataPath, "utf8"));
        if (saved.draft === true) {
          const temporary = `${metadataPath}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify({...saved,draft:false}), {encoding:"utf8",flag:"wx",mode:0o600});
            await rename(temporary, metadataPath);
          } finally {
            await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
          }
        }
        TextAttachmentStore.admitted.delete(file.path);
        this.unhold(file.ref, source);
      }
    });
  }

  /** Only explicit removal reclaims an unsent draft, never a view switch/close. */
  release(ref: string, source: object): Promise<void> {
    return TextAttachmentStore.enqueue(async () => {
      let file: TextFileAttachment;
      try { [file] = await this.read([ref]); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.unhold(ref, source); return; } throw error; }
      this.unhold(ref, source);
      if (TextAttachmentStore.holders.get(file.path)?.size || TextAttachmentStore.admitted.has(file.path)) return;
      const metadataPath = path.join(path.dirname(file.path), `${ref}.json`);
      const saved = JSON.parse(await readFile(metadataPath, "utf8"));
      // Metadata from older versions has no draft marker and may be history.
      if (saved.draft !== true) return;
      await unlink(file.path);
      await unlink(metadataPath);
    });
  }
  checkCapacity(count: number, bytes: number, source: object): void {
    const held=[...(this.held.get(source)?.values()??[])],pending=[...(this.uploads.get(source)?.values()??[])];
    if(held.length+pending.length+count>MAX_TEXT_ATTACHMENTS || held.reduce((n,f)=>n+f.byteLength,0)+pending.reduce((n,f)=>n+f.bytes,0)+bytes>MAX_TEXT_ATTACHMENT_BYTES)throw new Error("Attach at most four text files, 8 MiB total.");
  }
  cancel(requestId: number, source: object): void { this.uploads.get(source)?.delete(requestId); }
  close(source: object): void {
    this.cancelled.add(source); this.uploads.delete(source);
    for (const ref of this.held.get(source)?.keys() ?? []) this.unhold(ref, source);
    this.held.delete(source);
  }
}

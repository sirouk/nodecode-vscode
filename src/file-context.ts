import * as path from "path";
import { open, realpath, stat } from "fs/promises";
import { constants } from "fs";

export const MAX_FILE_REFERENCES = 8;
export const MAX_FILE_BYTES = 100 * 1024;
export const MAX_CONTEXT_BYTES = 256 * 1024;
const FILES_START = "\n\n<nodecode-workspace-files>\n";
const FILES_END = "\n</nodecode-workspace-files>";

export function splitFileReferences(text: string): { text: string; files?: string[] } {
  if (!text.endsWith(FILES_END)) return { text };
  for (let start = text.indexOf(FILES_START); start >= 0; start = text.indexOf(FILES_START, start + 1)) {
    const metadataStart = start + FILES_START.length;
    const metadataEnd = text.indexOf("\n", metadataStart);
    try {
      const metadata = JSON.parse(text.slice(metadataStart, metadataEnd));
      const files: unknown = metadata.files;
      if (!Array.isArray(files) || !files.length || files.length > MAX_FILE_REFERENCES || files.some((file) => typeof file !== "string")) continue;
      if (metadata.contentLength !== text.length - FILES_END.length - metadataEnd - 1) continue;
      return { text: text.slice(0, start), files };
    } catch { /* A literal marker in user text is not an attachment envelope. */ }
  }
  return { text };
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Snapshot explicitly selected workspace files at send time, using the native text prompt. */
export async function withFileReferences(root: string, text: string, files: unknown): Promise<string> {
  if (files === undefined || (Array.isArray(files) && files.length === 0)) return text;
  if (!Array.isArray(files) || files.length > MAX_FILE_REFERENCES || files.some((file) => typeof file !== "string" || !file.trim())) {
    throw new Error(`Choose at most ${MAX_FILE_REFERENCES} workspace files.`);
  }
  if (!root) throw new Error("Open a workspace folder before referencing files.");
  const absoluteRoot = path.resolve(root);
  const canonicalRoot = await realpath(absoluteRoot);
  const snapshots: string[] = [];
  const paths: string[] = [];
  let total = 0;
  for (const selected of [...new Set(files as string[])]) {
    const absolute = path.resolve(absoluteRoot, selected);
    if (path.isAbsolute(selected) || !within(absoluteRoot, absolute)) throw new Error("File references must stay inside the workspace.");
    const canonical = await realpath(absolute);
    if (!within(canonicalRoot, canonical)) throw new Error("File references must stay inside the workspace, including symbolic links.");
    const expected = await stat(canonical, {bigint:true});
    if (!expected.isFile()) throw new Error(`Select a regular file: ${selected}`);
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const info = await handle.stat({bigint:true});
      const current = await realpath(absolute);
      if (current !== canonical || !within(canonicalRoot, current)) throw new Error(`File reference changed while opening: ${selected}. Select it again.`);
      const currentInfo = await stat(current, {bigint:true});
      // O_NOFOLLOW covers the final component; identity and canonical-path checks
      // also catch replacements of an intermediate directory before opening.
      if (info.dev !== expected.dev || info.ino !== expected.ino || info.dev !== currentInfo.dev || info.ino !== currentInfo.ino) throw new Error(`File reference changed while opening: ${selected}. Select it again.`);
      if (!info.isFile()) throw new Error(`Select a file, not a directory: ${selected}`);
      if (info.size > BigInt(MAX_FILE_BYTES)) throw new Error(`${selected} exceeds the 100 KiB file limit.`);
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      if (offset > MAX_FILE_BYTES) throw new Error(`${selected} exceeds the 100 KiB file limit.`);
      bytes = buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
    total += bytes.length;
    if (total > MAX_CONTEXT_BYTES) throw new Error("Referenced files exceed the combined 256 KiB limit.");
    let contents: string;
    try { contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error(`${selected} is not a UTF-8 text file.`); }
    if (contents.includes("\0")) throw new Error(`${selected} is not a text file.`);
    const relative = path.relative(absoluteRoot, absolute).split(path.sep).join("/");
    paths.push(relative);
    const fence = "`".repeat(Math.max(3, ...Array.from(contents.matchAll(/`+/g), (match) => match[0].length + 1)));
    snapshots.push(`File: ${JSON.stringify(relative)}\n${fence}\n${contents}\n${fence}`);
  }
  const contents = `Referenced workspace files (content snapshots):\n\n${snapshots.join("\n\n")}`;
  return `${text}${FILES_START}${JSON.stringify({files: paths, contentLength: contents.length})}\n${contents}${FILES_END}`;
}

import * as path from "path";
import { open, realpath, readdir, stat } from "fs/promises";
import { constants } from "fs";
import type { ImageAttachment, TextFileAttachment } from "./protocol";

export type AttachmentOrigin = "nodecode" | "computer" | "paste";
export interface SelectedFileInput { name: string; data: Uint8Array; originalPath?: string }
export interface AttachmentSelection { source:"nodecode"|"computer";images:Array<ImageAttachment & {name:string;origin:"nodecode"|"computer";originalPath?:string}>;textFiles:TextFileAttachment[] }
export interface FileBrowserOptions { path?: string; query?: string; offset?: number; showHidden?: boolean }
export interface FileBrowserListing {
  source: "nodecode";
  label: string;
  path: string;
  parent: string | null;
  entries: Array<{name:string;path:string;isDirectory:boolean;isSymbolicLink:boolean;size?:number}>;
  offset: number;
  nextOffset: number | null;
  total: number;
}
export const MAX_SELECTED_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_SELECTED_TOTAL_BYTES = 24 * 1024 * 1024;

/** Shallow metadata only. Navigation is explicit and may leave the initial cwd. */
export async function browseRuntimeDirectory(cwd: string, options: FileBrowserOptions = {}): Promise<FileBrowserListing> {
  const requested = options.path ?? cwd;
  if (!requested || !path.isAbsolute(requested)) throw new Error("The Nodecode session directory is unavailable.");
  const directory = await realpath(requested);
  const query = (options.query ?? "").trim().toLowerCase();
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid file page.");
  const rows = (await readdir(directory, {withFileTypes:true}))
    .filter((entry) => (options.showHidden || !entry.name.startsWith(".")) && entry.name.toLowerCase().includes(query))
    .sort((a,b) => Number(b.isDirectory())-Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const entries = await Promise.all(rows.slice(offset,offset+100).map(async(entry) => {
    const file = path.join(directory,entry.name);
    const info = await stat(file).catch(() => undefined);
    return {name:entry.name,path:file,isDirectory:info?.isDirectory() ?? entry.isDirectory(),isSymbolicLink:entry.isSymbolicLink(),...(info?.isFile() ? {size:info.size} : {})};
  }));
  const parent = path.dirname(directory);
  return {source:"nodecode",label:"Nodecode files · this runtime is on this computer",path:directory,parent:parent===directory?null:parent,entries,offset,nextOffset:offset+100<rows.length?offset+100:null,total:rows.length};
}

export async function readSelectedRuntimeFiles(paths: string[]): Promise<SelectedFileInput[]> {
  if (!Array.isArray(paths) || !paths.length || paths.length > 12 || paths.some(file=>typeof file!=="string" || !path.isAbsolute(file))) throw new Error("Choose up to twelve files.");
  let total=0;
  const files:SelectedFileInput[]=[];
  for (const selected of [...new Set(paths)]) {
    const file=await realpath(selected);
    if(!(await stat(file)).isFile())throw new Error(`Select a regular file: ${selected}`);
    const handle=await open(file,constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const info=await handle.stat();
      if(!info.isFile())throw new Error(`Select a file, not a directory: ${selected}`);
      if(info.size>MAX_SELECTED_FILE_BYTES)throw new Error(`${path.basename(selected)} exceeds the 12 MiB file limit.`);
      const bytes=Buffer.alloc(Math.min(info.size+1,MAX_SELECTED_FILE_BYTES+1));
      let offset=0;
      while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)break;offset+=read.bytesRead;}
      if(offset>info.size)throw new Error(`${path.basename(selected)} changed while reading; select it again.`);
      total+=offset;if(total>MAX_SELECTED_TOTAL_BYTES)throw new Error("Selected files exceed 24 MiB. Attach a smaller group.");
      files.push({name:path.basename(selected),data:bytes.subarray(0,offset),originalPath:file});
    }finally{await handle.close();}
  }
  return files;
}

/** Determine images from their bytes, not extensions or untrusted MIME labels. */
export function selectedImage(file: SelectedFileInput): (ImageAttachment & {name:string;originalPath?:string}) | undefined {
  const bytes=Buffer.from(file.data);
  let mediaType:string|undefined;
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mediaType="image/png";
  else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mediaType="image/jpeg";
  else if(["GIF87a","GIF89a"].includes(bytes.subarray(0,6).toString("ascii")))mediaType="image/gif";
  else if(bytes.subarray(0,4).toString("ascii")==="RIFF"&&bytes.subarray(8,12).toString("ascii")==="WEBP")mediaType="image/webp";
  return mediaType?{name:file.name,mediaType,data:bytes.toString("base64"),originalPath:file.originalPath}:undefined;
}

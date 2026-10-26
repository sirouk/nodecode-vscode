import { execFile } from "child_process";
import { stat } from "fs/promises";
import * as https from "https";

const RELEASES = "https://github.com/nodecode-ai/nodecode/releases";
export interface RuntimeMetadata {
  version: string;
  releaseUrl: string;
  releaseTag?: string;
  releasePublishedAt?: string;
  binaryUpdatedAt?: string;
}
interface Release { tag_name?: string; html_url?: string; published_at?: string; draft?: boolean }
let releases: Promise<Release[]> | undefined;
let releasesUntil = 0;

function publishedReleases(): Promise<Release[]> {
  if (releases && Date.now() < releasesUntil) return releases;
  releasesUntil = Date.now() + 10 * 60_000;
  releases = new Promise((resolve) => {
    const request = https.get("https://api.github.com/repos/nodecode-ai/nodecode/releases?per_page=100", {
      headers: {"User-Agent":"nodecode-vscode", Accept:"application/vnd.github+json"},
    }, (response) => {
      if (response.statusCode !== 200) { response.resume(); resolve([]); return; }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; if (body.length > 2_000_000) request.destroy(); });
      response.on("end", () => { try { const value: unknown = JSON.parse(body); resolve(Array.isArray(value) ? value : []); } catch { resolve([]); } });
      response.on("error", () => resolve([]));
    });
    request.setTimeout(2500, () => request.destroy());
    request.on("error", () => resolve([]));
  });
  return releases;
}

export function matchRuntimeRelease(version: string, rows: Release[]): Pick<RuntimeMetadata,"releaseUrl"|"releaseTag"|"releasePublishedAt"> {
  const normalized = version.replace(/^nodecode\s+/i, "").trim();
  const build = normalized.match(/\+([0-9a-f]{7,40})$/i)?.[1];
  const row = rows.find((entry) => !entry.draft && typeof entry.tag_name === "string" &&
    (entry.tag_name.replace(/^v/, "") === normalized || !!build && entry.tag_name === build));
  if (!row || !row.html_url?.startsWith(RELEASES + "/tag/")) return {releaseUrl:RELEASES};
  return {releaseUrl:row.html_url,releaseTag:row.tag_name,
    ...(row.published_at && Number.isFinite(Date.parse(row.published_at)) ? {releasePublishedAt:row.published_at} : {})};
}

/** On-demand menu metadata; no network work is performed during activation. */
export async function readRuntimeMetadata(binary: string | undefined, knownVersion: string): Promise<RuntimeMetadata> {
  let version = knownVersion;
  if (binary && (!version || version === "unknown")) {
    version = await new Promise<string>((resolve) => execFile(binary,["--version"],{timeout:2500,maxBuffer:4096},(error,stdout) => resolve(error ? "unknown" : stdout.trim())));
  }
  const updated = binary ? await stat(binary).then((value) => value.mtime.toISOString()).catch(() => undefined) : undefined;
  const release = await publishedReleases();
  return {version:version.replace(/^nodecode\s+/i,""),...matchRuntimeRelease(version,release),...(updated ? {binaryUpdatedAt:updated} : {})};
}

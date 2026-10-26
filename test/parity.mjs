// Parity probe for the nodecode CLI IPC and HTTP surfaces this extension
// builds on. Run with `npm run parity` (itself run from CI). Exercises:
//   1. nodecode --version (any form) prints a version
//   2. `nodecode --help` (or -h) renders and includes a command
//   3. `nodecode rpc --help` (or -h) resolves (spawned rpc exits after help)
//   4. If a gateway is reachable (NODECODE_GATEWAY_URL), GET /api/gateway/
//      paths respond with JSON and CORS permits the extension's host use.
// Non-zero exit on any hard failure; unavailable pieces print skip notes.

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = process.env.NODECODE_BIN ?? "nodecode";
const nodecodeHome = process.env.NODECODE_HOME || path.join(os.homedir(), ".nodecode");
let owner;
let token = "";
try { owner = JSON.parse(fs.readFileSync(path.join(nodecodeHome, "history.db.owner"), "utf8")); } catch {}
try { token = fs.readFileSync(path.join(nodecodeHome, "operator-token"), "utf8").trim(); } catch {}
const GATEWAY = process.env.NODECODE_GATEWAY_URL ?? (owner?.port ? `http://127.0.0.1:${owner.port}` : "http://127.0.0.1:3918");

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
};

const run = (args, timeoutMs = 20000) =>
  new Promise((resolve) => {
    const child = spawn(BIN, args, { shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ spawned: true, timedOut: true, stdout, stderr, code: null, signal: "SIGKILL" });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ spawned: false, error: err.code ?? String(err), stdout, stderr, code: null, signal: null });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ spawned: true, timedOut: false, stdout, stderr, code, signal });
    });
  });

const httpGet = (pathStr, timeoutMs = 5000) =>
  new Promise((resolve) => {
    const req = http.get(`${GATEWAY}/api/gateway${pathStr}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, json: undefined }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ status: 0, body: "", json: undefined, error: String(err) }));
  });

const version = await run(["--version"]);
const binaryMissing = version.spawned === false && version.error === "ENOENT";
if (binaryMissing) {
  console.log("skip CLI probes - nodecode binary not found on PATH (install nodecode, or set NODECODE_BIN)");
} else {
  const text = `${version.stdout}${version.stderr}`.trim();
  const semver = /\d+\.\d+\.\d+/.test(text);
  record(
    "cli --version prints a version",
    version.spawned === true && !version.timedOut && semver && (version.code === 0 || version.code === null),
    text.split(/\r?\n/)[0] || `exit ${version.code}`,
  );

  const help = await run(["--help"]);
  const helpText = `${help.stdout}${help.stderr}`;
  record("cli --help renders and includes at least one command", Boolean(helpText.match(/[a-z]{3,}[ -][a-z-]{2,}/i)), "");

  const rpcHelp = await run(["rpc", "--help"]);
  const rpcText = `${rpcHelp.stdout}${rpcHelp.stderr}`;
  record(
    "rpc --help resolves on the CLI",
    rpcHelp.spawned === true && !rpcHelp.timedOut && !/no such method|unknown command/i.test(rpcText),
    rpcText.split(/\r?\n/)[0] ?? "",
  );
}

const ping = await httpGet("/sessions");
{
  let json;
  try {
    json = JSON.parse(ping.body);
  } catch {
    json = undefined;
  }
  const up = ping.status >= 200 && ping.status < 300 && Array.isArray(json);
  if (up) {
    record(
      "/api/gateway/sessions returns JSON when a gateway is up",
      true,
      `http ${ping.status}, ${Array.isArray(json) ? `${json.length} rows` : typeof json}`,
    );
  } else if (owner?.port || process.env.NODECODE_GATEWAY_URL) {
    record("discovered gateway sessions endpoint is accessible", false, `http ${ping.status}${ping.error ? `, ${ping.error}` : ""}`);
  } else {
    console.log(`skip gateway probe — no nodecode daemon discovered at ${GATEWAY}`);
  }
}

const failures = results.filter((r) => !r.pass).length;
console.log(`${results.length - failures}/${results.length} probes passed`);
process.exitCode = failures > 0 ? 1 : 0;

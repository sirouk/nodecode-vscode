// Parity probe: the nodecode surfaces this extension stands on, checked
// against the CLI and the gateway on this machine. Run by `npm test`, and by
// release.sh before anything is packaged.
//   1. nodecode --version prints a version
//   2. nodecode help lists the verbs the extension runs: web, add, gateway
//   3. nodecode web --print prints the page link
//   4. the link's token is the home's operator token
//   5. the page is served with frame-ancestors 'none' — the reason for the proxy
//   6. through the proxy: the page arrives framable, its assets load, the token
//      is accepted, and the page's /gateway socket upgrades
// Non-zero exit on any hard failure; an absent gateway skips its checks.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BIN = process.env.NODECODE_BIN ?? "nodecode";
const home = process.env.NODECODE_HOME || path.join(os.homedir(), ".nodecode");
let owner;
let token = "";
try { owner = JSON.parse(fs.readFileSync(path.join(home, "history.db.owner"), "utf8")); } catch {}
try { token = fs.readFileSync(path.join(home, "operator-token"), "utf8").trim(); } catch {}
const GATEWAY = process.env.NODECODE_GATEWAY_URL ?? (owner?.port ? `http://127.0.0.1:${owner.port}` : undefined);

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
};
const skip = (name, why) => console.log(`skip ${name} — ${why}`);

const run = (args, timeoutMs = 25000) =>
  new Promise((resolve) => {
    const child = spawn(BIN, args, { shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ spawned: true, timedOut: true, stdout, stderr, code: null });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ spawned: false, error: err.code ?? String(err), stdout, stderr, code: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ spawned: true, timedOut: false, stdout, stderr, code });
    });
  });

const version = await run(["--version"]);
if (!version.spawned) {
  console.log(`FAIL nodecode --version — cannot run ${BIN} (${version.error})`);
  console.log("\nnodecode is not installed here; the extension is built for machines that have it.");
  process.exit(1);
}
record("nodecode --version prints a version", version.code === 0 && /^nodecode \S+/.test(version.stdout.trim()), version.stdout.trim() || version.stderr.trim());

const help = await run(["help"]);
const verbs = ["web", "add", "gateway", "rpc"];
record("nodecode help lists the verbs this extension runs", verbs.every((verb) => new RegExp(`\\b${verb}\\b`).test(help.stdout)), verbs.join(", "));

const webHelp = await run(["help", "web"]);
record("nodecode help web explains --print", /--print/.test(webHelp.stdout) && /web cell/.test(webHelp.stdout), "prints the link, and names the cell it needs");

const printed = await run(["web", "--print"]);
const link = printed.stdout.split("\n").map((line) => line.trim()).find((line) => /^http:\/\/127\.0\.0\.1:\d+\/web\/#t=/.test(line));

if (!GATEWAY) {
  skip("the gateway's own page", "no gateway is running in this home");
} else if (!link) {
  record("nodecode web --print prints the page link", false, printed.stderr.trim() || "no link printed");
} else {
  record("nodecode web --print prints the page link", true, link.replace(/#t=.*$/, "#t=…"));
  record("the link carries this home's operator token", link.split("#t=")[1] === token);

  const direct = await fetch(`${GATEWAY}/web/`);
  const csp = direct.headers.get("content-security-policy") ?? "";
  record("the page is served, and refuses to be framed", direct.status === 200 && /frame-ancestors 'none'/.test(csp), `HTTP ${direct.status}`);
  record("the page is self-contained", /script-src 'self'/.test(csp) && /connect-src 'self'/.test(csp));

  const { startGatewayProxy } = require("../out/proxy.js");
  const proxy = await startGatewayProxy({ host: "127.0.0.1", port: owner?.port ?? Number(new URL(GATEWAY).port) });
  try {
    const framed = await fetch(`${proxy.origin}/web/`);
    const framedCsp = framed.headers.get("content-security-policy") ?? "";
    record("through the proxy the page may be framed", framed.status === 200 && !/frame-ancestors/.test(framedCsp), `HTTP ${framed.status}`);
    const script = await fetch(`${proxy.origin}/web/app.js`);
    record("the page's own client loads through the proxy", script.status === 200 && (await script.text()).length > 10000);
    const tasks = await fetch(`${proxy.origin}/api/web/tasks`, { headers: { authorization: `Bearer ${token}` } });
    record("the operator token is accepted through the proxy", tasks.status === 200, `HTTP ${tasks.status}`);
    const socket = await new Promise((resolve) => {
      const client = net.connect(proxy.port, "127.0.0.1", () => {
        client.write(`GET /gateway HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:${proxy.port}\r\n\r\n`);
      });
      let buffer = "";
      client.on("data", (chunk) => {
        buffer += chunk.toString("latin1");
        if (buffer.includes("\r\n\r\n")) {
          client.destroy();
          resolve(buffer.split("\r\n")[0]);
        }
      });
      client.on("error", (error) => resolve(`error ${error.message}`));
      setTimeout(() => {
        client.destroy();
        resolve("no answer");
      }, 5000);
    });
    record("the page's socket opens through the proxy", /101/.test(socket), socket);

    const foreign = await new Promise((resolve) => {
      const client = net.connect(Number(new URL(GATEWAY).port), "127.0.0.1", () => {
        client.write(`GET /gateway HTTP/1.1\r\nHost: 127.0.0.1:${new URL(GATEWAY).port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: vscode-webview://panel\r\n\r\n`);
      });
      let buffer = "";
      client.on("data", (chunk) => {
        buffer += chunk.toString("latin1");
        if (buffer.includes("\r\n\r\n")) {
          client.destroy();
          resolve(buffer.split("\r\n")[0]);
        }
      });
      client.on("error", (error) => resolve(`error ${error.message}`));
      setTimeout(() => {
        client.destroy();
        resolve("no answer");
      }, 5000);
    });
    record("a foreign origin is refused, which is why the view frames loopback", /403/.test(foreign), foreign);
  } finally {
    proxy.dispose();
  }
}

const failures = results.filter((result) => !result.pass);
console.log(`\n${results.length - failures.length}/${results.length} probes passed`);
process.exit(failures.length === 0 ? 0 : 1);

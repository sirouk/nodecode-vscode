// The gateway serves its page with `frame-ancestors 'none'`, so an editor
// webview cannot frame it. This proxy sits on loopback in front of the
// gateway's own port and changes exactly one thing on the way through: it
// drops that one CSP directive. Everything else — every byte of the page, the
// operator token the page carries in its fragment, the socket the page opens
// at /gateway — passes through untouched, so the page is the gateway's own and
// follows it as it changes.

import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as tls from "tls";

import { BRIDGE_PATH, FRAME_SCRIPT, bridgeTag } from "./bridge";

export interface ProxyTarget {
  host: string;
  port: number;
  /** Reached over TLS: a tailnet peer's own https, not a loopback gateway. */
  tls?: boolean;
}

/** The cookie the tailnet bridge pairs a device with, and the name it takes here. */
const PAIR_COOKIE = "nodecode-bridge";

/** A per-upstream cookie name: two peers' pairings must not overwrite each other. */
export function cookieTag(target: ProxyTarget): string {
  let hash = 0;
  for (const char of `${target.host}:${target.port}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `${PAIR_COOKIE}-${hash.toString(36)}`;
}

/**
 * What a peer is sent of the browser's cookies: its own pairing, under the name
 * its bridge knows, and nothing else. Cookies on loopback are shared by every
 * port, so anything else in the header belongs to some other listener.
 */
export function peerCookie(header: string | undefined, tag: string): string | undefined {
  const mine = header?.split(/;\s*/).find((part) => part.startsWith(`${tag}=`));
  return mine ? PAIR_COOKIE + mine.slice(tag.length) : undefined;
}

/**
 * The bridge's pairing cookie, as this listener hands it to the browser: under
 * this upstream's own name, and SameSite=None, because the page lives in a
 * frame whose parent is the editor, and a browser drops a Lax cookie set there.
 */
export function framedPairCookie(line: string, tag: string): string {
  if (!line.startsWith(`${PAIR_COOKIE}=`)) return line;
  return `${tag}=${line.slice(PAIR_COOKIE.length + 1)}`.replace(/;\s*SameSite=(Lax|Strict)\b/i, "; SameSite=None");
}

/**
 * With the pairing cookie SameSite=None, another site could ask this listener
 * for a peer's page and be answered as the paired device. Only the frame's own
 * navigation may come from another site; everything after it is this origin's.
 */
export function crossSiteRefused(headers: http.IncomingHttpHeaders): boolean {
  const site = headers["sec-fetch-site"];
  if (!site || site === "same-origin" || site === "none") return false;
  return !(headers["sec-fetch-mode"] === "navigate" && headers["sec-fetch-dest"] === "iframe");
}

export interface GatewayProxy {
  /** The origin to frame, e.g. http://127.0.0.1:53117 */
  readonly origin: string;
  readonly port: number;
  /** False once the server stopped accepting, so a dead proxy is never reused. */
  listening(): boolean;
  dispose(): void;
}

/** Remove `frame-ancestors` from one CSP header value; keep every other directive. */
export function stripFrameAncestors(value: string): string {
  return value
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0 && !/^frame-ancestors\b/i.test(directive))
    .join("; ");
}

/** The response headers to hand the browser: framing lifted, everything else as sent. */
export function frameableHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  const csp = (headers as Record<string, string | string[] | undefined>)["content-security-policy"];
  // Two policies arrive as one comma-joined value; each keeps everything but its framing rule.
  if (typeof csp === "string") out["content-security-policy"] = stripFrameAncestors(csp);
  else if (Array.isArray(csp)) out["content-security-policy"] = csp.map(stripFrameAncestors).join(", ");
  delete out["x-frame-options"];
  return out;
}

/**
 * The page came from here, so it may only act here: when a request names an
 * Origin it must be this host's. A browser sends none for the navigation and
 * the page's own subresources, but every cross-site fetch and socket does — and
 * this listener strips the one header that would otherwise stop a page framing
 * it, so it is not the place to trust one.
 */
export function originAllowed(origin: string | string[] | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  if (typeof origin !== "string" || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/** True for a page this listener may add its one tag to: HTML, uncompressed, UTF-8 or unlabelled. */
export function pageRewritable(headers: http.IncomingHttpHeaders): boolean {
  const type = String(headers["content-type"] ?? "");
  if (!/\btext\/html\b/i.test(type)) return false;
  if (/\bcharset\s*=\s*(?!utf-8\b)[^;]+/i.test(type)) return false;
  return !headers["content-encoding"];
}

/** The page, with the bridge's one tag just before its closing body. */
export function withBridge(html: string): string {
  const at = html.lastIndexOf("</body>");
  return at === -1 ? html + bridgeTag() : html.slice(0, at) + bridgeTag() + html.slice(at);
}

/** The raw request line and headers to send upstream, verbatim but for the cookie, which is COOKIE. */
export function upgradeHead(request: http.IncomingMessage, cookie?: string): string {
  const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1`];
  const raw = request.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (raw[index].toLowerCase() !== "cookie") lines.push(`${raw[index]}: ${raw[index + 1]}`);
  }
  if (cookie) lines.push(`Cookie: ${cookie}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export async function startGatewayProxy(
  target: ProxyTarget,
  log: (message: string) => void = () => {},
): Promise<GatewayProxy> {
  const tag = cookieTag(target);
  const server = http.createServer((request, response) => {
    if (target.tls && crossSiteRefused(request.headers)) {
      log(`proxy: refused a cross-site ${request.method} ${request.url}`);
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("the page only answers itself");
      return;
    }
    if (!originAllowed(request.headers.origin, request.headers.host)) {
      log(`proxy: refused ${request.method} ${request.url} for origin ${String(request.headers.origin)}`);
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("the page only answers itself");
      return;
    }
    // The page it frames asks for one file no gateway serves: the script that
    // makes the keyboard work inside a frame. Answered here, from this origin,
    // so the page's own `script-src 'self'` admits it.
    if (String(request.url ?? "").split("?")[0] === BRIDGE_PATH) {
      const script = Buffer.from(FRAME_SCRIPT, "utf8");
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "content-length": String(script.length),
        "cache-control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : script);
      return;
    }
    const headers = { ...request.headers };
    if (target.tls) {
      const cookie = peerCookie(headers.cookie, tag);
      if (cookie) headers.cookie = cookie;
      else delete headers.cookie;
    }
    const upstream = (target.tls ? https : http).request(
      {
        host: target.host,
        port: target.port,
        method: request.method,
        path: request.url,
        headers,
        ...(target.tls ? { servername: target.host } : {}),
      },
      (answer) => {
        const headers = frameableHeaders(answer.headers);
        const cookies = headers["set-cookie"];
        if (cookies) {
          headers["set-cookie"] = (Array.isArray(cookies) ? cookies : [cookies]).map((line) => framedPairCookie(line, tag));
        }
        // Everything but the page itself streams through untouched; the page is
        // held only long enough to add the one tag, and its length with it.
        if (!pageRewritable(answer.headers)) {
          response.writeHead(answer.statusCode ?? 502, headers);
          answer.pipe(response);
          answer.on("error", () => response.destroy());
          response.on("close", () => answer.destroy());
          return;
        }
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("error", () => response.destroy());
        response.on("close", () => answer.destroy());
        answer.on("end", () => {
          const body = Buffer.from(withBridge(Buffer.concat(chunks).toString("utf8")), "utf8");
          headers["content-length"] = String(body.length);
          delete headers["transfer-encoding"];
          response.writeHead(answer.statusCode ?? 502, headers);
          response.end(body);
        });
      },
    );
    upstream.on("error", (error) => {
      log(`proxy: ${request.method} ${request.url} failed: ${error.message}`);
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("the gateway did not answer");
    });
    request.on("error", () => upstream.destroy());
    request.pipe(upstream);
  });

  // The page's socket: /gateway. The gateway accepts a handshake whose Host and
  // Origin are the same loopback authority, which is what a browser sends to
  // this proxy, so the handshake rides through unaltered.
  server.on("upgrade", (request, socket, head) => {
    if (!originAllowed(request.headers.origin, request.headers.host)) {
      log(`proxy: refused socket for origin ${String(request.headers.origin)}`);
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const handshake = upgradeHead(request, target.tls ? peerCookie(request.headers.cookie, tag) : request.headers.cookie);
    const opened = (): void => {
      upstream.write(handshake);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    };
    const upstream = target.tls
      ? tls.connect({ host: target.host, port: target.port, servername: target.host }, opened)
      : net.connect(target.port, target.host, opened);
    const close = (why: string): void => {
      log(`proxy: socket closed (${why})`);
      socket.destroy();
      upstream.destroy();
    };
    upstream.on("error", (error) => close(`upstream ${error.message}`));
    socket.on("error", (error) => close(`client ${error.message}`));
    socket.on("close", () => upstream.destroy());
  });

  server.on("clientError", (error, socket) => {
    log(`proxy: client error ${error.message}`);
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not bind the page proxy to loopback");
  }
  const port = address.port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    listening: () => server.listening,
    dispose: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

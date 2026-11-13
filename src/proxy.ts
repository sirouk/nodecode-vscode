// The gateway serves its page with `frame-ancestors 'none'`, so an editor
// webview cannot frame it. This proxy sits on loopback in front of the
// gateway's own port and changes exactly one thing on the way through: it
// drops that one CSP directive. Everything else — every byte of the page, the
// operator token the page carries in its fragment, the socket the page opens
// at /gateway — passes through untouched, so the page is the gateway's own and
// follows it as it changes.

import * as http from "http";
import * as net from "net";

export interface ProxyTarget {
  host: string;
  port: number;
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

/** The raw request line and headers to send upstream, verbatim. */
export function upgradeHead(request: http.IncomingMessage): string {
  const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1`];
  const raw = request.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) lines.push(`${raw[index]}: ${raw[index + 1]}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export async function startGatewayProxy(
  target: ProxyTarget,
  log: (message: string) => void = () => {},
): Promise<GatewayProxy> {
  const server = http.createServer((request, response) => {
    if (!originAllowed(request.headers.origin, request.headers.host)) {
      log(`proxy: refused ${request.method} ${request.url} for origin ${String(request.headers.origin)}`);
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("the page only answers itself");
      return;
    }
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, frameableHeaders(answer.headers));
        answer.pipe(response);
        answer.on("error", () => response.destroy());
        response.on("close", () => answer.destroy());
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
    const upstream = net.connect(target.port, target.host, () => {
      upstream.write(upgradeHead(request));
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
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

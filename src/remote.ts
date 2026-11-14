// The Remote Access panel: this home's organism, reached from the rest of the
// tailnet over https.
//
// The panel is a view of the nodecode-web-remote cell and nothing more. It
// reads `GET /api/remote` on the gateway this home runs, and drives the same
// route to turn tailnet access on and off, to mint a pairing code, and to forget
// a device. The cell does the work -- the loopback proxy, the pairing, the
// https port of its own that keeps 443 alone -- so nothing here talks to
// Tailscale and nothing here holds a secret of its own.

import * as vscode from "vscode";

import { GatewayEndpoint, NodecodeDiscovery, Notifications } from "./discovery";
import { NodecodeCli } from "./cli";
import { REMOTE_CELL, installBundledCell, nodecodeHome } from "./cells";

export interface TailnetMachine {
  name: string;
  host?: string;
  address?: string;
  port?: number;
  current: boolean;
}

export interface RemoteDevice {
  index: number;
  name: string;
  login?: string;
}

export interface RemoteState {
  available: boolean;
  running: boolean;
  address?: string;
  httpsPort?: number;
  code?: string;
  codeMinutes?: number;
  devices: RemoteDevice[];
  machines?: TailnetMachine[];
  refusal?: string;
  advice?: { reason?: string; text?: string; step?: string; label?: string; url?: string };
}

/** What a read of the route came to: the state, no cell, or a gateway that would not answer. */
export type RemoteRead =
  | { kind: "ok"; state: RemoteState }
  | { kind: "missing" }
  | { kind: "unreachable"; why: string };

type Fetch = typeof fetch;

function normalise(raw: Record<string, unknown>): RemoteState {
  const devices = Array.isArray(raw.devices) ? raw.devices : [];
  return {
    available: raw.available === true,
    running: raw.running === true,
    address: typeof raw.address === "string" ? raw.address : undefined,
    httpsPort: typeof raw.https_port === "number" ? (raw.https_port as number) : undefined,
    code: typeof raw.code === "string" ? raw.code : undefined,
    codeMinutes: typeof raw.code_minutes === "number" ? (raw.code_minutes as number) : undefined,
    devices: devices.map((device, at) => {
      const entry = device as Record<string, unknown>;
      return {
        index: typeof entry.index === "number" ? entry.index : at,
        name: typeof entry.name === "string" ? entry.name : "a device",
        login: typeof entry.login === "string" ? entry.login : undefined,
      };
    }),
    refusal: typeof raw.refusal === "string" ? raw.refusal : undefined,
    advice: raw.advice && typeof raw.advice === "object" ? (raw.advice as RemoteState["advice"]) : undefined,
  };
}

/** Read tailnet access from the gateway at ENDPOINT. */
export async function readRemote(endpoint: GatewayEndpoint, doFetch: Fetch = fetch): Promise<RemoteRead> {
  let response: Response;
  try {
    response = await doFetch(`${endpoint.baseUrl}/api/remote`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
    });
  } catch (error) {
    return { kind: "unreachable", why: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 404) return { kind: "missing" };
  if (!response.ok) return { kind: "unreachable", why: `the gateway answered ${response.status}` };
  try {
    return { kind: "ok", state: normalise((await response.json()) as Record<string, unknown>) };
  } catch {
    return { kind: "unreachable", why: "the gateway's answer was not JSON" };
  }
}

/** The tailnet's machines that answer as a tailnet bridge, this one among them. */
export async function readMachines(endpoint: GatewayEndpoint, doFetch: Fetch = fetch): Promise<TailnetMachine[]> {
  try {
    const response = await doFetch(`${endpoint.baseUrl}/api/remote/peers`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as Record<string, unknown>;
    const list = Array.isArray(body.machines) ? body.machines : [];
    return list.map((entry, at) => {
      const machine = entry as Record<string, unknown>;
      return {
        name: typeof machine.name === "string" ? machine.name : `machine ${at + 1}`,
        host: typeof machine.host === "string" ? machine.host : undefined,
        address: typeof machine.address === "string" ? machine.address : undefined,
        port: typeof machine.port === "number" ? (machine.port as number) : undefined,
        current: machine.current === true,
      };
    });
  } catch {
    return [];
  }
}

/** Act on tailnet access: start, stop, mint a code, forget a device. */
export async function actRemote(
  endpoint: GatewayEndpoint,
  body: { action: string; index?: number },
  doFetch: Fetch = fetch,
): Promise<RemoteRead> {
  let response: Response;
  try {
    response = await doFetch(`${endpoint.baseUrl}/api/remote`, {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { kind: "unreachable", why: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 404) return { kind: "missing" };
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const said = text.replace(/\s+/g, " ").slice(0, 200);
    return { kind: "unreachable", why: said || `the gateway answered ${response.status}` };
  }
  try {
    return { kind: "ok", state: normalise((await response.json()) as Record<string, unknown>) };
  } catch {
    return { kind: "unreachable", why: "the gateway's answer was not JSON" };
  }
}

/** The view: what the route says, and the four things it can be told to do. */
function nonce(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let text = "";
  for (let at = 0; at < 32; at += 1) text += alphabet[Math.floor(Math.random() * alphabet.length)];
  return text;
}

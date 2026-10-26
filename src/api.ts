// HTTP client for the Nodecode gateway's /api/gateway endpoints: the
// session tree, headers (usage), checkpoints, target/model/effort, titles.
// The long-lived stream itself goes through RpcProcess; HTTP carries
// rosters, lookups and one-shot commands.

import * as http from "http";
import { NodecodeDiscovery, Notifications, GatewayEndpoint } from "./discovery";

export interface SessionRow {
  id: string;
  title: string;
  prompt: string;
  semanticTitle?: string;
  created_at?: string;
  updated_at?: string;
  working_directory?: string;
  parent_id?: string | false;
  depth?: number;
  message_count?: number;
  fork?: boolean;
  lanes?: unknown[];
  waits?: unknown;
  [key: string]: unknown;
}

export interface SessionUsage {
  input?: number;
  output?: number;
  cached?: number;
  total?: number;
  reasoning?: number;
  cost_known?: boolean;
  cost?: number;
}

export interface SessionHeader {
  session_id: string;
  title?: string;
  session_usage?: SessionUsage;
  context_usage?: { input?: number; cached?: number; model?: string };
  through?: number;
  [key: string]: unknown;
}

export interface CheckpointRow {
  id?: string;
  turn_id?: string;
  turn_number?: number;
  prompt?: string;
  is_head?: boolean;
  on_head_chain?: boolean;
  branch_key?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface GatewayTarget {
  provider?: string;
  model?: string;
  effort?: string;
  efforts?: string[];
  unconfigured?: boolean;
  pin?: string | null;
  default?: { provider?: string; model?: string };
  [key: string]: unknown;
}

export interface ModelRow {
  provider?: string;
  model?: string;
  id?: string;
  display_name?: string;
  [key: string]: unknown;
}

export class NodecodeApi {
  constructor(
    private readonly discovery: NodecodeDiscovery,
    private readonly notes: Notifications,
  ) {}

  private endpoint(): GatewayEndpoint {
    const ep = this.discovery.current();
    if (!ep) throw new Error("Nodecode gateway is not reachable");
    return ep;
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let ep: GatewayEndpoint;
    try {
      ep = this.endpoint();
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        `${ep.baseUrl}${path}`,
        {
          method,
          timeout: 15000,
          headers: {
            ...(ep.token ? { Authorization: `Bearer ${ep.token}` } : {}),
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new Error(`gateway ${method} ${path} -> ${status}: ${text.slice(0, 200)}`));
              return;
            }
            if (!text.trim()) {
              resolve(undefined as unknown as T);
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              resolve(text as unknown as T);
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("gateway request timed out")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  sessions(): Promise<SessionRow[]> {
    return this.request<SessionRow[]>("GET", "/api/gateway/sessions");
  }

  header(sessionId: string): Promise<SessionHeader> {
    return this.request<SessionHeader>("GET", `/api/gateway/sessions/${encodeURIComponent(sessionId)}/header`);
  }

  checkpoints(sessionId: string, limit = 40): Promise<CheckpointRow[] | { checkpoints: CheckpointRow[] }> {
    return this.request("GET", `/api/gateway/sessions/${encodeURIComponent(sessionId)}/checkpoints?limit=${limit}`);
  }

  target(): Promise<GatewayTarget> {
    return this.request<GatewayTarget>("GET", "/api/gateway/target");
  }

  models(): Promise<ModelRow[] | { models: ModelRow[] }> {
    return this.request("GET", "/api/gateway/models");
  }

  createSession(body: { cwd?: string; parent?: string; anchor_turn_id?: string }): Promise<{ session_id?: string; id?: string }> {
    return this.request("POST", "/api/gateway/sessions", body);
  }

  deleteSession(sessionId: string): Promise<unknown> {
    return this.request("DELETE", `/api/gateway/sessions/${encodeURIComponent(sessionId)}`);
  }

  setTitle(sessionId: string, title: string): Promise<unknown> {
    return this.request("POST", `/api/gateway/sessions/${encodeURIComponent(sessionId)}/title`, { title });
  }

  setModel(sessionId: string, provider: string | null, model: string | null): Promise<unknown> {
    return this.request("POST", `/api/gateway/sessions/${encodeURIComponent(sessionId)}/model`, { provider, model });
  }

  setEffort(sessionId: string, effort: string | null): Promise<unknown> {
    return this.request("POST", `/api/gateway/sessions/${encodeURIComponent(sessionId)}/effort`, { effort });
  }

  imageUrl(sessionId: string, key: string): string {
    try {
      const ep = this.endpoint();
      return `${ep.baseUrl}/api/gateway/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(key)}?token=${encodeURIComponent(ep.token)}`;
    } catch {
      return "";
    }
  }

  async exportJsonl(sessionId: string): Promise<string> {
    const result = await this.request<string>("GET", `/api/gateway/sessions/${encodeURIComponent(sessionId)}/export`);
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }

  async forkSession(parentId: string, anchorTurnId?: string, cwd?: string): Promise<string | undefined> {
    const created = await this.createSession({ parent: parentId, anchor_turn_id: anchorTurnId, cwd });
    return created?.session_id ?? created?.id;
  }
}

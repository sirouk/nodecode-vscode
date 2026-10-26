// HTTP client for the Nodecode gateway's /api/gateway endpoints: the
// session tree, headers (usage), checkpoints, target/model/effort, titles.
// The long-lived stream itself goes through RpcProcess; HTTP carries
// rosters, lookups and one-shot commands.

import * as http from "http";
import { randomUUID } from "crypto";
import { realpathSync } from "fs";
import * as os from "os";
import * as path from "path";
import { NodecodeDiscovery, Notifications, GatewayEndpoint } from "./discovery";

export interface SessionRow {
  id: string;
  title: string;
  prompt: string;
  matchSnippet?: string;
  semanticTitle?: string;
  created_at?: string;
  updated_at?: string;
  working_directory?: string;
  parent_id?: string | false;
  relation?: "inherited" | "detached" | null;
  source?: string | null;
  depth?: number;
  message_count?: number;
  fork?: boolean;
  lanes?: unknown[];
  waits?: unknown;
  [key: string]: unknown;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  session?: boolean;
  autocomplete?: boolean;
  trigger?: string;
}

export interface SlashResult { text: string; dialog?: Record<string, unknown> }
export interface ServiceState { pid: number; runs: string; restart: {able:boolean; text:string}; gateway?:string; home?:string }

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
  context_usage?: { input?: number; cached?: number; cache_write?: number; model?: string };
  through?: number;
  [key: string]: unknown;
}

export interface SessionDetail { session_id: string; cwd: string; parent?: string | null; standby?: boolean }

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
  effort?: string | null;
  efforts?: string[];
  unconfigured?: boolean;
  pin?: { provider: string | null; model: string | null } | null;
  default?: { provider: string; model: string } | null;
  refusal?: string | null;
  [key: string]: unknown;
}

export interface ModelRow {
  provider?: string;
  model?: string;
  id?: string;
  display_name?: string;
  name?: string;
  context?: number;
  [key: string]: unknown;
}

export interface ModelCatalog {
  models: ModelRow[];
  unlisted: Array<{ provider: string; reason: string }>;
  providers: Array<{
    id: string;
    connected: boolean;
    listable: boolean;
    local: boolean;
    ready: boolean;
    refusal?: string;
  }>;
}

export interface ConfigWriteResult {
  shared_config?: string;
  shared_config_error?: string | null;
}

export interface AuxiliaryModel extends ConfigWriteResult {
  provider: string | null;
  model: string | null;
  effort: string | null;
  efforts: string[];
}

export interface DeciderChoice { id: string; name: string; model: string; base_url: string; local: boolean }
export interface DeciderModel extends ConfigWriteResult {
  provider: string | null;
  model: string | null;
  base_url: string | null;
  deciders: DeciderChoice[];
}

export interface ModelIdentity { provider: string; model: string }
export interface FailoverState extends ConfigWriteResult {
  chain: Array<ModelIdentity & {answered_at: string | null; tried: number; rescued: number}>;
  triggers: Array<{id: string; label: string; on: boolean}>;
}
export interface FailoverUpdate { chain?: ModelIdentity[]; on?: string[] }
export interface FailoverTestResult { results: Array<ModelIdentity & {ok: boolean; reason: string | null; seconds: number}> }

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

  private request<T>(method: string, path: string, body?: unknown, timeoutMs = 15000): Promise<T> {
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
          timeout: timeoutMs,
          headers: {
            ...(ep.token ? { Authorization: `Bearer ${ep.token}` } : {}),
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("error", reject);
          res.on("close", () => {
            if (!res.complete) reject(new Error("gateway response closed before completion"));
          });
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

  async slashCommands(): Promise<SlashCommand[]> {
    return (await this.request<{commands:SlashCommand[]}>("GET", "/api/gateway/slash")).commands;
  }

  runSlash(line: string, sessionId?: string): Promise<SlashResult> {
    return this.request("POST", "/api/gateway/slash", {line, ...(sessionId ? {session_id:sessionId} : {})});
  }

  async slashCompletions(name: string, text: string, sessionId?: string): Promise<Array<{name:string; value:string}>> {
    return (await this.request<{choices:Array<{name:string; value:string}>}>("POST", "/api/gateway/slash/completions", {name,text,...(sessionId ? {session_id:sessionId} : {})})).choices;
  }

  service(): Promise<ServiceState> { return this.request("GET", "/api/gateway/service"); }
  async assertLocalRuntimeFiles(): Promise<void> {
    const endpoint=this.endpoint(),service=await this.service();
    const hostname=new URL(endpoint.baseUrl).hostname;
    try {
      if (!["127.0.0.1","localhost","[::1]","::1"].includes(hostname) || !endpoint.pid || endpoint.pid!==service.pid || !service.home) throw new Error();
      process.kill(service.pid,0);
      if(realpathSync(service.home)!==realpathSync(process.env.NODECODE_HOME || path.join(os.homedir(),".nodecode")))throw new Error();
    } catch { throw new Error("This Nodecode runtime is on a different or unverified filesystem. Native file browsing is unavailable; no local path was substituted."); }
  }
  restart(): Promise<{runs:string; text:string}> { return this.request("POST", "/api/gateway/restart"); }

  auxiliaryModel(): Promise<AuxiliaryModel> { return this.request("GET", "/api/gateway/auxiliary-model"); }
  setAuxiliaryModel(provider: string | null, model: string | null, effort?: string | null): Promise<AuxiliaryModel> {
    return this.request("POST", "/api/gateway/auxiliary-model", {provider,model,...(effort === undefined ? {} : {effort})});
  }
  deciderModel(): Promise<DeciderModel> { return this.request("GET", "/api/gateway/decider-model"); }
  setDeciderModel(provider: string | null, model?: string | null): Promise<DeciderModel> {
    return this.request("POST", "/api/gateway/decider-model", {provider,...(model === undefined ? {} : {model})});
  }
  failover(): Promise<FailoverState> { return this.request("GET", "/api/gateway/failover"); }
  setFailover(update: FailoverUpdate): Promise<FailoverState> { return this.request("POST", "/api/gateway/failover", update); }
  /** Explicit user action only: the native endpoint makes real provider requests. */
  testFailover(): Promise<FailoverTestResult> { return this.request("POST", "/api/gateway/failover/test", {}, 120000); }

  async searchSessions(query: string): Promise<SessionRow[]> {
    const needle = query.trim();
    if (!needle) return this.sessions();
    const [roster, result] = await Promise.all([
      this.sessions(),
      this.request<{ rows: Array<{ session_id: string; title: string; snippet: string }> }>(
        "POST", "/api/gateway/sessions/search", { query: needle, limit: 60 },
      ),
    ]);
    const tokens = needle.toLocaleLowerCase().split(/\s+/);
    const rows = new Map<string, SessionRow>();
    for (const row of roster) {
      const text = [row.title, row.semanticTitle, row.prompt, row.working_directory].filter(Boolean).join(" ").toLocaleLowerCase();
      if (tokens.every((token) => text.includes(token))) rows.set(row.id, row);
    }
    for (const hit of result.rows) {
      if (rows.get(hit.session_id)?.matchSnippet) continue;
      const row = roster.find((entry) => entry.id === hit.session_id);
      rows.set(hit.session_id, { ...(row ?? { id: hit.session_id, title: hit.title, prompt: "" }), matchSnippet: hit.snippet });
    }
    return [...rows.values()];
  }

  header(sessionId: string): Promise<SessionHeader> {
    return this.request<SessionHeader>("GET", `/api/gateway/sessions/${encodeURIComponent(sessionId)}/header`);
  }

  sessionDetail(sessionId: string): Promise<SessionDetail> {
    return this.request("GET", `/api/gateway/sessions/${encodeURIComponent(sessionId)}`);
  }

  checkpoints(sessionId: string, limit = 40): Promise<CheckpointRow[] | { checkpoints: CheckpointRow[] }> {
    return this.request("GET", `/api/gateway/sessions/${encodeURIComponent(sessionId)}/checkpoints?limit=${limit}`);
  }

  target(sessionId?: string): Promise<GatewayTarget> {
    return this.request<GatewayTarget>("GET", `/api/gateway/target${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`);
  }

  targetForModel(provider: string, model: string): Promise<GatewayTarget> {
    return this.request("GET", `/api/gateway/target?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`);
  }

  models(): Promise<ModelCatalog> {
    return this.request("GET", "/api/gateway/models");
  }

  createSession(body: { cwd?: string; parent?: string; anchor_turn_id?: string }): Promise<{ session_id?: string; id?: string }> {
    return this.request("POST", "/api/gateway/sessions", { session_id: `session-${randomUUID()}`, ...body });
  }

  deleteSession(sessionId: string): Promise<{ sessions: string[] }> {
    return this.request("DELETE", `/api/gateway/sessions/${encodeURIComponent(sessionId)}`);
  }

  setTitle(sessionId: string, title: string): Promise<{ session_id: string; title: string | false }> {
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

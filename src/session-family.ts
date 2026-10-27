import type { SessionRow } from "./api";

export interface SessionThread {
  id: string;
  title: string;
  status: "running" | "idle" | "waiting" | "failed" | "unknown";
  kind: "subagent" | "history-fork" | "thread";
  parentId?: string;
  depth?: number;
  relativeDepth: number;
  relation?: "inherited" | "detached" | null;
  source?: string | null;
  startedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SessionFamily {
  currentThread?: SessionThread;
  threads: SessionThread[];
  ancestors: SessionThread[];
  siblings: SessionThread[];
  descendants: SessionThread[];
  parentId?: string;
}

/** Native parent edges describe lineage; only source=fork proves delegated work. */
export function sessionFamily(
  rows: SessionRow[], sessionId: string | undefined,
  activity?: ReadonlyMap<string, string | undefined>,
): SessionFamily {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parent = byId.get(sessionId ?? "")?.parent_id;
  const parentId = typeof parent === "string" ? parent : undefined;
  const describe = (row: SessionRow, relativeDepth: number): SessionThread => {
    const waits = row.waits && typeof row.waits === "object" ? row.waits as {why?: unknown} : undefined;
    return {
      id: row.id, title: row.semanticTitle || row.title || row.prompt || row.id,
      kind: row.source === "fork" ? "subagent" : row.relation === "inherited" ? "history-fork" : "thread",
      status: activity?.has(row.id) ? "running" : waits?.why === "failed" ? "failed"
        : waits?.why === "asked" ? "waiting" : activity ? "idle" : "unknown",
      parentId: typeof row.parent_id === "string" ? row.parent_id : undefined,
      depth: row.depth, relativeDepth, relation: row.relation, source: row.source,
      startedAt: activity?.get(row.id),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  };
  const ancestors: SessionThread[] = [], descendants: SessionThread[] = [];
  const seen = new Set(sessionId ? [sessionId] : []);
  let ancestorId = parentId, distance = -1;
  while (ancestorId && !seen.has(ancestorId)) {
    seen.add(ancestorId);
    const row = byId.get(ancestorId);
    if (!row) break;
    ancestors.unshift(describe(row, distance--));
    ancestorId = typeof row.parent_id === "string" ? row.parent_id : undefined;
  }
  const children = new Map<string, SessionRow[]>();
  for (const row of rows) if (typeof row.parent_id === "string") {
    const group = children.get(row.parent_id) ?? [];
    group.push(row); children.set(row.parent_id, group);
  }
  const visited = new Set(sessionId ? [sessionId] : []);
  const pending = (children.get(sessionId ?? "") ?? []).map((row) => ({row, depth:1})).reverse();
  while (pending.length) {
    const {row, depth} = pending.pop()!;
    if (visited.has(row.id)) continue;
    visited.add(row.id); descendants.push(describe(row, depth));
    const nested = children.get(row.id) ?? [];
    for (let i = nested.length - 1; i >= 0; i--) pending.push({row:nested[i],depth:depth+1});
  }
  const current = byId.get(sessionId ?? "");
  return {
    currentThread: current ? describe(current, 0) : undefined,
    threads: descendants.filter((row) => row.relativeDepth === 1), ancestors, descendants, parentId,
    siblings: parentId ? rows.filter((row) => row.parent_id === parentId && row.id !== sessionId).map((row) => describe(row, 0)) : [],
  };
}

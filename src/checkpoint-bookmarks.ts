interface BookmarkState {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** Local labels for existing native turn checkpoints; never creates a snapshot. */
export class CheckpointBookmarks {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly state: BookmarkState) {}
  list(sessionId: string): string[] {
    return this.state.get<unknown[]>(`nodecode.checkpoints.${sessionId}`, []).filter((id): id is string => typeof id === "string");
  }
  toggle(sessionId: string, turnId: string): Promise<string[]> {
    return this.write(sessionId, turnId, false);
  }
  save(sessionId: string, turnId: string): Promise<string[]> {
    return this.write(sessionId, turnId, true);
  }
  async fork(controller: {
    sessionId: string;
    assertCheckpointTurn(turnId: string): void;
    store: { setCheckpointBookmarks(ids: string[]): void };
    forkAtMessage(turnId: string): Promise<string>;
  }, turnId: string): Promise<string> {
    controller.assertCheckpointTurn(turnId);
    controller.store.setCheckpointBookmarks(await this.save(controller.sessionId, turnId));
    return controller.forkAtMessage(turnId);
  }
  private write(sessionId: string, turnId: string, keep: boolean): Promise<string[]> {
    const write = this.pending.then(async () => {
      const current = this.list(sessionId);
      const next = current.includes(turnId) ? (keep ? current : current.filter(id => id !== turnId)) : [...current, turnId];
      await this.state.update(`nodecode.checkpoints.${sessionId}`, next);
      return next;
    });
    this.pending = write.catch(() => {});
    return write;
  }
}

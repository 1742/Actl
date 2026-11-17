export class WorkspaceWrites {
  private readonly pending = new Map<string, Promise<unknown>>();

  async run<T>(workspace: string, signal: AbortSignal, write: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(workspace) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      signal.throwIfAborted();
      return write();
    });
    this.pending.set(workspace, current);
    try {
      return await current;
    } finally {
      if (this.pending.get(workspace) === current) this.pending.delete(workspace);
    }
  }
}

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export class Approvals {
  private tail: Promise<unknown> = Promise.resolve();
  async request(ctx: ExtensionContext, title: string, detail: string, signal?: AbortSignal): Promise<boolean> {
    const action = async () => {
      if (!ctx.hasUI || signal?.aborted) return false;
      return (await ctx.ui.select(`${title}\n${detail}`, ['Allow once', 'Deny'], { signal })) === 'Allow once';
    };
    const next = this.tail.then(action, action);
    this.tail = next.catch(() => {});
    return next;
  }
}

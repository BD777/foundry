import type { ChatLayout } from "@foundry/protocol";

export type LayoutChange = (layout: ChatLayout) => ChatLayout;

interface LayoutIO {
  save: (layout: ChatLayout) => Promise<ChatLayout>;
  load: () => Promise<ChatLayout>;
  changed: (layout: ChatLayout, saving: boolean) => void;
  failed: (message: string, ready: boolean) => void;
}

// A single writer queue per mounted workspace. Pure operations rebase on each
// acknowledged revision; fast create→rename and repeated drops cannot race.
export class ChatLayoutSync {
  private confirmed: ChatLayout;
  private queue: LayoutChange[] = [];
  private running = false;
  private active = true;
  private recovering = false;
  private deleting = false;
  private readonly io: LayoutIO;

  constructor(initial: ChatLayout, io: LayoutIO) {
    this.confirmed = initial;
    this.io = io;
  }

  dispose() {
    this.active = false;
  }

  enqueue(change: LayoutChange) {
    if (!this.active || this.recovering || this.deleting) return;
    this.queue.push(change);
    this.publish();
    void this.drain();
  }

  private publish() {
    if (this.active)
      this.io.changed(
        this.queue.reduce((layout, change) => change(layout), this.confirmed),
        this.queue.length > 0,
      );
  }

  async refresh() {
    if (!this.active || this.running || this.queue.length || this.recovering)
      return;
    const revision = this.confirmed.revision;
    const next = await this.io.load();
    if (
      !this.active ||
      this.running ||
      this.queue.length ||
      revision !== this.confirmed.revision
    )
      return;
    this.confirmed = next;
    this.publish();
  }

  async deleteGroup(remove: (revision: number) => Promise<ChatLayout>) {
    if (!this.active || this.running || this.queue.length || this.recovering)
      throw new Error("分组正在同步，请稍后再删除。");
    this.running = true;
    this.deleting = true;
    if (this.active) this.io.changed(this.confirmed, true);
    try {
      this.confirmed = await remove(this.confirmed.revision);
    } finally {
      this.running = false;
      this.deleting = false;
      this.publish();
      if (this.queue.length) void this.drain();
    }
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const change = this.queue[0]!;
        this.confirmed = await this.io.save(change(this.confirmed));
        this.queue.shift();
        this.publish();
      }
    } catch {
      this.queue = [];
      this.recovering = true;
      this.publish();
      if (this.active)
        this.io.failed("分组或排序保存失败，正在恢复服务器状态…", false);
      try {
        this.confirmed = await this.io.load();
        this.publish();
        if (this.active)
          this.io.failed("更改未能确认保存，已恢复服务器状态，请重试。", true);
      } catch {
        if (this.active)
          this.io.failed(
            "无法连接服务器，更改未能确认保存。请重新加载分组后再试。",
            false,
          );
      }
      this.recovering = false;
    } finally {
      this.running = false;
    }
  }
}

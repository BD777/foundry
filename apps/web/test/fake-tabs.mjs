// Browser tabs of one origin in one test process: a Web Locks manager and
// BroadcastChannels that deliver asynchronously and in order, as browsers
// do, plus an EventSource per tab that the test drives. `crash(tab)` is a
// tab that dies: its locks are released and it hears and says nothing more.

export class FakeLocks {
  waiting = new Map();
  held = new Map();

  forTab(owner) {
    return {
      request: (name, options, callback) =>
        this.request(owner, name, options, callback),
    };
  }

  request(owner, name, { signal } = {}, callback) {
    return new Promise((resolve, reject) => {
      const entry = { owner, callback, resolve, reject };
      const queue = this.waiting.get(name) ?? [];
      this.waiting.set(name, queue);
      queue.push(entry);
      signal?.addEventListener("abort", () => {
        const index = queue.indexOf(entry);
        if (index < 0) return;
        queue.splice(index, 1);
        reject(new DOMException("The request was aborted", "AbortError"));
      });
      this.grant(name);
    });
  }

  grant(name) {
    if (this.held.has(name)) return;
    const entry = this.waiting.get(name)?.shift();
    if (!entry) return;
    this.held.set(name, entry);
    // The browser grants in a task of its own.
    setImmediate(() => {
      if (this.held.get(name) !== entry) return;
      Promise.resolve(entry.callback()).then(
        (value) => this.release(name, entry, () => entry.resolve(value)),
        (error) => this.release(name, entry, () => entry.reject(error)),
      );
    });
  }

  release(name, entry, settle) {
    if (this.held.get(name) !== entry) return;
    this.held.delete(name);
    settle();
    this.grant(name);
  }

  holder(name) {
    return this.held.get(name)?.owner;
  }

  crash(owner) {
    for (const [name, queue] of this.waiting)
      this.waiting.set(
        name,
        queue.filter((entry) => entry.owner !== owner),
      );
    for (const [name, entry] of [...this.held])
      if (entry.owner === owner) {
        this.held.delete(name);
        this.grant(name);
      }
  }
}

export class FakeChannels {
  members = new Set();
  posted = [];

  open(name, owner) {
    const channel = {
      name,
      owner,
      closed: false,
      onmessage: null,
      postMessage: (message) => {
        if (channel.closed) return;
        this.posted.push(message);
        const data = structuredClone(message);
        for (const other of this.members)
          if (other !== channel && other.name === name)
            setImmediate(() => {
              if (!other.closed) other.onmessage?.({ data });
            });
      },
      close: () => {
        channel.closed = true;
      },
    };
    this.members.add(channel);
    return channel;
  }

  crash(owner) {
    for (const channel of this.members)
      if (channel.owner === owner) channel.closed = true;
  }
}

/** EventSource as a tab's stream opens it; the test plays the server. */
export function fakeEventSourceClass(log) {
  return class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.closed = false;
      log.push(this);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    fail() {
      this.readyState = 2;
      this.onerror?.();
    }
    send(id, type, payload) {
      if (this.closed) return;
      this.onmessage?.({
        lastEventId: id,
        data: JSON.stringify({ type, payload }),
      });
    }
  };
}

export const settle = async (rounds = 8) => {
  for (let index = 0; index < rounds; index++)
    await new Promise((resolve) => setImmediate(resolve));
};

/** Private, crash-recoverable outbox. Never contains dispatch credentials. */
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { ProtocolEnvelope } from "@bd777/foundry-protocol";
import { writePrivateJSONAtomic } from "./storage.js";

export interface SessionOutboxStore {
  read(): ProtocolEnvelope[];
  put(envelope: ProtocolEnvelope): void;
  remove(id: string): void;
}

export class FileSessionOutbox implements SessionOutboxStore {
  constructor(private readonly root: string) {}
  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id))
      throw new Error("Invalid outbox identity");
    return resolve(this.root, `${id}.json`);
  }
  read(): ProtocolEnvelope[] {
    let files: string[];
    try {
      files = readdirSync(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return files
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const value = JSON.parse(
          readFileSync(resolve(this.root, name), "utf8"),
        ) as ProtocolEnvelope;
        if (
          !value.id ||
          !value.type ||
          this.path(value.id) !== resolve(this.root, name)
        )
          throw new Error(
            "Corrupt execution outbox; refusing to discard events.",
          );
        return value;
      });
  }
  put(envelope: ProtocolEnvelope): void {
    writePrivateJSONAtomic(this.path(envelope.id!), envelope);
  }
  remove(id: string): void {
    try {
      unlinkSync(this.path(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

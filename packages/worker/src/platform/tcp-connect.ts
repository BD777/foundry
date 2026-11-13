import { connect } from "node:net";

/** Resolves once a TCP connection to host:port opens; sends nothing. */
export function connectTcp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () =>
      finish(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)),
    );
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

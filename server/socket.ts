/**
 * Runtime-neutral unix-socket / named-pipe client built on `node:net`, which
 * both Bun (the dev bridge, `bun test`) and Node.js (the Electron Main
 * process) implement. `net.connect({ path })` covers POSIX unix sockets and
 * Windows named pipes (`\\.\pipe\…`) with the same call.
 *
 * This is the single connection primitive for the herdr API socket
 * (server/herdr.ts) and the private client socket (server/client-link.ts),
 * so the dev WebSocket server and the packaged desktop app share one
 * transport contract.
 */
import { connect, type Socket } from "node:net";

export interface SocketHandlers {
  data(chunk: Uint8Array): void;
  error?(err: Error): void;
  /** Fires once the socket is fully closed (after `error`, if any). */
  close?(): void;
}

/**
 * Connect to `path` (unix socket or Windows named pipe). Resolves with the
 * connected socket once the peer accepts; rejects on connect failure or a
 * close before connect. Data/error/close events are forwarded to `handlers`.
 */
export function connectSocket(path: string, handlers: SocketHandlers): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ path });
    let connected = false;
    let settled = false;

    socket.on("data", (chunk: Buffer) => handlers.data(chunk));
    socket.on("error", (err: Error) => {
      if (!connected) {
        settled = true;
        reject(err);
      } else {
        handlers.error?.(err);
      }
    });
    socket.on("close", () => {
      if (!connected && !settled) {
        settled = true;
        reject(new Error(`socket closed before connect: ${path}`));
      } else {
        handlers.close?.();
      }
    });
    socket.once("connect", () => {
      connected = true;
      resolve(socket);
    });
  });
}

/**
 * The minimal byte-stream surface the herdr clients need once a transport is
 * established: `net.Socket` satisfies it directly; SSH child-process stdio is
 * adapted to it by server/ssh.ts.
 */
export interface ByteStream {
  write(data: string | Uint8Array): unknown;
  end(): unknown;
}

/**
 * Opens one transport to a herdr endpoint and resolves once the peer accepts
 * (for sockets: after `connect`; for ssh: after spawn — the remote bridge
 * has no handshake, errors arrive via `error`/`close`).
 */
export type Connector = (handlers: SocketHandlers) => Promise<ByteStream>;

/** Connector for a local unix socket / Windows named pipe path. */
export function socketConnector(address: string): Connector {
  return (handlers) => connectSocket(address, handlers);
}

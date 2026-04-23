/// JSON-RPC transport over a Tauri `Channel<LspEvent>` (server → client)
/// paired with the `lspWrite` command (client → server). The `vscode-jsonrpc`
/// library expects a `MessageReader`/`MessageWriter` pair that emits/accepts
/// already-parsed `Message` objects, so this module handles the LSP
/// Content-Length framing manually.

// IMPORTANT: import from vscode-languageserver-protocol, not vscode-jsonrpc.
// The protocol package depends on vscode-jsonrpc; importing from both yields
// two copies of the same module at runtime (npm hoists one, keeps one nested),
// and their `ParameterStructures` enums fail `===` checks → the connection
// throws "Unknown parameter structure byName" on every sendRequest. Single
// import source keeps a single instance.
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageReader,
  type MessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-languageserver-protocol";
import { lspWrite } from "@/ipc/client";
import type { LspEvent, LspServerId } from "@/ipc/types";

/// Reader: consumes raw byte chunks from the Tauri Channel, reassembles
/// LSP-framed messages (`Content-Length: N\r\n\r\n<json>`) across chunks,
/// and dispatches parsed messages to vscode-jsonrpc.
export class ChannelMessageReader extends AbstractMessageReader implements MessageReader {
  private pending: Uint8Array = new Uint8Array(0);
  private callback: DataCallback | null = null;

  feed(bytes: Uint8Array): void {
    if (this.pending.length === 0) {
      this.pending = bytes;
    } else {
      const merged = new Uint8Array(this.pending.length + bytes.length);
      merged.set(this.pending, 0);
      merged.set(bytes, this.pending.length);
      this.pending = merged;
    }
    this.drain();
  }

  listen(callback: DataCallback): Disposable {
    this.callback = callback;
    this.drain();
    return {
      dispose: () => {
        this.callback = null;
      },
    };
  }

  private drain(): void {
    if (!this.callback) return;
    while (true) {
      const parsed = tryParseFrame(this.pending);
      if (!parsed) return;
      this.pending = parsed.rest;
      try {
        this.callback(parsed.message);
      } catch (err) {
        this.fireError(err);
      }
    }
  }
}

function tryParseFrame(
  buf: Uint8Array,
): { message: Message; rest: Uint8Array } | null {
  const headerEnd = findHeaderTerminator(buf);
  if (headerEnd === -1) return null;

  // Headers are strictly ASCII per the spec; decode as UTF-8 is a superset.
  const headers = new TextDecoder("utf-8").decode(buf.subarray(0, headerEnd));
  const match = /Content-Length:\s*(\d+)/i.exec(headers);
  if (!match) {
    throw new Error(`LSP frame missing Content-Length: ${headers}`);
  }
  const contentLen = parseInt(match[1], 10);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + contentLen;
  if (buf.length < bodyEnd) return null;

  const body = buf.subarray(bodyStart, bodyEnd);
  const json = new TextDecoder("utf-8").decode(body);
  const message = JSON.parse(json) as Message;
  return { message, rest: buf.subarray(bodyEnd) };
}

function findHeaderTerminator(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (
      buf[i] === 0x0d &&
      buf[i + 1] === 0x0a &&
      buf[i + 2] === 0x0d &&
      buf[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
}

export class ChannelMessageWriter extends AbstractMessageWriter implements MessageWriter {
  constructor(private readonly serverId: LspServerId) {
    super();
  }

  async write(msg: Message): Promise<void> {
    const json = JSON.stringify(msg);
    const body = new TextEncoder().encode(json);
    const header = new TextEncoder().encode(
      `Content-Length: ${body.byteLength}\r\n\r\n`,
    );
    const framed = new Uint8Array(header.length + body.length);
    framed.set(header, 0);
    framed.set(body, header.length);
    try {
      await lspWrite(this.serverId, framed);
    } catch (err) {
      this.fireError(err);
    }
  }

  end(): void {
    /* no-op — Rust side closes on kill */
  }
}

export function createConnection(
  reader: ChannelMessageReader,
  writer: ChannelMessageWriter,
): MessageConnection {
  return createMessageConnection(reader, writer);
}

/// Helper that wraps an `LspEvent` stream and pipes `Data` bytes into a
/// reader, surfacing `Stderr` and `Status` to optional observers.
export function onLspEvent(opts: {
  reader: ChannelMessageReader;
  onStderr?: (text: string) => void;
  onStatus?: (status: LspEvent & { kind: "status" }) => void;
}): (ev: LspEvent) => void {
  return (ev: LspEvent) => {
    if (ev.kind === "data") {
      opts.reader.feed(new Uint8Array(ev.bytes));
    } else if (ev.kind === "stderr") {
      opts.onStderr?.(ev.text);
    } else if (ev.kind === "status") {
      opts.onStatus?.(ev);
    }
  };
}

/**
 * The attach protocol of a terminal session: length-prefixed frames over a byte stream. Pure: bytes in, bytes
 * out. A frame is one type byte, a 32-bit big-endian length and that many bytes. Everything a peer sends is
 * untrusted: an unknown type or an oversize length ends the decoding for good (fail closed).
 */

export const ATTACH_PROTOCOL_VERSION = 1;
/** The most one frame may carry. The holder cuts its output into frames of at most this size. */
export const MAX_FRAME_PAYLOAD = 64 * 1024;
export const FRAME_HEADER_BYTES = 5;

export const FRAME = {
  HELLO: 0x01,
  INPUT: 0x02,
  RESIZE: 0x03,
  SEND: 0x04,
  WELCOME: 0x11,
  OUTPUT: 0x12,
  SENT: 0x13,
  BYE: 0x1f,
} as const;
export type FrameType = (typeof FRAME)[keyof typeof FRAME];

const KNOWN_TYPES: ReadonlySet<number> = new Set(Object.values(FRAME));
/** Frames only a client may send, and frames only the holder may send. */
export const CLIENT_FRAMES: ReadonlySet<number> = new Set([
  FRAME.HELLO,
  FRAME.INPUT,
  FRAME.RESIZE,
  FRAME.SEND,
]);
export const HOLDER_FRAMES: ReadonlySet<number> = new Set([
  FRAME.WELCOME,
  FRAME.OUTPUT,
  FRAME.SENT,
  FRAME.BYE,
]);

export interface Frame {
  type: FrameType;
  payload: Uint8Array;
}

/**
 * A two-way byte stream between the holder and one client. The socket implements it in `packages/local`; a test
 * uses an in-memory pair.
 */
export interface AttachStream {
  /** Queues the bytes for the peer. */
  write(data: Uint8Array): void;
  /** Bytes written here that the peer has not taken yet. */
  pending(): number;
  onData(listener: (data: Uint8Array) => void): void;
  /** Called once, for an end and for an error alike. */
  onClose(listener: (error?: Error) => void): void;
  /** Stops and restarts the delivery of the peer's bytes (backpressure). */
  pause(): void;
  resume(): void;
  /** Sends what is queued, then closes. */
  close(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const encodeFrame = (
  type: FrameType,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array => {
  if (payload.length > MAX_FRAME_PAYLOAD) {
    throw new RangeError(`a frame carries at most ${MAX_FRAME_PAYLOAD} bytes`);
  }
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
};

/** Bytes of any length as frames of one type, each within the limit. */
export const encodeChunked = (
  type: typeof FRAME.INPUT | typeof FRAME.OUTPUT,
  data: Uint8Array,
): Uint8Array[] => {
  const frames: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += MAX_FRAME_PAYLOAD) {
    frames.push(encodeFrame(type, data.subarray(at, at + MAX_FRAME_PAYLOAD)));
  }
  return frames;
};

export type FrameProblem = "unknown_type" | "oversize";

export interface FrameDecoder {
  /** The whole frames the bytes so far hold; a partial frame waits for the next call. */
  push(chunk: Uint8Array): { frames: Frame[]; problem?: FrameProblem };
  /** Bytes of a frame that is not whole yet. */
  buffered(): number;
  /**
   * Bytes the decoder has copied to keep what it holds, since it was made: at most a small multiple of the bytes
   * pushed, however they were cut into chunks.
   */
  moved(): number;
}

/** The store of a decoder that waits for nothing is given back when it grew past this. */
const DECODER_KEEP_BYTES = 2 * (FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD);

export const createFrameDecoder = (): FrameDecoder => {
  // The bytes not yet decoded are `store[start..end)`. A chunk is appended in place and the store doubles when it
  // is full, so a frame that arrives a byte at a time is copied a bounded number of times, not once per byte.
  let store = new Uint8Array(0);
  let start = 0;
  let end = 0;
  let failed: FrameProblem | undefined;
  let moved = 0;
  const append = (chunk: Uint8Array): void => {
    const held = end - start;
    moved += chunk.length;
    if (store.length - end < chunk.length) {
      const need = held + chunk.length;
      moved += held;
      if (need <= store.length) store.copyWithin(0, start, end);
      else {
        const grown = new Uint8Array(Math.max(need, 2 * store.length));
        grown.set(store.subarray(start, end));
        store = grown;
      }
      start = 0;
      end = held;
    }
    store.set(chunk, end);
    end += chunk.length;
  };
  return {
    buffered: () => end - start,
    moved: () => moved,
    push(chunk) {
      if (failed) return { frames: [], problem: failed };
      append(chunk);
      const frames: Frame[] = [];
      // The type and the length are judged as soon as they are there, before any payload is kept.
      while (end - start >= 1) {
        const type = store[start] as number;
        if (!KNOWN_TYPES.has(type)) {
          failed = "unknown_type";
          break;
        }
        if (end - start < FRAME_HEADER_BYTES) break;
        const length = new DataView(store.buffer, store.byteOffset + start + 1, 4).getUint32(0);
        if (length > MAX_FRAME_PAYLOAD) {
          failed = "oversize";
          break;
        }
        if (end - start < FRAME_HEADER_BYTES + length) break;
        frames.push({
          type: type as FrameType,
          payload: store.slice(start + FRAME_HEADER_BYTES, start + FRAME_HEADER_BYTES + length),
        });
        start += FRAME_HEADER_BYTES + length;
      }
      if (failed || start === end) {
        start = 0;
        end = 0;
        if (failed || store.length > DECODER_KEEP_BYTES) store = new Uint8Array(0);
      }
      return failed ? { frames, problem: failed } : { frames };
    },
  };
};

export interface TerminalSize {
  cols: number;
  rows: number;
}

export const MAX_TERMINAL_SIDE = 4096;

export const isTerminalSize = (value: unknown): value is TerminalSize => {
  if (typeof value !== "object" || value === null) return false;
  const { cols, rows } = value as { cols?: unknown; rows?: unknown };
  const side = (n: unknown) =>
    typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_TERMINAL_SIDE;
  return side(cols) && side(rows);
};

export interface HelloMessage {
  v: number;
  /** Absent for a client that does not show the terminal (`send`): it gets no output and resizes nothing. */
  size?: TerminalSize;
}

export type ByeReason =
  | "exited"
  | "killed"
  | "holder_error"
  | "version"
  | "protocol"
  | "hello_timeout"
  | "full"
  | "lagging";

export interface ByeMessage {
  reason: ByeReason;
  text?: string;
  exitCode?: number;
  signal?: string;
}

export interface SendMessage {
  text: string;
  submit?: boolean;
}

const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

const parse = (payload: Uint8Array): unknown => {
  try {
    return JSON.parse(decoder.decode(payload)) as unknown;
  } catch {
    return undefined;
  }
};

const sizeOf = (size: TerminalSize): TerminalSize => ({ cols: size.cols, rows: size.rows });

export const encodeHello = (
  size: TerminalSize | undefined,
  v: number = ATTACH_PROTOCOL_VERSION,
): Uint8Array => encodeFrame(FRAME.HELLO, json({ v, ...(size ? sizeOf(size) : {}) }));
export const encodeWelcome = (size: TerminalSize): Uint8Array =>
  encodeFrame(FRAME.WELCOME, json({ v: ATTACH_PROTOCOL_VERSION, ...sizeOf(size) }));
export const encodeResize = (size: TerminalSize): Uint8Array =>
  encodeFrame(FRAME.RESIZE, json(sizeOf(size)));
export const encodeBye = (message: ByeMessage): Uint8Array => encodeFrame(FRAME.BYE, json(message));
export const encodeSend = (message: SendMessage): Uint8Array =>
  encodeFrame(FRAME.SEND, json(message));
export const encodeSent = (bytes: number): Uint8Array => encodeFrame(FRAME.SENT, json({ bytes }));

/** `undefined` for a payload that is not a hello; the version is the caller's to judge. */
export const parseHello = (payload: Uint8Array): HelloMessage | undefined => {
  const value = parse(payload);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { v, cols, rows } = value as Record<string, unknown>;
  if (typeof v !== "number" || !Number.isInteger(v)) return undefined;
  if (cols === undefined && rows === undefined) return { v };
  return isTerminalSize(value) ? { v, size: sizeOf(value) } : undefined;
};

export const parseSize = (payload: Uint8Array): TerminalSize | undefined => {
  const value = parse(payload);
  return isTerminalSize(value) ? sizeOf(value) : undefined;
};

export const parseBye = (payload: Uint8Array): ByeMessage | undefined => {
  const value = parse(payload);
  if (typeof value !== "object" || value === null) return undefined;
  const { reason, text, exitCode, signal } = value as Record<string, unknown>;
  if (typeof reason !== "string") return undefined;
  return {
    reason: reason as ByeReason,
    ...(typeof text === "string" ? { text } : {}),
    ...(typeof exitCode === "number" ? { exitCode } : {}),
    ...(typeof signal === "string" ? { signal } : {}),
  };
};

export const parseSend = (payload: Uint8Array): SendMessage | undefined => {
  const value = parse(payload);
  if (typeof value !== "object" || value === null) return undefined;
  const { text, submit } = value as Record<string, unknown>;
  if (typeof text !== "string") return undefined;
  if (submit !== undefined && typeof submit !== "boolean") return undefined;
  return { text, ...(submit !== undefined ? { submit } : {}) };
};

export const parseSent = (payload: Uint8Array): { bytes: number } | undefined => {
  const value = parse(payload);
  const bytes = (value as { bytes?: unknown } | null | undefined)?.bytes;
  return typeof bytes === "number" ? { bytes } : undefined;
};

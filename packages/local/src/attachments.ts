/**
 * The file-system side of run attachments (T-45): reading the file an agent names out of the run's
 * working directory, and finding the type of some bytes. The agent's `path` is untrusted: the file is
 * opened once and everything is judged on that handle, so what is checked is what is read.
 */
import { constants } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { type AttachmentImageType, type AttachmentType, KodelError } from "@kodel-ai/pipeline-core";

/** Tests step in between the open and the checks, where a swap of the file would happen. */
export interface AttachmentHooks {
  afterOpen?(path: string): void | Promise<void>;
  /** After the file of a version was created and before its event is decided. */
  afterFile?(ref: string): void | Promise<void>;
}

const refuse = (message: string) => new KodelError("INVALID_ARGUMENTS", message);

interface Identity {
  dev: number;
  ino: number;
}

const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;

async function identityOf(path: string): Promise<Identity | undefined> {
  try {
    const info = await stat(path);
    return { dev: info.dev, ino: info.ino };
  } catch {
    return undefined;
  }
}

/** The folders of the working directory nothing is taken from: git's own files and kodel's. */
const CLOSED_FOLDERS = [".git", ".kodel"];

/**
 * Read a regular file inside `cwd`, at most `cap` bytes. Refused: anything that is not a regular file
 * with one link, a file over the cap (it is not read), a path that leaves `cwd` or enters `.git/` or
 * `.kodel/` (compared by the identity of the folders, so the case of the letters does not matter), and
 * a path whose file is not the one that was opened (a link, or a swap between the open and the check).
 * Windows has no `O_NOFOLLOW`; there the comparison of identities alone guards.
 */
export async function readWorkdirFile(
  cwd: string,
  path: string,
  cap: number,
  hooks?: AttachmentHooks,
): Promise<Buffer> {
  if (path.includes("\0")) throw refuse("the path is not a file inside the working directory");
  const target = isAbsolute(path) ? path : join(cwd, path);
  let handle: FileHandle;
  try {
    // Non-blocking, so that a FIFO is opened (and then refused as not a regular file), not waited for.
    handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw refuse(
      code === "ELOOP" || code === "EMLINK"
        ? "the path is a link; an attachment is read from a regular file"
        : code === "ENOENT" || code === "ENOTDIR"
          ? "there is no such file in the working directory"
          : `the file cannot be opened (${code ?? "error"})`,
    );
  }
  try {
    await hooks?.afterOpen?.(target);
    const info = await handle.stat();
    if (!info.isFile()) throw refuse("the path is not a regular file");
    if (info.nlink !== 1) {
      throw refuse("the file is not a plain file with one link; an attachment is read from one");
    }
    if (info.size > cap) {
      throw refuse(`the file is ${info.size} bytes; the limit for this type is ${cap} bytes`);
    }
    const outside = refuse("the path is not a file inside the run's working directory");
    let real: string;
    let root: string;
    try {
      real = await realpath(target);
      root = await realpath(cwd);
    } catch {
      throw outside;
    }
    // The path must still name the file that was opened: a link put in its place names another.
    const named = await identityOf(real);
    if (named === undefined || !same(named, { dev: info.dev, ino: info.ino })) throw outside;
    const rootId = await identityOf(root);
    if (rootId === undefined) throw outside;
    const closed: Identity[] = [];
    for (const folder of CLOSED_FOLDERS) {
      const id = await identityOf(join(root, folder));
      if (id !== undefined) closed.push(id);
    }
    const inClosed = (id: Identity) => closed.some((c) => same(c, id));
    if (inClosed(named)) throw refuse("nothing is taken from .git or .kodel");
    let inside = false;
    for (let dir = dirname(real); ; dir = dirname(dir)) {
      const id = await identityOf(dir);
      if (id === undefined) throw outside;
      if (inClosed(id)) throw refuse("nothing is taken from .git or .kodel");
      if (same(id, rootId)) {
        inside = true;
        break;
      }
      if (dirname(dir) === dir) break;
    }
    if (!inside) throw outside;
    // From the handle, and no more than the cap whatever the file has grown to since.
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const startsWith = (bytes: Uint8Array, magic: readonly number[], at = 0) =>
  bytes.length >= at + magic.length && magic.every((byte, i) => bytes[at + i] === byte);

/** The image type the first bytes say, or `undefined`. */
export function sniffImage(bytes: Uint8Array): AttachmentImageType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return "gif";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "gif";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "webp";
  }
  return undefined;
}

/** The text of some bytes, if they are valid UTF-8 without a NUL; `undefined` otherwise. */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Why some bytes are not of the type their name says, or `undefined` when they are. The type is the
 * host's finding, never the agent's word: an image must begin as its type does, a text must be text.
 */
export function typeProblem(type: AttachmentType, bytes: Uint8Array): string | undefined {
  if (type === "text") {
    return decodeText(bytes) === undefined
      ? "the content is not text (valid UTF-8 without a NUL byte), though the name says it is"
      : undefined;
  }
  const found = sniffImage(bytes);
  if (found === type) return undefined;
  return found === undefined
    ? `the file is not a ${type.toUpperCase()} image, though the name says it is`
    : `the file is a ${found.toUpperCase()} image, though the name says ${type.toUpperCase()}`;
}

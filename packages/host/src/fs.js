import { run } from "tokamak:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function argument(message, code = "ERR_INVALID_ARG_TYPE") {
  return Object.assign(new TypeError(message), { code });
}

function pathBytes(value) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return value;
  throw argument("Expected a path string, URL, Buffer or Uint8Array");
}

function options(value) {
  return typeof value === "string" ? { encoding: value } : (value ?? {});
}

function fromBytes(bytes, encoding) {
  const buffer = Buffer.from(bytes);
  return encoding === "buffer" || encoding === null || encoding === undefined
    ? buffer
    : buffer.toString(encoding);
}

function fileData(value, encoding) {
  if (typeof value === "string") return Buffer.from(value, encoding ?? "utf8");
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw argument("Expected file data to be a string or byte array");
}

const kinds = ["File", "Directory", "SymbolicLink", "FIFO", "BlockDevice", "CharacterDevice", "Socket"];
function withKind({ kind, ...info }) {
  for (const name of kinds) info["is" + name] = () => name === kind;
  return info;
}

function stats(raw) {
  for (const key of ["atime", "mtime", "ctime", "birthtime"]) raw[key] = new Date(raw[key + "Ms"]);
  return withKind(raw);
}

function validateRange(buffer, offset, length) {
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.byteLength
  ) {
    throw argument("Offset and length must be inside the supplied buffer", "ERR_OUT_OF_RANGE");
  }
}

function wrapHandle(handle) {
  return {
    get fd() {
      return handle.fd;
    },
    close: () => handle.close(),
    chmod: (mode) => handle.chmod(mode),
    chown: (uid, gid) => handle.chown(uid, gid),
    sync: () => handle.sync(),
    datasync: () => handle.datasync(),
    truncate: (size = 0) => handle.truncate(size),
    stat: async () => stats(await handle.stat()),
    readFile: async (opts) => fromBytes(await handle.readBytes(), options(opts).encoding),
    writeFile: (data, opts) => handle.writeBytes(fileData(data, options(opts).encoding)),
    read: withFsErrors(async (buffer = Buffer.alloc(16384), offset, length, position) => {
      if (!(buffer instanceof Uint8Array)) {
        ({ buffer = Buffer.alloc(16384), offset, length, position } = buffer);
      } else if (typeof offset === "object" && offset !== null) {
        ({ offset, length, position } = offset);
      }
      offset ??= 0;
      length ??= buffer.byteLength - offset;
      validateRange(buffer, offset, length);
      const bytes = await handle.readChunk(length, position ?? undefined);
      buffer.set(bytes, offset);
      return { bytesRead: bytes.byteLength, buffer };
    }),
    write: withFsErrors(async (buffer, offset, length, position) => {
      if (typeof buffer === "string") {
        const bytesWritten = await handle.writeChunk(fileData(buffer, length), offset ?? undefined);
        return { bytesWritten, buffer };
      }
      if (typeof offset === "object" && offset !== null) ({ offset, length, position } = offset);
      offset ??= 0;
      length ??= buffer.byteLength - offset;
      const data = fileData(buffer);
      validateRange(data, offset, length);
      const bytesWritten = await handle.writeChunk(
        data.subarray(offset, offset + length),
        position ?? undefined,
      );
      return { bytesWritten, buffer };
    }),
  };
}

const invoke = (name, path, opts = {}) => run(name, pathBytes(path), opts ?? {});

function withFsErrors(operation) {
  return async (...args) => {
    try {
      return await operation(...args);
    } catch (error) {
      if (error instanceof Error && typeof error.code !== "string") {
        error.code = "ERR_INVALID_ARG_VALUE";
      }
      throw error;
    }
  };
}

export const constants = Object.freeze({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 });
const wrapped = (() => {
  const access = (path, mode) => invoke("access", path, { mode });
  const chmod = (path, mode) => invoke("chmod", path, { mode });
  const open = async (path, flag, mode) => wrapHandle(await invoke("open", path, { flag, mode }));
  const readFile = async (path, opts) =>
    fromBytes(await invoke("readFile", path, options(opts)), options(opts).encoding);
  const writeFile = (path, data, opts) =>
    invoke("writeFile", path, { ...options(opts), data: fileData(data, options(opts).encoding) });
  const rename = async (path, dest) => invoke("rename", path, { dest: pathBytes(dest) });
  const readdir = async (path, opts) => {
    const { encoding = "utf8", withFileTypes = false, recursive = false } = options(opts);
    const entries = await invoke("readdir", path, { recursive });
    return entries.map(([bytes, kind]) => {
      const name = fromBytes(bytes, encoding);
      if (!withFileTypes) return name;
      const relative = fromBytes(bytes, "utf8");
      const parentPath = join(fromBytes(pathBytes(path), "utf8"), dirname(relative));
      return withKind({
        kind,
        name: encoding === "buffer" ? name.subarray(name.lastIndexOf(47) + 1) : basename(relative),
        parentPath,
      });
    });
  };
  const mkdir = async (path, opts) => {
    const result = await invoke("mkdir", path, typeof opts === "number" ? { mode: opts } : opts);
    if (result !== undefined) return fromBytes(result, "utf8");
  };
  const mkdtemp = async (path, opts) =>
    fromBytes(await invoke("mkdtemp", path), options(opts).encoding ?? "utf8");
  const rm = (path, opts) => invoke("rm", path, opts);
  const rmdir = (path, opts) => invoke("rmdir", path, opts);
  const stat = async (path) => stats(await invoke("stat", path));
  const lstat = async (path) => stats(await invoke("lstat", path));
  const symlink = async (path, dest) => invoke("symlink", path, { dest: pathBytes(dest) });
  const realpath = async (path, opts) =>
    fromBytes(await invoke("realpath", path), options(opts).encoding ?? "utf8");
  const unlink = (path) => invoke("unlink", path);
  async function cp(path, dest, opts = {}) {
    if (opts.filter !== undefined || opts.verbatimSymlinks !== undefined) {
      throw argument(
        "cp options filter and verbatimSymlinks are not supported on the plugin host",
        "ERR_INVALID_ARG_VALUE",
      );
    }
    await invoke("cp", path, { ...opts, dest: pathBytes(dest) });
  }

  const methods = {
    access,
    chmod,
    cp,
    lstat,
    mkdir,
    mkdtemp,
    open,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    rmdir,
    stat,
    symlink,
    unlink,
    writeFile,
  };

  return Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, withFsErrors(method)]));
})();

export const {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} = wrapped;

export default { ...wrapped, constants };

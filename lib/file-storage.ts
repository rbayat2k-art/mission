import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { Readable } from "node:stream";

function storageRoot() {
  return resolve(/* turbopackIgnore: true */ process.env.UPLOAD_DIR?.trim() || "storage/uploads");
}

function objectPath(key: string) {
  if (!key || isAbsolute(key) || key.includes("..") || !/^[a-zA-Z0-9/_-]+$/.test(key)) {
    throw new Error("Invalid storage object key");
  }
  const root = storageRoot();
  const target = resolve(root, key);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Storage path escaped upload root");
  return target;
}

export const fileStorage = {
  async put(key: string, value: ArrayBuffer | Uint8Array | Blob) {
    const target = objectPath(key);
    await mkdir(dirname(target), { recursive: true });
    const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : new Uint8Array(value);
    await writeFile(target, bytes, { flag: "wx" });
  },

  async get(key: string) {
    const target = objectPath(key);
    try {
      await stat(/* turbopackIgnore: true */ target);
      const stream = createReadStream(/* turbopackIgnore: true */ target);
      return { body: Readable.toWeb(stream) as ReadableStream };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },

  async delete(key: string) {
    const target = objectPath(key);
    await rm(target, { force: true });
  },
};

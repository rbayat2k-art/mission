import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const standalone = resolve(root, ".next/standalone");

await mkdir(resolve(standalone, ".next"), { recursive: true });
await cp(resolve(root, ".next/static"), resolve(standalone, ".next/static"), { recursive: true });
await cp(resolve(root, "public"), resolve(standalone, "public"), { recursive: true });
await mkdir(resolve(standalone, "db"), { recursive: true });
await cp(resolve(root, "db/mysql-schema.sql"), resolve(standalone, "db/mysql-schema.sql"));
await mkdir(resolve(standalone, "storage/uploads"), { recursive: true });

console.log("Prepared standalone Node.js server for cPanel/PM2.");

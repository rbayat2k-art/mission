import { createWriteStream } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const backupDirectory = resolve(process.cwd(), "storage/backups");
const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupPath = resolve(backupDirectory, `database-${timestamp}.sql`);

await mkdir(backupDirectory, { recursive: true, mode: 0o700 });

const dump = spawn(
  process.env.MYSQLDUMP_BIN?.trim() || "mysqldump",
  [
    `--host=${process.env.DB_HOST?.trim() || "127.0.0.1"}`,
    `--port=${Number(process.env.DB_PORT || 3306)}`,
    `--user=${required("DB_USER")}`,
    "--single-transaction",
    "--quick",
    "--lock-tables=false",
    "--no-tablespaces",
    "--default-character-set=utf8mb4",
    required("DB_NAME"),
  ],
  {
    env: { ...process.env, MYSQL_PWD: required("DB_PASSWORD") },
    stdio: ["ignore", "pipe", "inherit"],
  },
);

const output = createWriteStream(backupPath, { mode: 0o600 });
dump.stdout.pipe(output);

const outputFinished = new Promise((accept, reject) => {
  output.once("error", reject);
  output.once("close", accept);
});

const exitCode = await new Promise((accept, reject) => {
  dump.once("error", reject);
  dump.once("close", accept);
});

await outputFinished;

if (exitCode !== 0) {
  await rm(backupPath, { force: true });
  throw new Error(`mysqldump failed with exit code ${exitCode}`);
}

await chmod(backupPath, 0o600);
console.log(`Database backup created: ${backupPath}`);

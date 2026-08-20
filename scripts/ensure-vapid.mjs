import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import webpush from "web-push";

const requestedPath = process.argv[2] || ".env";
const envPath = path.resolve(process.cwd(), requestedPath);
const envDirectory = path.dirname(envPath);
const temporaryPath = path.join(envDirectory, `.env.vapid-${process.pid}-${Date.now()}.tmp`);
const original = await readFile(envPath, "utf8");

function currentValue(name) {
  return original.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() ?? "";
}

const currentPublicKey = currentValue("VAPID_PUBLIC_KEY");
const currentPrivateKey = currentValue("VAPID_PRIVATE_KEY");
if (currentPublicKey && currentPrivateKey) {
  console.log("Web Push keys are already configured.");
  process.exit(0);
}
if (Boolean(currentPublicKey) !== Boolean(currentPrivateKey)) {
  throw new Error("VAPID configuration is incomplete; refusing to replace an existing key.");
}

const generated = webpush.generateVAPIDKeys();
function upsert(source, name, value) {
  const pattern = new RegExp(`^${name}=.*$`, "m");
  if (pattern.test(source)) return source.replace(pattern, `${name}=${value}`);
  const separator = source.endsWith("\n") ? "" : "\n";
  return `${source}${separator}${name}=${value}\n`;
}

let updated = upsert(original, "VAPID_PUBLIC_KEY", generated.publicKey);
updated = upsert(updated, "VAPID_PRIVATE_KEY", generated.privateKey);
if (!currentValue("VAPID_SUBJECT")) updated = upsert(updated, "VAPID_SUBJECT", "mailto:admin@taprasystem.ir");

await writeFile(temporaryPath, updated, { encoding: "utf8", mode: 0o600, flag: "wx" });
await rename(temporaryPath, envPath);
await chmod(envPath, 0o600);
console.log("Web Push keys were generated and stored securely.");

"use strict";

try {
  process.loadEnvFile?.(".env");
} catch (error) {
  if (error && error.code !== "ENOENT") throw error;
}

process.env.NODE_ENV = "production";
process.env.HOSTNAME ||= "127.0.0.1";
process.env.PORT ||= "3000";
process.chdir(__dirname);
require("./.next/standalone/server.js");

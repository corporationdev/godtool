import fs from "node:fs";
import path from "node:path";

import { exportVariable, setSecret } from "@actions/core";
import dotenv from "dotenv";

const repoRoot = process.cwd();
const env = dotenv.parse(
  fs.readFileSync(path.join(repoRoot, ".env.resolved"), "utf8"),
);

const SECRET_KEYS = new Set(["DATABASE_URL"]);

for (const [key, value] of Object.entries(env)) {
  const isSecret =
    SECRET_KEYS.has(key) ||
    key.endsWith("_KEY") ||
    key.endsWith("_TOKEN") ||
    key.endsWith("_SECRET") ||
    key.endsWith("_PASSWORD");

  if (isSecret) {
    setSecret(value);
  }

  exportVariable(key, value);
}

import { defineConfig } from "drizzle-kit";

// Drizzle commands that connect to a database (for example `migrate` and
// `studio`) should always target the configured remote database.
// drizzle-kit uses node-postgres (`pg`) for studio and the `ssl` option in
// dbCredentials doesn't reliably reach the pool — append `sslmode=require`
// directly to the URL instead, which `pg` honours.

const withSslMode = (url: string): string => {
  if (url.includes("127.0.0.1") || url.includes("localhost")) return url;
  if (/[?&]sslmode=/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "sslmode=require";
};

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set for apps/cloud drizzle commands.");
}

export default defineConfig({
  schema: [
    "./src/services/schema.ts",
    "./src/services/executor-schema.ts",
    "./src/services/blob-schema.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: withSslMode(databaseUrl),
  },
});

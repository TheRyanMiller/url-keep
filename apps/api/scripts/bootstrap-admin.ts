import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { hashPassword, makeId, nowIso } from "../src/utils";

function usage(): never {
  console.error("Usage: npm run bootstrap:admin -- <email> [--local] [--db <binding-or-name>]");
  process.exit(1);
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

async function main() {
  const args = process.argv.slice(2);
  const email = args.find((value) => !value.startsWith("--"));
  if (!email) {
    usage();
  }

  const isLocal = args.includes("--local");
  const dbIndex = args.indexOf("--db");
  const databaseName =
    (dbIndex >= 0 ? args[dbIndex + 1] : undefined) ??
    process.env.D1_DATABASE_NAME ??
    "DB";

  if (!databaseName) {
    usage();
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const password = (await rl.question("Password: ")).trim();
    const confirm = (await rl.question("Confirm password: ")).trim();

    if (!password) {
      console.error("Password cannot be empty.");
      process.exit(1);
    }

    if (password !== confirm) {
      console.error("Passwords do not match.");
      process.exit(1);
    }

    const now = nowIso();
    const sql = `
INSERT INTO users (id, email, password_hash, created_at)
SELECT '${escapeSql(makeId())}', '${escapeSql(email)}', '${escapeSql(hashPassword(password))}', '${escapeSql(now)}'
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE email = '${escapeSql(email)}'
);
    `.trim();

    const command = [
      "wrangler",
      "d1",
      "execute",
      databaseName,
      "--command",
      sql,
      ...(isLocal ? ["--local"] : []),
    ];

    execFileSync("npx", command, {
      stdio: "inherit",
      cwd: new URL("..", import.meta.url),
    });
  } finally {
    rl.close();
  }
}

void main();

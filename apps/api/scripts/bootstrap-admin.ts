import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { hashPassword, makeId, nowIso } from "../src/utils";

function usage(): never {
  console.error(
    "Usage: npm run bootstrap:admin -- <email> [--local | --remote] [--db <binding-or-name>]",
  );
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
  const isRemote = args.includes("--remote");
  if (isLocal && isRemote) {
    console.error("Choose either --local or --remote, not both.");
    process.exit(1);
  }

  const dbIndex = args.indexOf("--db");
  const databaseName =
    (dbIndex >= 0 ? args[dbIndex + 1] : undefined) ??
    process.env.D1_DATABASE_NAME ??
    "DB";

  if (!databaseName) {
    usage();
  }

  const suppliedPassword = process.env.URL_KEEP_ADMIN_PASSWORD;
  const rl = suppliedPassword
    ? undefined
    : createInterface({ input: stdin, output: stdout });

  try {
    const password = (
      suppliedPassword ?? (await rl?.question("Password: ")) ?? ""
    ).trim();
    const confirm = suppliedPassword
      ? password
      : ((await rl?.question("Confirm password: ")) ?? "").trim();

    if (!password) {
      console.error("Password cannot be empty.");
      process.exit(1);
    }

    if (password !== confirm) {
      console.error("Passwords do not match.");
      process.exit(1);
    }

    const now = nowIso();
    const passwordHash = await hashPassword(password);
    const sql = `
INSERT INTO users (id, email, password_hash, created_at)
VALUES ('${escapeSql(makeId())}', '${escapeSql(email)}', '${escapeSql(passwordHash)}', '${escapeSql(now)}')
ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash;
    `.trim();
    const tempDir = mkdtempSync(join(tmpdir(), "url-keep-bootstrap-"));
    const sqlFile = join(tempDir, "bootstrap-admin.sql");
    writeFileSync(sqlFile, sql);

    try {
      const command = [
        "wrangler",
        "d1",
        "execute",
        databaseName,
        "--config",
        "apps/api/wrangler.toml",
        "--file",
        sqlFile,
        ...(isLocal ? ["--local"] : ["--remote"]),
      ];

      execFileSync("npx", command, {
        stdio: "inherit",
        cwd: new URL("../../..", import.meta.url),
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } finally {
    rl?.close();
  }
}

await main();

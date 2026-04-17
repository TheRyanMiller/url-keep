import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBookmarkUrl } from "@url-keep/shared";

type BookmarkRow = {
  id: string;
  normalized_url?: string | null;
  url?: string | null;
};

function usage(): never {
  console.error(
    "Usage: npm run backfill:bookmark-buckets -- [--local | --remote] [--db <binding-or-name>]",
  );
  process.exit(1);
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function executeWranglerJson(
  databaseName: string,
  args: string[],
): unknown {
  const output = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", databaseName, "--json", ...args],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  return JSON.parse(output);
}

function extractResults(payload: unknown): BookmarkRow[] {
  if (Array.isArray(payload)) {
    const firstWithResults = payload.find(
      (entry) =>
        entry
        && typeof entry === "object"
        && "results" in entry
        && Array.isArray((entry as { results?: unknown }).results),
    ) as { results: BookmarkRow[] } | undefined;
    return firstWithResults?.results ?? [];
  }

  if (
    payload
    && typeof payload === "object"
    && "results" in payload
    && Array.isArray((payload as { results?: unknown }).results)
  ) {
    return (payload as { results: BookmarkRow[] }).results;
  }

  throw new Error("Unexpected response from wrangler d1 execute --json");
}

async function main() {
  const args = process.argv.slice(2);
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

  const locationArg = isLocal ? "--local" : "--remote";
  const selectSql = `
SELECT id, normalized_url, url
FROM bookmarks
WHERE bucket IS NULL OR bucket NOT IN ('reading', 'videos')
ORDER BY created_at ASC, id ASC;
  `.trim();

  const payload = executeWranglerJson(databaseName, [locationArg, "--command", selectSql]);
  const rows = extractResults(payload);
  if (rows.length === 0) {
    console.log("No bookmark buckets need backfilling.");
    return;
  }

  const updates = rows.map((row) => {
    const sourceUrl = row.normalized_url ?? row.url;
    if (!sourceUrl) {
      throw new Error(`Bookmark ${row.id} is missing both normalized_url and url`);
    }

    const bucket = classifyBookmarkUrl(sourceUrl).bucket;
    return `UPDATE bookmarks SET bucket = '${escapeSql(bucket)}' WHERE id = '${escapeSql(row.id)}';`;
  });

  // Remote D1 execute rejects raw BEGIN/COMMIT statements. The updates are
  // idempotent, so falling back to plain sequential statements is safe there.
  const sql = (isRemote
    ? updates
    : [
        "BEGIN TRANSACTION;",
        ...updates,
        "COMMIT;",
      ]).join("\n");

  const tempDir = mkdtempSync(join(tmpdir(), "url-keep-bucket-backfill-"));
  const sqlFile = join(tempDir, "backfill-bookmark-buckets.sql");
  writeFileSync(sqlFile, sql);

  try {
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", databaseName, locationArg, "--file", sqlFile],
      {
        cwd: new URL("..", import.meta.url),
        stdio: "inherit",
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`Backfilled ${rows.length} bookmark bucket${rows.length === 1 ? "" : "s"}.`);
}

void main();

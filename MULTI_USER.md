# Multi-User & Self-Hosting Plan

## 1. One-Command Self-Hosting Setup

### Current State

Self-hosting requires **8+ manual steps** across multiple services:

1. Create a Cloudflare account
2. `npm install`
3. Create D1 database via `wrangler d1 create url_keep`
4. Create R2 bucket via `wrangler r2 bucket create url-keep-images`
5. Edit `wrangler.toml` with your database_id, custom domain, APP_ORIGIN, extension origins
6. Set TOKEN_PEPPER secret via `wrangler secret put TOKEN_PEPPER`
7. Run D1 migrations (`npm run d1:migrate:remote`)
8. Bootstrap admin user (`npm run bootstrap:admin -- email --remote`)
9. Deploy API (`npm run deploy:api`)
10. Deploy web app to Vercel (configure env vars, build command, output dir)
11. Build and side-load the extension

The `wrangler.toml` has hardcoded values (database_id `9e9fadd4-...`, custom domain `api.url-keep.com`, extension origin). A new user must know to change all of these.

### What's Needed

**A. `setup.sh` interactive bootstrap script**

Single entry point that walks the user through everything:

```bash
npx url-keep setup
# or
./scripts/setup.sh
```

The script would:

1. Check prerequisites (`node`, `npm`, `wrangler` CLI installed and authenticated)
2. Prompt for: email, password, custom domain (or use `*.workers.dev` default)
3. Create D1 database, capture the returned database_id
4. Create R2 bucket
5. Generate a random TOKEN_PEPPER and set it as a Worker secret
6. Write a `wrangler.toml` from a template (`wrangler.toml.example`) with the user's values
7. Run D1 migrations
8. Bootstrap the admin user
9. Deploy the API worker
10. Print the API URL

Estimated effort: ~150 lines of shell script + a `wrangler.toml.example` template.

**B. `wrangler.toml.example` template**

Ship a checked-in template with placeholder values:

```toml
name = "url-keep-api"
main = "src/index.ts"
compatibility_date = "2026-03-09"

[vars]
APP_ORIGIN = "__APP_ORIGIN__"
ALLOWED_EXTENSION_ORIGINS = ""

[[d1_databases]]
binding = "DB"
database_name = "__DB_NAME__"
database_id = "__DB_ID__"

[[r2_buckets]]
binding = "IMAGES"
bucket_name = "__BUCKET_NAME__"
```

The real `wrangler.toml` gets `.gitignore`d. The setup script generates it.

**C. Web app deployment options**

Two documented paths:

1. **Cloudflare Pages** (recommended for all-Cloudflare simplicity) — add a Pages build config or document the dashboard steps
2. **Vercel** (current approach) — document the exact env vars and build settings

The setup script could optionally handle the Cloudflare Pages deployment too, keeping everything in one ecosystem.

**D. Extension build**

Document how to build and side-load. The extension needs the API origin configured, which the setup script can output.

### Summary

| Item | Exists today? | Work needed |
|---|---|---|
| wrangler.toml template | No (hardcoded) | Create `wrangler.toml.example`, gitignore real one |
| Interactive setup script | No | ~150 LOC shell script |
| D1/R2 auto-creation | No | Part of setup script |
| Web deploy docs | Partial | Document both Vercel and CF Pages paths |
| Extension build docs | Partial | Add to setup output |

---

## 2. Multi-User Support

### Current State

The **database schema already supports multiple users**. Every table has `user_id` foreign keys, and the unique constraint on bookmarks is `(user_id, normalized_url)` — fully multi-tenant at the data layer.

What's missing is the **application layer**:

- No signup endpoint — users are created exclusively via the `bootstrap-admin` CLI script
- No user creation API
- No invitation flow
- No password reset / email verification
- The design doc explicitly lists multi-user as a v1 non-goal

### What's Needed

There are two reasonable models depending on the goal:

### Option A: Admin-Managed Users (Recommended First Step)

Keep signups closed. The instance owner creates accounts for friends/family.

**Changes required:**

1. **`POST /v1/admin/users` endpoint** — authenticated, admin-only
   - Accepts `{ email, password }`, creates a new user
   - Only callable by the first bootstrapped user (admin flag or just `user_id = first-created`)

2. **Admin flag on users table** — migration to add `is_admin BOOLEAN DEFAULT FALSE`
   - Bootstrap script sets `is_admin = TRUE` for the initial user
   - Admin check middleware for admin-only endpoints

3. **`GET /v1/admin/users`** — list all users (admin-only)

4. **`DELETE /v1/admin/users/:id`** — remove a user and cascade-delete their data (admin-only)

5. **Web UI** — admin settings page with user management table

Estimated effort: ~200 LOC backend + migration + admin UI page.

### Option B: Open Registration

Allow anyone to create an account on a public instance.

**Additional changes beyond Option A:**

1. **`POST /v1/auth/register` endpoint** — public, creates account + returns token
2. **Rate limiting** on registration (Cloudflare Workers has `cf.botManagement` or use simple IP-based limits)
3. **Email verification** (optional but recommended) — requires an email service (Mailgun, Resend, etc.)
4. **Per-user storage quotas** — prevent a single user from filling up D1/R2
5. **Password reset flow** — requires email service

This is significantly more work and introduces operational complexity (email service, abuse prevention). Only recommended if you plan to run a public instance.

### Data Isolation

Already handled — every query filters by `user_id` from the authenticated token. No cross-user data leakage is possible with the current query patterns in `d1-store.ts`.

### Summary

| Item | Exists today? | Work needed |
|---|---|---|
| Multi-tenant schema | Yes | None |
| Per-user data isolation | Yes | None |
| User creation API | No | New endpoint + admin middleware |
| Admin role | No | Migration + middleware |
| Admin UI for users | No | New settings page section |
| Open registration | No | Endpoint + rate limiting + email |
| Password reset | No | Email service integration |

**Recommendation:** Start with Option A (admin-managed users). It's a small, contained change that enables multi-user without the complexity of open registration, email services, or abuse prevention.

---

## 3. Telegram Bot Integration

### Current State

The API **almost fully supports this today**. The pieces that exist:

- `POST /v1/bookmarks` accepts a URL + bearer token — exactly what a bot needs
- Token system supports named tokens (e.g., "Telegram Bot") via `POST /v1/tokens`
- The `@url-keep/api-client` package provides a typed HTTP client

**One blocker:** the `saved_via` column has a CHECK constraint:

```sql
CHECK (saved_via IN ('web', 'mobile_web', 'extension', 'ios_shortcut'))
```

A Telegram bot doesn't fit any of these values. The Zod schema in `packages/shared` enforces the same enum.

### What's Needed

**A. Add `'api'` to the `saved_via` enum** (small, do this regardless)

This is a 3-file change:

1. **Migration `0004_add_api_saved_via.sql`:**
   ```sql
   -- D1 doesn't support ALTER CHECK, so we drop and recreate
   -- Actually, D1/SQLite CHECK constraints aren't enforced on existing rows
   -- and can't be altered. The simplest path: the CHECK is advisory in SQLite
   -- and the real enforcement is the Zod schema. Just update the Zod schema.
   ```

   Actually — SQLite doesn't enforce CHECK constraints retroactively, and D1 doesn't support `ALTER TABLE ... DROP CONSTRAINT`. The Zod schema in `packages/shared` is the real gatekeeper. The SQL CHECK is defense-in-depth but can't be altered without recreating the table.

   Pragmatic approach: update only the Zod schema, leave the SQL CHECK (SQLite evaluates CHECK only on INSERT/UPDATE, and new rows will use the Zod-validated value which bypasses the CHECK issue — **actually no, the CHECK will reject the INSERT**).

   Correct approach: migration that recreates the bookmarks table without the CHECK, or with an updated CHECK. For D1/SQLite:

   ```sql
   -- 0004_add_api_saved_via.sql
   PRAGMA foreign_keys = OFF;

   CREATE TABLE bookmarks_new (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     url TEXT NOT NULL,
     normalized_url TEXT NOT NULL,
     title TEXT NOT NULL,
     title_source TEXT NOT NULL,
     image_url TEXT,
     site_name TEXT,
     saved_via TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     FOREIGN KEY (user_id) REFERENCES users(id),
     UNIQUE(user_id, normalized_url),
     CHECK (title_source IN ('fallback', 'client', 'user')),
     CHECK (saved_via IN ('web', 'mobile_web', 'extension', 'ios_shortcut', 'api'))
   );

   INSERT INTO bookmarks_new SELECT * FROM bookmarks;
   DROP TABLE bookmarks;
   ALTER TABLE bookmarks_new RENAME TO bookmarks;

   CREATE INDEX idx_bookmarks_user_created ON bookmarks(user_id, created_at DESC);
   CREATE INDEX idx_bookmarks_user_normalized_url ON bookmarks(user_id, normalized_url);

   PRAGMA foreign_keys = ON;
   ```

2. **`packages/shared/src/index.ts`** — add `'api'` to `savedViaSchema`

3. **`apps/web/src/App.tsx`** — display label for the new `api` source (e.g., show "API" in the meta row)

**B. Document the Telegram bot setup**

The bot itself lives **outside this repo** — it's a separate small program that:

1. Listens for Telegram messages containing URLs
2. Calls `POST /v1/bookmarks` with the user's bearer token
3. Replies with a confirmation

The setup flow for the user:

1. Log into url-keep web app
2. Go to Settings > Tokens, create a new token named "Telegram Bot"
3. Copy the token (shown once)
4. Deploy the Telegram bot (separate repo/script) with the token + API origin
5. Send URLs to the bot on Telegram

A minimal Telegram bot is ~50 lines of code (Node.js or Python). We could ship an `examples/telegram-bot/` directory with a ready-to-deploy script, or just document the API contract.

**C. Example bot script (optional, for the repo)**

```
examples/
  telegram-bot/
    index.ts       (~50 LOC, uses grammy or node-telegram-bot-api)
    README.md      (setup instructions)
    wrangler.toml  (if deploying as a CF Worker)
```

### Summary

| Item | Exists today? | Work needed |
|---|---|---|
| Bearer token auth for API | Yes | None |
| Named token creation | Yes | None |
| `POST /v1/bookmarks` endpoint | Yes | None |
| `saved_via: 'api'` value | No | Migration + schema update (3 files) |
| Telegram bot code | No | ~50 LOC example script (optional) |
| Bot setup documentation | No | README in examples/ |

**The API is 95% ready.** The only required change is adding `'api'` to the `saved_via` enum. Everything else is documentation and an optional example bot.

---

## Priority Order

1. **`saved_via: 'api'`** — tiny change, unblocks Telegram and any future integration
2. **Setup script** — biggest quality-of-life improvement for open-source users
3. **Admin-managed multi-user** — enables sharing the instance with others
4. **Example Telegram bot** — nice-to-have, the API docs might be enough

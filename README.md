# zotero-notion-sync

One-way incremental sync from a Zotero library into a Notion database, running on GitHub Actions.
No npm dependencies — Node 20+ built-in `fetch` only, ESM.

## How it works

1. `GET https://api.zotero.org/users/{id}/items/top` with the `since` cursor from `sync-state.json`
   (Zotero API v3). Attachments, notes and annotations are filtered out.
2. The database's first data source is resolved via `GET /v1/databases/{id}`, then the whole data
   source is queried once and indexed by **Zotero Item Key** — no per-item lookups.
3. Each item is created (`POST /v1/pages`) or updated (`PATCH /v1/pages/{id}`) by that key.
4. On a fully clean run the Zotero `Last-Modified-Version` is written to `sync-state.json` and
   committed back to this repo. Runner filesystems are discarded between runs, so the committed
   file is the only thing that carries the cursor forward.

The Notion API version is pinned to **2025-09-03**, which moved query and schema operations from
`/v1/databases/{id}` to `/v1/data_sources/{id}` and changed the page `parent` from `database_id` to
`data_source_id`. The deprecated `2022-06-28` version is not used.

## Notion database schema

| Property | Type | Written by the sync |
| --- | --- | --- |
| `標題` | title | yes |
| `作者` | rich_text | yes |
| `年份` | number | yes (`null` when the item has no year) |
| `期刊/會議名` | rich_text | yes |
| `DOI URL` | url | yes |
| `Zotero Link` | url | yes |
| `Zotero Item Key` | rich_text | yes — the dedup key |
| `Status` | status | **only at page creation**, set to `To Read` |
| `This week` | checkbox | **never** |
| `Summary checklist` | checkbox | **never** |

`Status` options: `To Read` / `Reading` / `Annotated` / `Summarized`.

The last three properties are hand-maintained reading progress that has no Zotero equivalent. Update
payloads never include them, so a sync can never reset your progress. This is enforced by tests
(`test/sync.test.js`).

## Setup

Repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `ZOTERO_API_KEY` | from <https://www.zotero.org/settings/keys> |
| `ZOTERO_USER_ID` | the **numeric** user ID on the same page (not your username) |
| `NOTION_TOKEN` | internal integration token |
| `NOTION_DATABASE_URL` | the full database URL; the 32-hex id is parsed out of it |

Then, in Notion, open the database → `⋯` (top right) → **Connections** → add your integration.
Without this the API returns `object_not_found` even though the token is valid.

## Running locally

```bash
export ZOTERO_API_KEY=... ZOTERO_USER_ID=... NOTION_TOKEN=... NOTION_DATABASE_URL=...
node src/sync.js              # incremental, using sync-state.json
node src/sync.js --full       # ignore state, re-read the whole library
node src/sync.js --dry-run    # report changes, write nothing
npm test                      # mocked-fetch test suite, no network
```

## Running it (manual only)

There is **no schedule** — the workflow runs only when you start it, so it never fires on its own
and never sends unprompted notifications. Start it from the **Actions** tab → *Zotero → Notion
Sync* → **Run workflow**; the `full` and `dry_run` inputs are on that form. You can also run it
locally with the commands above.

The workflow still declares `permissions: contents: write` (to commit `sync-state.json`) and a
`concurrency` group so two manual runs cannot race on it. The commit step stages only
`sync-state.json`.

Because the state file is committed, manual runs stay incremental: whenever you run it, it picks up
from wherever the last run stopped, however long ago that was. To re-schedule it later, add a
`schedule:` trigger back to `.github/workflows/sync.yml` — note that Actions silently ignores crons
shorter than 5 minutes, and the top of the hour is the most congested slot:

```yaml
on:
  schedule:
    - cron: "7,22,37,52 * * * *"
  workflow_dispatch:
```

## Limitations

- **Deletions are not propagated.** An item deleted in Zotero stays in Notion; remove it there by
  hand.
- Rate limiting is handled by throttling to ~3 requests/second and retrying `429` after
  `Retry-After`, but a very large first `--full` run will simply take a while.
- If any item fails, the state version is not advanced — the next run retries the same batch.

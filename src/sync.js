import { fetchTopItems } from "./zotero.js";
import { NotionClient, parseDatabaseId, PROTECTED_PROPS } from "./notion.js";
import { readState, writeState, STATE_FILE } from "./state.js";

const REQUIRED_ENV = ["ZOTERO_API_KEY", "ZOTERO_USER_ID", "NOTION_TOKEN", "NOTION_DATABASE_URL"];

export function parseArgs(argv = []) {
  const flags = { full: false, dryRun: false };
  for (const arg of argv) {
    if (arg === "--full") flags.full = true;
    else if (arg === "--dry-run" || arg === "--dry") flags.dryRun = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return flags;
}

function usage() {
  console.log(`Usage: node src/sync.js [--full] [--dry-run]

  --full      ignore ${STATE_FILE} and re-read the entire Zotero library
  --dry-run   report what would change without writing to Notion or ${STATE_FILE}
`);
}

function requireEnv(env) {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing env var(s): ${missing.join(", ")}`);
  }
}

export async function runSync({
  env = process.env,
  argv = [],
  fetchImpl = fetch,
  throttleMs = 350,
  statePath,
} = {}) {
  const flags = parseArgs(argv);
  if (flags.help) {
    usage();
    return { ok: true, created: 0, updated: 0, failed: 0 };
  }

  requireEnv(env);

  const state = flags.full ? { version: null } : readState(statePath);
  const since = flags.full ? null : state.version;

  console.log(
    `[sync] mode=${flags.full ? "full" : "incremental"}${flags.dryRun ? " (dry-run)" : ""}` +
      ` since=${since ?? "<none>"}`,
  );

  const { records, libraryVersion, rawCount } = await fetchTopItems({
    userId: env.ZOTERO_USER_ID,
    apiKey: env.ZOTERO_API_KEY,
    since,
    fetchImpl,
  });

  console.log(
    `[zotero] ${rawCount} top-level item(s) returned, ${records.length} syncable after filtering ` +
      `attachments/notes/annotations; library version ${libraryVersion ?? "<unknown>"}`,
  );

  const notion = new NotionClient({ token: env.NOTION_TOKEN, fetchImpl, throttleMs });
  const databaseId = parseDatabaseId(env.NOTION_DATABASE_URL);
  const dataSourceId = await notion.getDataSourceId(databaseId);
  const index = await notion.buildKeyIndex(dataSourceId);

  console.log(`[notion] data source ${dataSourceId}; ${index.size} existing page(s) indexed by Zotero Item Key`);
  console.log(`[notion] never written on update: ${PROTECTED_PROPS.join(", ")}`);

  let created = 0;
  let updated = 0;
  const failures = [];

  for (const record of records) {
    const pageId = index.get(record.key);
    const action = pageId ? "update" : "create";

    if (flags.dryRun) {
      console.log(`[dry-run] ${action} ${record.key} — ${record.title}`);
      if (action === "create") created += 1;
      else updated += 1;
      continue;
    }

    try {
      if (pageId) {
        await notion.updatePage(pageId, record);
        updated += 1;
      } else {
        const page = await notion.createPage(dataSourceId, record);
        index.set(record.key, page.id);
        created += 1;
      }
      console.log(`[notion] ${action}d ${record.key} — ${record.title}`);
    } catch (err) {
      failures.push({ key: record.key, title: record.title, message: err.message });
      console.error(`[notion] FAILED to ${action} ${record.key} — ${record.title}: ${err.message}`);
    }
  }

  const ok = failures.length === 0;

  // The version only moves forward on a clean run; otherwise the next run
  // re-reads the same batch and retries whatever failed.
  if (ok && !flags.dryRun && libraryVersion != null) {
    writeState(
      { version: libraryVersion, lastSync: new Date().toISOString(), lastSyncedCount: records.length },
      statePath,
    );
    console.log(`[state] advanced to library version ${libraryVersion}`);
  } else if (!ok) {
    console.error(`[state] NOT advanced — ${failures.length} item(s) failed; they will be retried next run.`);
  } else if (flags.dryRun) {
    console.log(`[state] not written (dry-run)`);
  }

  console.log(`[sync] done: ${created} created, ${updated} updated, ${failures.length} failed`);
  return { ok, created, updated, failed: failures.length, failures, libraryVersion };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runSync({ argv: process.argv.slice(2) })
    .then((result) => {
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((err) => {
      console.error(`[sync] fatal: ${err.message}`);
      process.exitCode = 1;
    });
}

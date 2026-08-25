console.log("Sync job started.");

const required = ["ZOTERO_API_KEY", "ZOTERO_USER_ID", "NOTION_TOKEN", "NOTION_DATABASE_URL"];
for (const k of required) {
  if (!process.env[k]) {
    throw new Error(`Missing env var: ${k}`);
  }
}

console.log("All env vars present. Next: implement Zotero→Notion sync logic.");
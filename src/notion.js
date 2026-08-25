const NOTION_API_BASE = "https://api.notion.com/v1";

/**
 * 2025-09-03 moved query/schema operations from /v1/databases/{id} to
 * /v1/data_sources/{id}, and page creation now parents to a data_source_id.
 */
export const NOTION_VERSION = "2025-09-03";

export const PROP = {
  title: "標題",
  creators: "作者",
  year: "年份",
  publication: "期刊/會議名",
  doi: "DOI URL",
  zoteroLink: "Zotero Link",
  itemKey: "Zotero Item Key",
  status: "Status",
};

/**
 * Hand-maintained reading progress. Zotero has no equivalent data, so the sync
 * must never include these in an update payload or it would wipe the user's
 * progress on every run. `Status` is write-once, at page creation only.
 */
export const PROTECTED_PROPS = Object.freeze(["Status", "This week", "Summary checklist"]);

export const INITIAL_STATUS = "To Read";

const CONNECTION_HINT =
  "Notion returned object_not_found. The integration almost certainly has not been added to the " +
  "database: open the database in Notion, click ⋯ (top right) → Connections → add your integration. " +
  "(Also confirm NOTION_DATABASE_URL points at the right database.)";

/** Notion URLs carry the database id first and the view id (`?v=`) second. */
export function parseDatabaseId(databaseUrl) {
  if (!databaseUrl) throw new Error("NOTION_DATABASE_URL is empty.");
  const match = String(databaseUrl).match(
    /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i,
  );
  if (!match) {
    throw new Error(
      `Could not find a 32-character database id in NOTION_DATABASE_URL: ${databaseUrl}`,
    );
  }
  return match[0].replace(/-/g, "").toLowerCase();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function text(content, limit = 2000) {
  const value = String(content ?? "");
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function richText(content) {
  const value = text(content);
  return value ? [{ type: "text", text: { content: value } }] : [];
}

/**
 * Builds the Notion property payload for one Zotero record.
 * `forCreate` is the only path that may set Status.
 */
export function buildProperties(record, { forCreate = false } = {}) {
  const properties = {
    [PROP.title]: { title: richText(record.title) },
    [PROP.creators]: { rich_text: richText(record.creators) },
    // number must be null when unknown — an empty string is rejected by the API
    [PROP.year]: { number: Number.isInteger(record.year) ? record.year : null },
    [PROP.publication]: { rich_text: richText(record.publication) },
    [PROP.doi]: { url: record.doiUrl || null },
    [PROP.zoteroLink]: { url: record.zoteroUrl || null },
    [PROP.itemKey]: { rich_text: richText(record.key) },
  };

  if (forCreate) {
    properties[PROP.status] = { status: { name: INITIAL_STATUS } };
  }
  return properties;
}

export class NotionClient {
  #token;
  #fetch;
  #throttleMs;
  #maxRetries;
  #queue = Promise.resolve();
  #lastRequestAt = 0;

  constructor({ token, fetchImpl = fetch, throttleMs = 350, maxRetries = 5 } = {}) {
    if (!token) throw new Error("NOTION_TOKEN is required.");
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#throttleMs = throttleMs;
    this.#maxRetries = maxRetries;
  }

  /** Serializes requests and keeps ~3 req/s (Notion's documented rate limit). */
  #schedule(task) {
    const run = this.#queue.then(async () => {
      const wait = this.#throttleMs - (Date.now() - this.#lastRequestAt);
      if (wait > 0) await sleep(wait);
      this.#lastRequestAt = Date.now();
      return task();
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async request(method, path, body) {
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.#schedule(() =>
        this.#fetch(`${NOTION_API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.#token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );

      if (res.status === 429 && attempt < this.#maxRetries) {
        const retryAfter = Number(res.headers?.get?.("Retry-After"));
        const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1) * 1000;
        console.warn(`[notion] rate limited, retrying in ${waitMs}ms (attempt ${attempt + 1})`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const raw = await res.text().catch(() => "");
        let payload = {};
        try {
          payload = JSON.parse(raw);
        } catch {
          /* keep raw text */
        }
        if (payload.code === "object_not_found" || res.status === 404) {
          throw new Error(`${CONNECTION_HINT}\n  ${method} ${path} → ${raw.slice(0, 300)}`);
        }
        if (res.status === 401) {
          throw new Error(`Notion returned 401: NOTION_TOKEN is invalid or revoked.`);
        }
        throw new Error(`Notion ${method} ${path} failed (${res.status}): ${raw.slice(0, 500)}`);
      }

      return res.json();
    }
  }

  /** 2025-09-03: a database is a container; queries target its data source. */
  async getDataSourceId(databaseId) {
    const db = await this.request("GET", `/databases/${databaseId}`);
    const dataSourceId = db?.data_sources?.[0]?.id;
    if (!dataSourceId) {
      throw new Error(
        `Database ${databaseId} reported no data sources. Confirm NOTION_DATABASE_URL points at a ` +
          `database (not a page) and that the integration can see it.`,
      );
    }
    return dataSourceId;
  }

  /**
   * Pulls the whole data source once and indexes it by Zotero Item Key, so the
   * sync never issues a per-item query.
   */
  async buildKeyIndex(dataSourceId) {
    const index = new Map();
    let cursor;

    do {
      const page = await this.request("POST", `/data_sources/${dataSourceId}/query`, {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });

      for (const result of page.results ?? []) {
        const key = result?.properties?.[PROP.itemKey]?.rich_text?.[0]?.plain_text?.trim();
        if (key && !index.has(key)) index.set(key, result.id);
      }

      cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor);

    return index;
  }

  createPage(dataSourceId, record) {
    return this.request("POST", "/pages", {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: buildProperties(record, { forCreate: true }),
    });
  }

  updatePage(pageId, record) {
    return this.request("PATCH", `/pages/${pageId}`, {
      properties: buildProperties(record, { forCreate: false }),
    });
  }
}

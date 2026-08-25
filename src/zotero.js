const ZOTERO_API_BASE = "https://api.zotero.org";
const PAGE_SIZE = 100;

/** Item types that are children of a real reference, never a reference themselves. */
export const EXCLUDED_ITEM_TYPES = new Set(["attachment", "note", "annotation"]);

/** Han, kana and halfwidth kana — names in these scripts are written without a comma. */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;

/**
 * Zotero creators come in two shapes:
 *   { creatorType, firstName, lastName }  and  { creatorType, name }
 * The single-field form is common for Japanese/Chinese names imported from
 * 和文誌 databases, and is used verbatim.
 */
export function formatCreator(creator) {
  if (!creator) return "";

  if (creator.name != null && String(creator.name).trim()) {
    return String(creator.name).trim();
  }

  const first = String(creator.firstName ?? "").trim();
  const last = String(creator.lastName ?? "").trim();
  if (!first) return last;
  if (!last) return first;

  // 松本 + 芳之 -> 松本芳之 ; Ozlem + Ayduk -> Ayduk, Ozlem
  if (CJK_RE.test(first) || CJK_RE.test(last)) return `${last}${first}`;
  return `${last}, ${first}`;
}

/** Authors if there are any, otherwise whatever creators exist (editors, etc.). */
export function formatCreators(creators) {
  if (!Array.isArray(creators) || creators.length === 0) return "";
  const authors = creators.filter((c) => c && c.creatorType === "author");
  const source = authors.length > 0 ? authors : creators;
  return source.map(formatCreator).filter(Boolean).join("; ");
}

/**
 * Zotero's `date` is free text: "2002", "2010-05", "May 2010", "2013-06-01".
 * Pull the first plausible 4-digit year out of it.
 */
export function parseYear(date) {
  if (date == null) return null;
  const match = String(date).match(/(1[0-9]{3}|2[0-9]{3})/);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isInteger(year) ? year : null;
}

function normalizeDoi(raw) {
  if (!raw) return "";
  return String(raw)
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[.,;)\]]+$/, "")
    .trim();
}

/**
 * DOIs live in `data.DOI` for most item types, but imports (and item types like
 * conferencePaper, which has no DOI field) stash them in `data.extra` instead.
 */
export function extractDoi(data = {}) {
  const direct = normalizeDoi(data.DOI);
  if (direct) return direct;

  const extra = String(data.extra ?? "");
  if (!extra) return "";

  const labeled = extra.match(/^[ \t]*DOI[ \t]*:[ \t]*(\S+)/im);
  if (labeled) return normalizeDoi(labeled[1]);

  const bare = extra.match(/\b(10\.\d{4,9}\/\S+)/);
  if (bare) return normalizeDoi(bare[1]);

  return "";
}

export function extractPublication(data = {}) {
  for (const field of ["publicationTitle", "proceedingsTitle", "conferenceName", "bookTitle", "publisher"]) {
    const value = String(data[field] ?? "").trim();
    if (value) return value;
  }
  return "";
}

export function isSyncableItem(item) {
  const type = item?.data?.itemType;
  if (!type) return false;
  if (EXCLUDED_ITEM_TYPES.has(type)) return false;
  if (item.data.deleted) return false;
  return true;
}

/** Flattens a raw Zotero item into the shape the Notion mapper expects. */
export function mapItem(item, userId) {
  const data = item?.data ?? {};
  const doi = extractDoi(data);
  const zoteroUrl =
    item?.links?.alternate?.href ||
    (userId ? `https://www.zotero.org/users/${userId}/items/${data.key}` : "");

  return {
    key: data.key,
    version: item.version ?? data.version ?? null,
    itemType: data.itemType,
    title: String(data.title ?? "").trim() || "(untitled)",
    creators: formatCreators(data.creators),
    year: parseYear(data.date),
    publication: extractPublication(data),
    doiUrl: doi ? `https://doi.org/${doi}` : "",
    zoteroUrl,
  };
}

function zoteroError(status, body) {
  if (status === 403) {
    return new Error(
      "Zotero API returned 403: the API key is invalid or lacks read access to this library. " +
        "Check ZOTERO_API_KEY at https://www.zotero.org/settings/keys",
    );
  }
  if (status === 404) {
    return new Error(
      "Zotero API returned 404: ZOTERO_USER_ID looks wrong. It must be the numeric user ID " +
        "from https://www.zotero.org/settings/keys (e.g. 1234567), not your username.",
    );
  }
  return new Error(`Zotero API returned ${status}: ${String(body).slice(0, 300)}`);
}

/**
 * Fetches every top-level item, paging through the library.
 *
 * `since` is the library version stored by the previous run; the response's
 * `Last-Modified-Version` header is what the next run should pass back in.
 */
export async function fetchTopItems({
  userId,
  apiKey,
  since = null,
  fetchImpl = fetch,
  pageSize = PAGE_SIZE,
} = {}) {
  const items = [];
  let libraryVersion = since == null ? null : String(since);
  let start = 0;

  for (;;) {
    const url = new URL(`${ZOTERO_API_BASE}/users/${userId}/items/top`);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("start", String(start));
    if (since != null && since !== "") url.searchParams.set("since", String(since));

    const res = await fetchImpl(url.toString(), {
      headers: {
        "Zotero-API-Version": "3",
        "Zotero-API-Key": apiKey,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw zoteroError(res.status, body);
    }

    const header = res.headers?.get?.("Last-Modified-Version");
    if (header) {
      const current = Number(header);
      const known = Number(libraryVersion);
      if (!Number.isFinite(known) || (Number.isFinite(current) && current > known)) {
        libraryVersion = String(header);
      }
    }

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    items.push(...batch);
    if (batch.length < pageSize) break;
    start += batch.length;
  }

  const records = items.filter(isSyncableItem).map((item) => mapItem(item, userId));
  return { records, libraryVersion, rawCount: items.length };
}

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const raw = JSON.stringify(body);
  const lookup = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lookup.get(String(name).toLowerCase()) ?? null },
    json: async () => JSON.parse(raw),
    text: async () => raw,
  };
}

/**
 * A fetch stand-in that serves both api.zotero.org and api.notion.com and
 * records every call, so tests can assert on exact request payloads.
 */
export function makeFetch({
  zoteroItems = [],
  zoteroVersion = "500",
  notionPages = [],
  dataSourceId = "ds_test_1",
  failCreate = false,
} = {}) {
  const calls = [];

  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, headers: init.headers ?? {}, body });

    if (url.startsWith("https://api.zotero.org/")) {
      const start = Number(new URL(url).searchParams.get("start") ?? "0");
      const page = start === 0 ? zoteroItems : [];
      return jsonResponse(page, { headers: { "Last-Modified-Version": zoteroVersion } });
    }

    const path = url.replace("https://api.notion.com/v1", "");

    if (method === "GET" && path.startsWith("/databases/")) {
      return jsonResponse({ object: "database", data_sources: [{ id: dataSourceId, name: "Papers" }] });
    }
    if (method === "POST" && path === `/data_sources/${dataSourceId}/query`) {
      return jsonResponse({ results: notionPages, has_more: false, next_cursor: null });
    }
    if (method === "POST" && path === "/pages") {
      if (failCreate) {
        return jsonResponse({ code: "validation_error", message: "nope" }, { status: 400 });
      }
      return jsonResponse({ id: `page_${calls.length}` });
    }
    if (method === "PATCH" && path.startsWith("/pages/")) {
      return jsonResponse({ id: path.slice("/pages/".length) });
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  };

  return { calls, fetchImpl };
}

export function zoteroItem(data, { version = 500, key = data.key } = {}) {
  return {
    key,
    version,
    library: { type: "user", id: 1234567 },
    links: { alternate: { href: `https://www.zotero.org/users/1234567/items/${key}` } },
    data: { key, version, ...data },
  };
}

export function notionPage(id, itemKey) {
  return {
    object: "page",
    id,
    properties: {
      "Zotero Item Key": { type: "rich_text", rich_text: [{ plain_text: itemKey }] },
    },
  };
}

export const ENV = {
  ZOTERO_API_KEY: "zkey",
  ZOTERO_USER_ID: "1234567",
  NOTION_TOKEN: "ntn_test",
  NOTION_DATABASE_URL: "https://www.notion.so/me/24f1a2b3c4d5467890abcdef12345678?v=99f1a2b3c4d5467890abcdef12345678",
};

/** Silences the sync's own logging so test output stays clean. */
export async function quiet(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, original);
  }
}

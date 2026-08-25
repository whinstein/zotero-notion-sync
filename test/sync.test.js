import test from "node:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import {
  formatCreator,
  formatCreators,
  parseYear,
  extractDoi,
  extractPublication,
  fetchTopItems,
} from "../src/zotero.js";
import { buildProperties, parseDatabaseId, PROP, PROTECTED_PROPS } from "../src/notion.js";
import { runSync } from "../src/sync.js";
import { makeFetch, zoteroItem, notionPage, quiet, ENV } from "./helpers.js";

/** Keeps sync-state.json writes out of the repo during tests. */
const tempStatePath = () => path.join(mkdtempSync(path.join(tmpdir(), "zns-")), "sync-state.json");

test("creators: both Zotero shapes are handled", () => {
  // { creatorType, firstName, lastName } — western name, comma form
  assert.equal(formatCreator({ creatorType: "author", firstName: "Ozlem", lastName: "Ayduk" }), "Ayduk, Ozlem");

  // { creatorType, name } — single-field form, used verbatim
  assert.equal(formatCreator({ creatorType: "author", name: "松本芳之" }), "松本芳之");

  // CJK in the two-field form joins without a comma
  assert.equal(formatCreator({ creatorType: "author", firstName: "芳之", lastName: "松本" }), "松本芳之");
  assert.equal(formatCreator({ creatorType: "author", firstName: "曉明", lastName: "陳" }), "陳曉明");

  // partial names do not leave stray punctuation
  assert.equal(formatCreator({ creatorType: "author", lastName: "Mischel" }), "Mischel");
  assert.equal(formatCreator({ creatorType: "author", firstName: "Walter", lastName: "" }), "Walter");

  // mixed list, authors preferred over other creator types
  assert.equal(
    formatCreators([
      { creatorType: "author", firstName: "Ozlem", lastName: "Ayduk" },
      { creatorType: "author", name: "松本芳之" },
      { creatorType: "editor", firstName: "Someone", lastName: "Else" },
    ]),
    "Ayduk, Ozlem; 松本芳之",
  );

  assert.equal(formatCreators([]), "");
  assert.equal(formatCreators(undefined), "");
});

test("year: 4-digit year is pulled out of Zotero's messy date field", () => {
  assert.equal(parseYear("2002"), 2002);
  assert.equal(parseYear("2010-05"), 2010);
  assert.equal(parseYear("May 2010"), 2010);
  assert.equal(parseYear("2013-06-01"), 2013);
  assert.equal(parseYear("1999/12/31"), 1999);
  assert.equal(parseYear("n.d."), null);
  assert.equal(parseYear(""), null);
  assert.equal(parseYear(undefined), null);
});

test("DOI: found in data.DOI or dug out of data.extra", () => {
  assert.equal(extractDoi({ DOI: "10.1037/0022-3514.83.4.817" }), "10.1037/0022-3514.83.4.817");

  // 和文誌 imports park the DOI in `extra`
  assert.equal(
    extractDoi({ DOI: "", extra: "DOI: 10.4992/jjpsy.85.13048" }),
    "10.4992/jjpsy.85.13048",
  );
  assert.equal(
    extractDoi({ extra: "Original Title: 対人関係\nDOI: 10.5926/jjep.61.155\nPMID: 123" }),
    "10.5926/jjep.61.155",
  );
  // bare DOI with no label
  assert.equal(extractDoi({ extra: "see 10.1093/scan/nsw042 for details" }), "10.1093/scan/nsw042");
  // prefixed forms are normalized to the bare DOI
  assert.equal(extractDoi({ DOI: "https://doi.org/10.1234/abc" }), "10.1234/abc");
  assert.equal(extractDoi({ DOI: "doi:10.1234/abc" }), "10.1234/abc");
  assert.equal(extractDoi({ extra: "Original Title: foo" }), "");
  assert.equal(extractDoi({}), "");
});

test("publication name falls back through the Zotero field chain", () => {
  assert.equal(extractPublication({ publicationTitle: "JPSP", proceedingsTitle: "X" }), "JPSP");
  assert.equal(extractPublication({ proceedingsTitle: "CHI '21" }), "CHI '21");
  assert.equal(extractPublication({ conferenceName: "CogSci" }), "CogSci");
  assert.equal(extractPublication({ bookTitle: "Handbook of SR" }), "Handbook of SR");
  assert.equal(extractPublication({ publisher: "Iwanami" }), "Iwanami");
  assert.equal(extractPublication({}), "");
});

test("itemType filter drops attachments, notes and annotations", async () => {
  const { fetchImpl } = makeFetch({
    zoteroItems: [
      zoteroItem({ key: "AAA1", itemType: "journalArticle", title: "Keep me", date: "2002" }),
      zoteroItem({ key: "BBB2", itemType: "attachment", title: "Full Text PDF" }),
      zoteroItem({ key: "CCC3", itemType: "note", title: "a note" }),
      zoteroItem({ key: "DDD4", itemType: "annotation", title: "a highlight" }),
      zoteroItem({ key: "EEE5", itemType: "conferencePaper", title: "Keep me too", date: "May 2010" }),
    ],
    zoteroVersion: "812",
  });

  const { records, libraryVersion, rawCount } = await fetchTopItems({
    userId: "1234567",
    apiKey: "zkey",
    fetchImpl,
  });

  assert.equal(rawCount, 5);
  assert.deepEqual(records.map((r) => r.key), ["AAA1", "EEE5"]);
  assert.equal(libraryVersion, "812");
});

test("Zotero request carries the v3 headers and the `since` cursor", async () => {
  const { calls, fetchImpl } = makeFetch({ zoteroItems: [] });
  await fetchTopItems({ userId: "1234567", apiKey: "zkey", since: "770", fetchImpl });

  const [call] = calls;
  assert.equal(call.headers["Zotero-API-Version"], "3");
  assert.equal(call.headers["Zotero-API-Key"], "zkey");
  const url = new URL(call.url);
  assert.equal(url.pathname, "/users/1234567/items/top");
  assert.equal(url.searchParams.get("since"), "770");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(url.searchParams.get("format"), "json");
});

test("update payload never touches Status / This week / Summary checklist", () => {
  const record = {
    key: "AAA1",
    title: "Self-regulation",
    creators: "Ayduk, Ozlem",
    year: 2002,
    publication: "JPSP",
    doiUrl: "https://doi.org/10.1037/x",
    zoteroUrl: "https://www.zotero.org/users/1234567/items/AAA1",
  };

  const update = buildProperties(record, { forCreate: false });
  for (const prop of PROTECTED_PROPS) {
    assert.equal(prop in update, false, `${prop} must not appear in an update payload`);
  }
  assert.deepEqual(Object.keys(update).sort(), [
    "DOI URL",
    "Zotero Item Key",
    "Zotero Link",
    "作者",
    "年份",
    "期刊/會議名",
    "標題",
  ].sort());

  const create = buildProperties(record, { forCreate: true });
  assert.deepEqual(create[PROP.status], { status: { name: "To Read" } });
  // even at creation, the two hand-maintained checkboxes are left alone
  assert.equal("This week" in create, false);
  assert.equal("Summary checklist" in create, false);
});

test("missing year is sent as null, not an empty string", () => {
  const props = buildProperties({ key: "K", title: "T", creators: "", year: null, publication: "", doiUrl: "", zoteroUrl: "" });
  assert.deepEqual(props[PROP.year], { number: null });
  assert.deepEqual(props[PROP.doi], { url: null });
  assert.deepEqual(props[PROP.publication], { rich_text: [] });
});

test("database id is parsed out of the URL, view id ignored", () => {
  assert.equal(
    parseDatabaseId("https://www.notion.so/me/24f1a2b3c4d5467890abcdef12345678?v=99f1a2b3c4d5467890abcdef12345678"),
    "24f1a2b3c4d5467890abcdef12345678",
  );
  assert.equal(
    parseDatabaseId("https://www.notion.so/Papers-24f1a2b3-c4d5-4678-90ab-cdef12345678?v=abcdef1234567890abcdef1234567890&pvs=4"),
    "24f1a2b3c4d5467890abcdef12345678",
  );
  assert.throws(() => parseDatabaseId("https://www.notion.so/Papers"), /32-character database id/);
});

test("create parents to data_source_id and uses the 2025-09-03 endpoints", async () => {
  const statePath = tempStatePath();
  const { calls, fetchImpl } = makeFetch({
    zoteroItems: [
      zoteroItem({
        key: "AAA1",
        itemType: "journalArticle",
        title: "Delay of gratification",
        date: "2002-04",
        publicationTitle: "JPSP",
        extra: "DOI: 10.1037/0022-3514.83.4.817",
        creators: [
          { creatorType: "author", firstName: "Ozlem", lastName: "Ayduk" },
          { creatorType: "author", name: "松本芳之" },
        ],
      }),
    ],
    notionPages: [],
  });

  const result = await quiet(() => runSync({ env: ENV, argv: [], fetchImpl, throttleMs: 0, statePath }));
  assert.equal(result.ok, true);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);

  const dbCall = calls.find((c) => c.url.includes("/v1/databases/"));
  assert.equal(dbCall.url, "https://api.notion.com/v1/databases/24f1a2b3c4d5467890abcdef12345678");
  assert.equal(dbCall.headers["Notion-Version"], "2025-09-03");

  const queryCall = calls.find((c) => c.url.includes("/data_sources/"));
  assert.equal(queryCall.url, "https://api.notion.com/v1/data_sources/ds_test_1/query");

  const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/pages"));
  assert.deepEqual(createCall.body.parent, { type: "data_source_id", data_source_id: "ds_test_1" });
  assert.equal("database_id" in createCall.body.parent, false);

  const props = createCall.body.properties;
  assert.equal(props["標題"].title[0].text.content, "Delay of gratification");
  assert.equal(props["作者"].rich_text[0].text.content, "Ayduk, Ozlem; 松本芳之");
  assert.deepEqual(props["年份"], { number: 2002 });
  assert.equal(props["期刊/會議名"].rich_text[0].text.content, "JPSP");
  assert.equal(props["DOI URL"].url, "https://doi.org/10.1037/0022-3514.83.4.817");
  assert.equal(props["Zotero Link"].url, "https://www.zotero.org/users/1234567/items/AAA1");
  assert.equal(props["Zotero Item Key"].rich_text[0].text.content, "AAA1");
  assert.deepEqual(props["Status"], { status: { name: "To Read" } });

  // clean run -> the library version is persisted for the next run
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).version, "500");
});

test("existing item is PATCHed by key, with no Status in the payload", async () => {
  const statePath = tempStatePath();
  const { calls, fetchImpl } = makeFetch({
    zoteroItems: [
      zoteroItem({ key: "AAA1", itemType: "journalArticle", title: "Updated title", date: "2002" }),
    ],
    notionPages: [notionPage("page_existing", "AAA1")],
  });

  const result = await quiet(() => runSync({ env: ENV, argv: [], fetchImpl, throttleMs: 0, statePath }));
  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);

  assert.equal(calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/pages")), false);
  const patch = calls.find((c) => c.method === "PATCH");
  assert.equal(patch.url, "https://api.notion.com/v1/pages/page_existing");
  assert.equal("parent" in patch.body, false);
  for (const prop of PROTECTED_PROPS) {
    assert.equal(prop in patch.body.properties, false, `${prop} must not be written on update`);
  }
  assert.equal(patch.body.properties["標題"].title[0].text.content, "Updated title");
});

test("--dry-run writes nothing", async () => {
  const statePath = tempStatePath();
  const { calls, fetchImpl } = makeFetch({
    zoteroItems: [zoteroItem({ key: "AAA1", itemType: "journalArticle", title: "T", date: "2002" })],
  });

  const result = await quiet(() => runSync({ env: ENV, argv: ["--dry-run"], fetchImpl, throttleMs: 0, statePath }));
  assert.equal(result.created, 1);
  assert.equal(calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/pages")), false);
  assert.equal(calls.some((c) => c.method === "PATCH"), false);
  assert.equal(existsSync(statePath), false, "dry-run must not write sync-state.json");
});

test("a failed item stops the state version from advancing", async () => {
  const statePath = tempStatePath();
  const { fetchImpl } = makeFetch({
    zoteroItems: [zoteroItem({ key: "AAA1", itemType: "journalArticle", title: "T", date: "2002" })],
    failCreate: true,
  });

  const result = await quiet(() => runSync({ env: ENV, argv: [], fetchImpl, throttleMs: 0, statePath }));
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  // state must stay put so the same batch is retried next run
  assert.equal(existsSync(statePath), false);
});

test("429 is retried after Retry-After", async () => {
  const { NotionClient } = await import("../src/notion.js");
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (h) => (h === "Retry-After" ? "0" : null) },
        json: async () => ({}),
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ data_sources: [{ id: "ds_1" }] }),
      text: async () => "{}",
    };
  };

  const client = new NotionClient({ token: "t", fetchImpl, throttleMs: 0 });
  assert.equal(await client.getDataSourceId("abc"), "ds_1");
  assert.equal(attempts, 2);
});

test("object_not_found points at the Connections fix", async () => {
  const { NotionClient } = await import("../src/notion.js");
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => JSON.stringify({ object: "error", code: "object_not_found", message: "Could not find database" }),
  });

  const client = new NotionClient({ token: "t", fetchImpl, throttleMs: 0 });
  await assert.rejects(() => client.getDataSourceId("abc"), /Connections/);
});

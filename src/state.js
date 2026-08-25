import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STATE_FILE = "sync-state.json";

export const EMPTY_STATE = Object.freeze({
  version: null,
  lastSync: null,
  lastSyncedCount: 0,
});

function resolveStatePath(statePath) {
  return statePath ?? path.resolve(process.cwd(), STATE_FILE);
}

/**
 * Reads sync-state.json. GitHub Actions gives every run a fresh filesystem, so
 * this file is the only thing that carries "where we got to" between runs — it
 * is committed back to the repo by the workflow.
 */
export function readState(statePath) {
  const file = resolveStatePath(statePath);
  if (!existsSync(file)) return { ...EMPTY_STATE };

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      ...EMPTY_STATE,
      ...parsed,
      version: parsed.version == null ? null : String(parsed.version),
    };
  } catch (err) {
    console.warn(`[state] ${STATE_FILE} is unreadable (${err.message}); starting from scratch.`);
    return { ...EMPTY_STATE };
  }
}

export function writeState(state, statePath) {
  const file = resolveStatePath(statePath);
  const next = {
    version: state.version == null ? null : String(state.version),
    lastSync: state.lastSync ?? new Date().toISOString(),
    lastSyncedCount: state.lastSyncedCount ?? 0,
  };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

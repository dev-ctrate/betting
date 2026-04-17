const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "auto_backfill_state.json");

const TARGET_START = process.env.AUTO_BACKFILL_TARGET_START || "2024-10-01";
const BURST_DAYS_PER_RUN = Number(process.env.AUTO_BACKFILL_BURST_DAYS || 7);
const RECENT_REPAIR_DAYS = Number(process.env.AUTO_BACKFILL_RECENT_REPAIR_DAYS || 3);
const NODE_BIN = process.env.AUTO_BACKFILL_NODE_BIN || process.execPath;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJson(filePath, fallback) {
  try {
    ensureDir();
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`readJson failed for ${filePath}:`, err.message);
    return fallback;
  }
}

function writeJson(filePath, value) {
  try {
    ensureDir();
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  } catch (err) {
    console.error(`writeJson failed for ${filePath}:`, err.message);
  }
}

function toYmd(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toYmd(d);
}

function todayYmd() {
  return toYmd(new Date());
}

function yesterdayYmd() {
  return addDays(todayYmd(), -1);
}

function loadState() {
  return readJson(STATE_FILE, {
    oldestBackfilledDate: null,
    lastRunAt: null
  });
}

function saveState(state) {
  writeJson(STATE_FILE, state);
}

function runBackfillForDay(day) {
  console.log(`\n[AUTO] Running backfill for ${day}`);
  execFileSync(NODE_BIN, [path.join(__dirname, "backfill.js"), day, day], {
    stdio: "inherit",
    env: process.env
  });
}

function buildRecentRepairDays() {
  const days = [];
  const yesterday = yesterdayYmd();

  for (let i = 0; i < RECENT_REPAIR_DAYS; i += 1) {
    days.push(addDays(yesterday, -i));
  }

  return [...new Set(days)];
}

function buildOlderBurstDays(state) {
  const burst = [];

  let cursor;
  if (state.oldestBackfilledDate) {
    cursor = addDays(state.oldestBackfilledDate, -1);
  } else {
    cursor = yesterdayYmd();
  }

  for (let i = 0; i < BURST_DAYS_PER_RUN; i += 1) {
    if (cursor < TARGET_START) break;
    burst.push(cursor);
    cursor = addDays(cursor, -1);
  }

  return burst;
}

function uniqueOrderedDays(days) {
  return [...new Set(days)];
}

function main() {
  const state = loadState();

  const recentRepairDays = buildRecentRepairDays();
  const olderBurstDays = buildOlderBurstDays(state);
  const daysToRun = uniqueOrderedDays([...recentRepairDays, ...olderBurstDays]);

  if (!daysToRun.length) {
    console.log("[AUTO] Nothing to backfill.");
    state.lastRunAt = new Date().toISOString();
    saveState(state);
    return;
  }

  console.log("[AUTO] Recent repair days:", recentRepairDays.join(", "));
  console.log("[AUTO] Older burst days:", olderBurstDays.join(", "));

  let oldestProcessed = state.oldestBackfilledDate;

  for (const day of daysToRun) {
    runBackfillForDay(day);

    if (!oldestProcessed || day < oldestProcessed) {
      oldestProcessed = day;
    }
  }

  state.oldestBackfilledDate = oldestProcessed;
  state.lastRunAt = new Date().toISOString();
  saveState(state);

  console.log("\n[AUTO] Done.");
  console.log("[AUTO] oldestBackfilledDate =", state.oldestBackfilledDate);
  console.log("[AUTO] lastRunAt =", state.lastRunAt);
}

main();

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "auto_backfill_state.json");

const TARGET_START = process.env.AUTO_BACKFILL_TARGET_START || "2024-10-01";
const BURST_DAYS_PER_RUN = Number(process.env.AUTO_BACKFILL_BURST_DAYS || 7);
const RECENT_REPAIR_DAYS = Number(process.env.AUTO_BACKFILL_RECENT_REPAIR_DAYS || 3);
const NODE_BIN = process.execPath;
const BACKFILL_PATH = path.join(__dirname, "backfill.js");

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

function isValidYmd(ymd) {
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd);
}

function loadState() {
  return readJson(STATE_FILE, {
    oldestBackfilledDate: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastAttemptedDays: []
  });
}

function saveState(state) {
  writeJson(STATE_FILE, state);
}

function logConfig() {
  console.log("[AUTO] Config");
  console.log("  TARGET_START =", TARGET_START);
  console.log("  BURST_DAYS_PER_RUN =", BURST_DAYS_PER_RUN);
  console.log("  RECENT_REPAIR_DAYS =", RECENT_REPAIR_DAYS);
  console.log("  NODE_BIN =", NODE_BIN);
  console.log("  BACKFILL_PATH =", BACKFILL_PATH);
}

function runBackfillForDay(day) {
  console.log(`\n[AUTO] Running backfill for ${day}`);

  if (!fs.existsSync(BACKFILL_PATH)) {
    throw new Error(`backfill.js not found at ${BACKFILL_PATH}`);
  }

  try {
    const output = execFileSync(
      NODE_BIN,
      [BACKFILL_PATH, day, day],
      {
        cwd: __dirname,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    if (output && output.trim()) {
      console.log("[AUTO] backfill stdout:");
      console.log(output.trim());
    }

    console.log(`[AUTO] Backfill succeeded for ${day}`);
  } catch (err) {
    console.error(`[AUTO] BACKFILL FAILED for ${day}`);
    console.error("[AUTO] message:", err.message);

    if (typeof err.stdout === "string" && err.stdout.trim()) {
      console.error("[AUTO] stdout:");
      console.error(err.stdout.trim());
    }

    if (typeof err.stderr === "string" && err.stderr.trim()) {
      console.error("[AUTO] stderr:");
      console.error(err.stderr.trim());
    }

    if (typeof err.status !== "undefined") {
      console.error("[AUTO] exit status:", err.status);
    }

    throw err;
  }
}

function buildRecentRepairDays() {
  const days = [];
  const yesterday = yesterdayYmd();

  for (let i = 0; i < RECENT_REPAIR_DAYS; i += 1) {
    days.push(addDays(yesterday, -i));
  }

  return days;
}

function buildOlderBurstDays(state) {
  const burst = [];

  let cursor;
  if (state.oldestBackfilledDate && isValidYmd(state.oldestBackfilledDate)) {
    cursor = addDays(state.oldestBackfilledDate, -1);
  } else {
    cursor = addDays(yesterdayYmd(), -RECENT_REPAIR_DAYS);
  }

  for (let i = 0; i < BURST_DAYS_PER_RUN; i += 1) {
    if (cursor < TARGET_START) break;
    burst.push(cursor);
    cursor = addDays(cursor, -1);
  }

  return burst;
}

function uniqueOrderedDays(days) {
  const seen = new Set();
  const out = [];

  for (const day of days) {
    if (!isValidYmd(day)) continue;
    if (seen.has(day)) continue;
    seen.add(day);
    out.push(day);
  }

  return out;
}

function verifyRequiredEnv() {
  const missing = [];

  if (!process.env.ODDS_API_KEY) missing.push("ODDS_API_KEY");
  if (!process.env.BALLDONTLIE_API_KEY) missing.push("BALLDONTLIE_API_KEY");

  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

function main() {
  verifyRequiredEnv();
  logConfig();

  if (!isValidYmd(TARGET_START)) {
    throw new Error(`AUTO_BACKFILL_TARGET_START is invalid: ${TARGET_START}`);
  }

  const state = loadState();

  const recentRepairDays = buildRecentRepairDays();
  const olderBurstDays = buildOlderBurstDays(state);
  const daysToRun = uniqueOrderedDays([...recentRepairDays, ...olderBurstDays]);

  console.log("[AUTO] Recent repair days:", recentRepairDays.join(", "));
  console.log("[AUTO] Older burst days:", olderBurstDays.join(", "));
  console.log("[AUTO] Final day list:", daysToRun.join(", "));

  if (!daysToRun.length) {
    console.log("[AUTO] Nothing to backfill.");
    state.lastRunAt = new Date().toISOString();
    saveState(state);
    return;
  }

  let oldestProcessed = state.oldestBackfilledDate;
  const attempted = [];
  const succeeded = [];

  for (const day of daysToRun) {
    attempted.push(day);
    runBackfillForDay(day);
    succeeded.push(day);

    if (!oldestProcessed || day < oldestProcessed) {
      oldestProcessed = day;
    }
  }

  state.oldestBackfilledDate = oldestProcessed;
  state.lastRunAt = new Date().toISOString();
  state.lastSuccessAt = new Date().toISOString();
  state.lastAttemptedDays = attempted;
  saveState(state);

  console.log("\n[AUTO] Done.");
  console.log("[AUTO] oldestBackfilledDate =", state.oldestBackfilledDate);
  console.log("[AUTO] attempted =", attempted.join(", "));
  console.log("[AUTO] succeeded =", succeeded.join(", "));
}

try {
  main();
} catch (err) {
  console.error("\n[AUTO] FATAL ERROR");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
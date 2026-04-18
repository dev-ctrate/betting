function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function average(values) {
  if (!Array.isArray(values) || !values.length) return null;
  const nums = values.filter(v => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function bucketEdge(edge) {
  if (typeof edge !== "number" || !Number.isFinite(edge)) return "unknown";
  if (edge < 0.02) return "<2%";
  if (edge < 0.04) return "2-4%";
  if (edge < 0.06) return "4-6%";
  if (edge < 0.08) return "6-8%";
  return "8%+";
}

function safeResult(snapshot) {
  if (!snapshot || !snapshot.result) return null;
  if (typeof snapshot.result.modelWon === "boolean") return snapshot.result.modelWon;
  return null;
}

function pushStat(map, key, won) {
  if (!map[key]) {
    map[key] = { bets: 0, wins: 0, winRate: null };
  }
  map[key].bets += 1;
  if (won) map[key].wins += 1;
}

function finalizeStats(map) {
  for (const key of Object.keys(map)) {
    const row = map[key];
    row.winRate = row.bets ? row.wins / row.bets : null;
  }
  return map;
}

function dedupeSnapshotsByGame(rows) {
  const grouped = new Map();

  for (const row of rows || []) {
    const key =
      row.gameId ||
      row.id ||
      `${row.homeTeam || ""}_${row.awayTeam || ""}_${row.commenceTime || row.timestamp || ""}`;

    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  return [...grouped.values()].map(group => {
    return [...group].sort((a, b) => {
      const at = new Date(a.timestamp || 0).getTime();
      const bt = new Date(b.timestamp || 0).getTime();
      return bt - at;
    })[0];
  });
}

function buildRecommendedWeight(feature, highWinRate, lowWinRate, samples, highCount, lowCount) {
  if (
    highWinRate == null ||
    lowWinRate == null ||
    samples < 20 ||
    highCount < 5 ||
    lowCount < 5
  ) {
    return 1.0;
  }

  const lift = highWinRate - lowWinRate;

  const penaltyFeatures = new Set([
    "disagreementPenalty",
    "garbageTimePenalty"
  ]);

  let base = 1.0;

  if (penaltyFeatures.has(feature)) {
    base += clamp((-lift) * 4, -0.35, 0.35);
  } else {
    base += clamp(lift * 4, -0.35, 0.35);
  }

  return clamp(base, 0.65, 1.35);
}

function buildFeaturePerformance(rows) {
  const features = [
    "spreadAdj",
    "totalAdj",
    "lineMovementAdj",
    "propAdj",
    "injuryAdjHome",
    "disagreementPenalty",
    "scoreAdj",
    "comebackAdj",
    "momentumAdj",
    "pacePressureAdj",
    "garbageTimePenalty",
    "timeLeverage"
  ];

  const out = {};

  for (const feature of features) {
    const vals = rows
      .map(r => ({
        value: Number.isFinite(r?.[feature]) ? r[feature] : null,
        won: safeResult(r)
      }))
      .filter(x => x.value !== null && x.won !== null);

    if (!vals.length) continue;

    const avgValue = average(vals.map(x => x.value));
    if (avgValue == null) continue;

    const high = vals.filter(x => x.value > avgValue);
    const low = vals.filter(x => x.value <= avgValue);

    const highWinRate = high.length ? high.filter(x => x.won).length / high.length : null;
    const lowWinRate = low.length ? low.filter(x => x.won).length / low.length : null;

    out[feature] = {
      samples: vals.length,
      averageValue: avgValue,
      highSamples: high.length,
      lowSamples: low.length,
      highWinRate,
      lowWinRate,
      lift: (highWinRate != null && lowWinRate != null)
        ? (highWinRate - lowWinRate)
        : null,
      recommendedWeight: buildRecommendedWeight(
        feature,
        highWinRate,
        lowWinRate,
        vals.length,
        high.length,
        low.length
      )
    };
  }

  return out;
}

function buildModelReview(snapshots) {
  const uniqueRows = dedupeSnapshotsByGame(snapshots || []);
  const graded = uniqueRows.filter(s => safeResult(s) !== null);

  const overall = {
    bets: graded.length,
    wins: graded.filter(s => safeResult(s)).length,
    winRate: null
  };
  overall.winRate = overall.bets ? overall.wins / overall.bets : null;

  const byMode = {};
  const byVerdict = {};
  const byEdgeBucket = {};

  for (const row of graded) {
    const won = safeResult(row);
    const mode = row.mode || row.source || "unknown";
    const verdict = row.verdict || "unknown";
    const edgeBucket = bucketEdge(row.calibratedEdge ?? row.rawEdge ?? row.edge);

    pushStat(byMode, mode, won);
    pushStat(byVerdict, verdict, won);
    pushStat(byEdgeBucket, edgeBucket, won);
  }

  finalizeStats(byMode);
  finalizeStats(byVerdict);
  finalizeStats(byEdgeBucket);

  const featurePerformance = buildFeaturePerformance(graded);

  return {
    overall,
    byMode,
    byVerdict,
    byEdgeBucket,
    featurePerformance
  };
}

module.exports = {
  buildModelReview
};

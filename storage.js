const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const ACTIVITIES_FILE = path.join(DATA_DIR, 'activities.json');
const OBJECTIVES_FILE = path.join(DATA_DIR, 'objectives.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ── Activities ────────────────────────────────────────────────────────────────

function getActivities({ sport, days } = {}) {
  const all = readJSON(ACTIVITIES_FILE, []);
  let result = all;

  if (sport && sport !== 'all') {
    result = result.filter((a) => a.sport === sport);
  }

  if (days) {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().split('T')[0];
    result = result.filter((a) => a.date >= cutoff);
  }

  return result.sort((a, b) => (b.date > a.date ? 1 : -1));
}

function getActivity(id) {
  const all = readJSON(ACTIVITIES_FILE, []);
  return all.find((a) => a.id === String(id)) || null;
}

/**
 * Insert or update an activity. Returns true if it was newly inserted.
 */
function upsertActivity(activity) {
  ensureDataDir();
  const all = readJSON(ACTIVITIES_FILE, []);
  const idx = all.findIndex((a) => a.id === String(activity.id));
  if (idx >= 0) {
    // Preserve existing gpxData if new record doesn't have it
    if (!activity.gpxData && all[idx].gpxData) {
      activity.gpxData = all[idx].gpxData;
    }
    all[idx] = activity;
    writeJSON(ACTIVITIES_FILE, all);
    return false; // existing
  }
  all.push(activity);
  writeJSON(ACTIVITIES_FILE, all);
  return true; // new
}

function attachGPS(id, gpxData) {
  const all = readJSON(ACTIVITIES_FILE, []);
  const idx = all.findIndex((a) => a.id === String(id));
  if (idx >= 0) {
    all[idx].gpxData = gpxData;
    writeJSON(ACTIVITIES_FILE, all);
    return true;
  }
  return false;
}

function addManualActivity(activity) {
  const id = `manual_${Date.now()}`;
  const full = { ...activity, id, source: 'manual' };
  upsertActivity(full);
  return full;
}

// ── Objectives ────────────────────────────────────────────────────────────────

function getObjectives() {
  return readJSON(OBJECTIVES_FILE, []);
}

function saveObjective(obj) {
  const all = getObjectives();
  const id = obj.id || `obj_${Date.now()}`;
  const full = { ...obj, id };
  const idx = all.findIndex((o) => o.id === id);
  if (idx >= 0) all[idx] = full;
  else all.push(full);
  writeJSON(OBJECTIVES_FILE, all);
  return full;
}

function deleteObjective(id) {
  const all = getObjectives().filter((o) => o.id !== id);
  writeJSON(OBJECTIVES_FILE, all);
}

/**
 * Compute progress for each objective based on stored activities.
 */
function getObjectivesWithProgress() {
  const objectives = getObjectives();
  const now = new Date();

  return objectives.map((obj) => {
    let progress = null;
    let current = 0;
    let target = obj.targetValue || 0;

    const activities = getActivities({
      sport: obj.sport !== 'all' ? obj.sport : undefined,
      days: obj.periodDays || 30,
    });

    switch (obj.type) {
      case 'distance': {
        current = activities.reduce((s, a) => s + (a.distanceKm || 0), 0);
        current = parseFloat(current.toFixed(1));
        progress = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
        break;
      }
      case 'frequency': {
        current = activities.length;
        progress = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
        break;
      }
      case 'pace': {
        const runs = activities.filter((a) => a.sport === 'Run' && a.paceMinPerKm);
        if (runs.length > 0) {
          const best = runs.reduce((b, r) => {
            const s = paceToSec(r.paceMinPerKm);
            return s < paceToSec(b) ? r.paceMinPerKm : b;
          }, runs[0].paceMinPerKm);
          current = best;
          const targetSec = paceToSec(obj.targetPace);
          const currentSec = paceToSec(best);
          progress = targetSec > 0
            ? Math.min(100, Math.round(((targetSec - currentSec) / targetSec) * 100 + 100))
            : 0;
        }
        break;
      }
      case 'race': {
        // Progress based on longest run vs race distance
        const runs = activities.filter((a) => a.sport === 'Run');
        const longest = runs.reduce((m, r) => Math.max(m, r.distanceKm || 0), 0);
        current = parseFloat(longest.toFixed(1));
        const raceDist = RACE_DISTANCES[obj.raceType] || target;
        progress = raceDist > 0 ? Math.min(100, Math.round((longest / raceDist) * 100)) : 0;
        target = raceDist;
        break;
      }
    }

    const daysLeft = obj.targetDate
      ? Math.max(0, Math.ceil((new Date(obj.targetDate) - now) / 86400000))
      : null;

    return { ...obj, progress, current, target, daysLeft };
  });
}

const RACE_DISTANCES = {
  '5k': 5,
  '10k': 10,
  'half': 21.1,
  'marathon': 42.2,
};

function paceToSec(pace) {
  if (!pace) return Infinity;
  const parts = String(pace).split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1] || 0);
}

// ── Meta / Sync state ─────────────────────────────────────────────────────────

function getLastSync() {
  return readJSON(META_FILE, {}).lastSync || null;
}

function setLastSync(iso) {
  const meta = readJSON(META_FILE, {});
  meta.lastSync = iso;
  writeJSON(META_FILE, meta);
}

// ── Summary stats ─────────────────────────────────────────────────────────────

function buildSummary(sport = 'all', days = 90) {
  const activities = getActivities({ sport: sport !== 'all' ? sport : undefined, days });

  if (activities.length === 0) return { total: 0, sport };

  const totalDist = activities.reduce((s, a) => s + (a.distanceKm || 0), 0);
  const totalTime = activities.reduce((s, a) => s + (a.durationS || 0), 0);
  const withHR = activities.filter((a) => a.avgHeartrate);
  const avgHR = withHR.length
    ? Math.round(withHR.reduce((s, a) => s + a.avgHeartrate, 0) / withHR.length)
    : null;

  const longest = activities.reduce(
    (b, a) => ((a.distanceKm || 0) > (b.distanceKm || 0) ? a : b),
    activities[0]
  );

  // Weekly breakdown
  const weeklyMap = {};
  activities.forEach((a) => {
    const d = new Date(a.date);
    const week = getISOWeek(d);
    weeklyMap[week] = (weeklyMap[week] || 0) + (a.distanceKm || 0);
  });

  const weeklyDistances = Object.entries(weeklyMap)
    .map(([week, km]) => ({ week, km: parseFloat(km.toFixed(1)) }))
    .sort((a, b) => (a.week > b.week ? 1 : -1));

  // Pace for runs
  let avgPace = null;
  if (sport === 'Run' || sport === 'all') {
    const runs = activities.filter((a) => a.sport === 'Run' && a.durationS && a.distanceKm > 0);
    if (runs.length > 0) {
      const totalRunDist = runs.reduce((s, r) => s + r.distanceKm, 0);
      const totalRunTime = runs.reduce((s, r) => s + r.durationS, 0);
      const secPerKm = totalRunTime / totalRunDist;
      const min = Math.floor(secPerKm / 60);
      const sec = Math.round(secPerKm % 60);
      avgPace = `${min}:${String(sec).padStart(2, '0')}`;
    }
  }

  return {
    sport,
    total: activities.length,
    totalDistanceKm: parseFloat(totalDist.toFixed(1)),
    totalTimeHours: parseFloat((totalTime / 3600).toFixed(1)),
    avgHR,
    avgPace,
    longestActivity: longest
      ? { distanceKm: longest.distanceKm, date: longest.date, name: longest.name }
      : null,
    weeklyDistances,
    recentActivities: activities.slice(0, 10).map((a) => ({
      id: a.id,
      sport: a.sport,
      name: a.name,
      date: a.date,
      distanceKm: a.distanceKm,
      durationMin: a.durationMin,
      paceMinPerKm: a.paceMinPerKm,
      avgHeartrate: a.avgHeartrate,
      elevationGainM: a.elevationGainM,
      calories: a.calories,
    })),
  };
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

module.exports = {
  getActivities,
  getActivity,
  upsertActivity,
  attachGPS,
  addManualActivity,
  getObjectives,
  saveObjective,
  deleteObjective,
  getObjectivesWithProgress,
  getLastSync,
  setLastSync,
  buildSummary,
};

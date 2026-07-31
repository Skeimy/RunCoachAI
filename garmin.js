const GarminConnect = require('garmin-connect').GarminConnect;
const storage = require('./storage');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, 'data', '.garmin_tokens.json');

// Garmin activity type keys → our sport keys
const SPORT_MAP = {
  running: 'Run',
  cycling: 'Ride',
  swimming: 'Swim',
  open_water_swimming: 'Swim',
  tennis: 'Tennis',
  badminton: 'Badminton',
};

let client = null;

/**
 * Initialise and authenticate the Garmin Connect client.
 * Reuses a cached token file to avoid hammering Garmin's SSO on every restart.
 */
async function connect() {
  client = new GarminConnect({
    username: process.env.GARMIN_EMAIL,
    password: process.env.GARMIN_PASSWORD,
  });

  // Try loading a saved token first to avoid repeated logins
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const { oauth1, oauth2 } = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      client.loadToken(oauth1, oauth2);
      console.log('✅ Garmin Connect: loaded cached session');
      return client;
    } catch {
      console.warn('⚠️  Cached Garmin token invalid — logging in fresh');
    }
  }

  // Fresh login
  await client.login();
  saveToken();
  console.log('✅ Garmin Connect: logged in');
  return client;
}

function saveToken() {
  try {
    const tokens = client.exportToken();
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  } catch {
    // Token save is best-effort
  }
}

/**
 * Fetch activities from Garmin Connect and persist new ones.
 * Retries once with a fresh login if the session has expired.
 */
async function syncActivities(days = 90) {
  if (!client) await connect();

  let activities;
  try {
    activities = await client.getActivities(0, 100);
  } catch (err) {
    // Session may have expired — delete cached token and retry once
    if (err?.statusCode === 401 || err?.message?.includes('401')) {
      console.warn('⚠️  Garmin session expired — refreshing login');
      if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
      client = null;
      await connect();
      activities = await client.getActivities(0, 100);
    } else {
      throw err;
    }
  }

  // Save refreshed token after successful call
  saveToken();

  const cutoff = Date.now() - days * 86400 * 1000;
  let added = 0;

  for (const raw of activities) {
    const startMs = new Date(raw.startTimeLocal || raw.startTimeGMT).getTime();
    if (startMs < cutoff) continue;

    const typeKey = raw.activityType?.typeKey || '';
    const parentTypeKey = raw.activityType?.parentTypeKey || '';
    const sport = SPORT_MAP[typeKey] || SPORT_MAP[parentTypeKey];
    if (!sport) continue;

    const activity = normalise(raw, sport);
    const isNew = storage.upsertActivity(activity);
    if (isNew) added++;
  }

  storage.setLastSync(new Date().toISOString());
  console.log(`🔄 Sync complete — ${added} new activities added`);
  return added;
}

/**
 * Normalise a raw Garmin activity object into our internal schema.
 */
function normalise(raw, sport) {
  const distanceM = raw.distance || 0;
  const durationS = raw.duration || raw.movingDuration || 0;
  const paceSecPerKm = distanceM > 0 && durationS > 0 ? durationS / (distanceM / 1000) : null;

  return {
    id: String(raw.activityId),
    sport,
    name: raw.activityName || `${sport} activity`,
    date: (raw.startTimeLocal || raw.startTimeGMT || '').split(' ')[0],
    startTime: raw.startTimeLocal || raw.startTimeGMT || null,
    distanceKm: parseFloat((distanceM / 1000).toFixed(2)),
    durationMin: Math.round(durationS / 60),
    durationS: Math.round(durationS),
    paceMinPerKm: sport === 'Run' ? formatPace(paceSecPerKm) : null,
    paceMinPer100m: sport === 'Swim' && paceSecPerKm ? formatPace(paceSecPerKm / 10) : null,
    avgSpeedKmh: parseFloat(((raw.averageSpeed || 0) * 3.6).toFixed(1)),
    avgHeartrate: raw.averageHR ? Math.round(raw.averageHR) : null,
    maxHeartrate: raw.maxHR ? Math.round(raw.maxHR) : null,
    elevationGainM: raw.elevationGain ? Math.round(raw.elevationGain) : null,
    calories: raw.calories ? Math.round(raw.calories) : null,
    avgCadence: raw.averageRunningCadenceInStepsPerMinute
      ? Math.round(raw.averageRunningCadenceInStepsPerMinute * 2)
      : (raw.averageBikingCadenceInRevPerMinute ? Math.round(raw.averageBikingCadenceInRevPerMinute) : null),
    vo2max: raw.vO2MaxValue || null,
    trainingEffect: raw.aerobicTrainingEffect || null,
    garminId: raw.activityId,
    gpxData: null,
  };
}

let syncTimer = null;

/**
 * Start the background polling loop with exponential backoff on failure.
 */
function startPolling() {
  const intervalMs = (parseInt(process.env.SYNC_INTERVAL_MINUTES) || 30) * 60 * 1000;

  // Delay the first sync by 2s to let the server fully start
  setTimeout(() => {
    syncWithBackoff(parseInt(process.env.INITIAL_SYNC_DAYS) || 90);
  }, 2000);

  syncTimer = setInterval(() => {
    syncWithBackoff(2);
  }, intervalMs);

  console.log(`⏰ Garmin auto-sync every ${intervalMs / 60000} minutes`);
}

async function syncWithBackoff(days, attempt = 1) {
  try {
    await syncActivities(days);
  } catch (err) {
    const isRateLimit = err?.message?.includes('429') || err?.message?.includes('rate limit');
    if (isRateLimit && attempt <= 5) {
      const waitSec = 30 * Math.pow(2, attempt - 1); // 30s, 60s, 120s…
      console.warn(`⚠️  Garmin rate limited — retrying in ${waitSec}s (attempt ${attempt}/5)`);
      setTimeout(() => syncWithBackoff(days, attempt + 1), waitSec * 1000);
    } else {
      console.error('Garmin sync failed:', err.message);
    }
  }
}

function stopPolling() {
  if (syncTimer) clearInterval(syncTimer);
}

function formatPace(secPerKm) {
  if (!secPerKm || !isFinite(secPerKm) || secPerKm <= 0) return null;
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${String(sec).padStart(2, '0')}`;
}

/**
 * Fetch the athlete's profile (name, location, avatar URL) from Garmin Connect.
 */
async function getProfile() {
  if (!client) await connect();
  try {
    const profile = await client.getUserProfile();
    const settings = await client.getUserSettings();
    return {
      firstName: profile?.displayName?.split(' ')[0] || profile?.userName || '',
      lastName:  profile?.displayName?.split(' ').slice(1).join(' ') || '',
      fullName:  profile?.displayName || profile?.userName || 'Athlete',
      location:  profile?.location || null,
      avatarUrl: profile?.profileImageUrlLarge || profile?.profileImageUrlMedium || null,
      memberSince: settings?.userData?.birthDate ? null : null,
    };
  } catch {
    return null;
  }
}

module.exports = { connect, syncActivities, startPolling, stopPolling, getProfile };

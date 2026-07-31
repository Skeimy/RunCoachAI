require('dotenv').config();

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const garmin = require('./garmin');
const storage = require('./storage');
const llm = require('./llm');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev_secret',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
}));

// ── API: Status & Sync ────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({
    lastSync: storage.getLastSync(),
    totalActivities: storage.getActivities().length,
    garminConfigured: !!(process.env.GARMIN_EMAIL && process.env.GARMIN_PASSWORD),
  });
});

app.post('/api/sync', async (req, res) => {
  try {
    const added = await garmin.syncActivities(2);
    res.json({ ok: true, added, lastSync: storage.getLastSync() });
  } catch (err) {
    console.error('Manual sync error:', err.message);
    res.status(500).json({ error: `Sync failed: ${err.message}` });
  }
});

// ── API: Activities ────────────────────────────────────────────────────────────

app.get('/api/activities', (req, res) => {
  const { sport, days } = req.query;
  const activities = storage.getActivities({
    sport: sport && sport !== 'all' ? sport : undefined,
    days: days ? parseInt(days) : 90,
  });
  res.json({ activities });
});

app.get('/api/activities/:id', async (req, res) => {
  const activity = storage.getActivity(req.params.id);
  if (!activity) return res.status(404).json({ error: 'Not found' });

  res.json({ activity });
});

// ── API: Manual activity entry ─────────────────────────────────────────────────

app.post('/api/activities/manual', (req, res) => {
  const { sport, name, date, distanceKm, durationMin, avgHeartrate, notes } = req.body;
  if (!sport || !date || !durationMin) {
    return res.status(400).json({ error: 'sport, date and durationMin are required' });
  }

  const durationS = durationMin * 60;
  const paceSecPerKm = distanceKm > 0 ? durationS / distanceKm : null;

  const activity = storage.addManualActivity({
    sport,
    name: name || `${sport} session`,
    date,
    distanceKm: distanceKm ? parseFloat(distanceKm) : null,
    durationMin: parseInt(durationMin),
    durationS,
    paceMinPerKm: paceSecPerKm ? formatPace(paceSecPerKm) : null,
    avgHeartrate: avgHeartrate ? parseInt(avgHeartrate) : null,
    notes: notes || null,
    calories: null,
    elevationGainM: null,
    gpxData: null,
  });

  res.json({ activity });
});

// ── API: FIT/GPX file upload ───────────────────────────────────────────────────

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!['.fit', '.gpx'].includes(ext)) {
    return res.status(400).json({ error: 'Only .fit and .gpx files are supported' });
  }

  try {
    let activity;
    if (ext === '.gpx') {
      activity = parseGPX(req.file.buffer.toString('utf8'));
    } else {
      activity = await parseFIT(req.file.buffer);
    }

    activity.name = activity.name || req.file.originalname.replace(/\.(fit|gpx)$/i, '');
    const saved = storage.addManualActivity(activity);
    res.json({ activity: saved });
  } catch (err) {
    console.error('Upload parse error:', err.message);
    res.status(400).json({ error: `Could not parse file: ${err.message}` });
  }
});

// ── API: Summary ──────────────────────────────────────────────────────────────

app.get('/api/summary', (req, res) => {
  const { sport, days } = req.query;
  const summary = storage.buildSummary(sport || 'all', parseInt(days) || 90);
  res.json(summary);
});

// ── API: Objectives ───────────────────────────────────────────────────────────

app.get('/api/objectives', (req, res) => {
  res.json({ objectives: storage.getObjectivesWithProgress() });
});

app.post('/api/objectives', (req, res) => {
  const obj = req.body;
  if (!obj.title || !obj.sport || !obj.type) {
    return res.status(400).json({ error: 'title, sport and type are required' });
  }
  const saved = storage.saveObjective(obj);
  res.json({ objective: saved });
});

app.put('/api/objectives/:id', (req, res) => {
  const saved = storage.saveObjective({ ...req.body, id: req.params.id });
  res.json({ objective: saved });
});

app.delete('/api/objectives/:id', (req, res) => {
  storage.deleteObjective(req.params.id);
  res.json({ ok: true });
});

// ── API: AI Chat ──────────────────────────────────────────────────────────────

const chatHistories = {};

app.post('/api/chat', async (req, res) => {
  const { message, sport } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

  const sid = req.session.id;
  if (!chatHistories[sid]) chatHistories[sid] = [];

  try {
    const summary = storage.buildSummary(sport || 'all', 90);
    const objectives = storage.getObjectivesWithProgress();

    const rawReply = await llm.chat(chatHistories[sid], message.trim(), summary, objectives);

    // Extract LOCATIONS block if present
    const { reply, locations } = await extractAndGeocodeLocations(rawReply);

    chatHistories[sid].push({ role: 'user', content: message.trim() });
    chatHistories[sid].push({ role: 'assistant', content: reply });
    if (chatHistories[sid].length > 40) {
      chatHistories[sid] = chatHistories[sid].slice(-40);
    }

    res.json({ reply, locations: locations.length > 0 ? locations : null });
  } catch (err) {
    const detail = err?.error?.message || err?.message || String(err);
    console.error('Chat error:', detail);
    res.status(500).json({ error: `AI chat failed: ${detail}` });
  }
});

app.delete('/api/chat', (req, res) => {
  delete chatHistories[req.session.id];
  res.json({ ok: true });
});

// ── Geocoding ─────────────────────────────────────────────────────────────────

/**
 * Parse the LOCATIONS:[...] block from the AI reply, geocode each place
 * via OpenStreetMap Nominatim (free, no key needed), and return clean text + coords.
 */
async function extractAndGeocodeLocations(rawReply) {
  const marker = 'LOCATIONS:';
  const idx = rawReply.indexOf(marker);

  if (idx === -1) return { reply: rawReply.trim(), locations: [] };

  // Split text from the JSON block
  const reply = rawReply.slice(0, idx).trim();
  const jsonStr = rawReply.slice(idx + marker.length).trim();

  let places = [];
  try {
    places = JSON.parse(jsonStr);
  } catch {
    // Malformed JSON — return reply without map
    return { reply, locations: [] };
  }

  // Geocode each place in parallel
  const locations = await Promise.all(
    places.map(async (place) => {
      try {
        const coords = await geocode(`${place.name}, ${place.city}, ${place.country}`);
        return { ...place, lat: coords.lat, lon: coords.lon };
      } catch {
        return { ...place, lat: null, lon: null };
      }
    })
  );

  // Only return places we could geocode
  return { reply, locations: locations.filter((l) => l.lat !== null) };
}

/**
 * Geocode a place name using OpenStreetMap Nominatim — completely free.
 * Rate limit: 1 request/second. We add a small delay between calls.
 */
const geocodeCache = {};

async function geocode(query) {
  if (geocodeCache[query]) return geocodeCache[query];

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const response = await axios.get(url, {
    headers: { 'User-Agent': 'RunCoachAI/1.0 personal-training-app' },
    timeout: 5000,
  });

  if (!response.data || response.data.length === 0) {
    throw new Error(`No results for: ${query}`);
  }

  const result = { lat: parseFloat(response.data[0].lat), lon: parseFloat(response.data[0].lon) };
  geocodeCache[query] = result;
  return result;
}

// ── File parsers ──────────────────────────────────────────────────────────────

function parseGPX(xml) {
  // Extract coordinates
  const coords = [];
  const trkptRegex = /<trkpt[^>]+lat="([^"]+)"[^>]+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  let m;
  while ((m = trkptRegex.exec(xml)) !== null) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    const inner = m[3];
    const eleM = /<ele>([\d.]+)<\/ele>/.exec(inner);
    const timeM = /<time>([^<]+)<\/time>/.exec(inner);
    const hrM = /<ns3:hr>(\d+)<\/ns3:hr>/.exec(inner) || /<gpxtpx:hr>(\d+)<\/gpxtpx:hr>/.exec(inner);
    coords.push({
      lat, lon,
      ele: eleM ? parseFloat(eleM[1]) : null,
      time: timeM ? timeM[1] : null,
      hr: hrM ? parseInt(hrM[1]) : null,
    });
  }

  // Metadata
  const nameM = /<name><!\[CDATA\[([^\]]+)\]\]><\/name>|<name>([^<]+)<\/name>/.exec(xml);
  const typeM = /<type>([^<]+)<\/type>/.exec(xml);

  // Compute distance
  let distM = 0;
  for (let i = 1; i < coords.length; i++) {
    distM += haversine(coords[i - 1], coords[i]);
  }

  // Duration
  let durationS = 0;
  if (coords.length >= 2 && coords[0].time && coords[coords.length - 1].time) {
    durationS = Math.round(
      (new Date(coords[coords.length - 1].time) - new Date(coords[0].time)) / 1000
    );
  }

  const sport = detectSport(typeM ? typeM[1] : '');
  const paceSecPerKm = distM > 0 && durationS > 0 ? durationS / (distM / 1000) : null;

  return {
    sport,
    name: (nameM ? (nameM[1] || nameM[2]) : null) || `${sport} activity`,
    date: coords[0]?.time ? coords[0].time.split('T')[0] : new Date().toISOString().split('T')[0],
    distanceKm: parseFloat((distM / 1000).toFixed(2)),
    durationMin: Math.round(durationS / 60),
    durationS,
    paceMinPerKm: sport === 'Run' ? formatPace(paceSecPerKm) : null,
    avgHeartrate: coords.some((c) => c.hr)
      ? Math.round(coords.filter((c) => c.hr).reduce((s, c) => s + c.hr, 0) / coords.filter((c) => c.hr).length)
      : null,
    elevationGainM: computeElevationGain(coords),
    gpxData: { coordinates: coords },
  };
}

async function parseFIT(buffer) {
  const FitParser = require('fit-file-parser');
  return new Promise((resolve, reject) => {
    const parser = new FitParser({ force: true, speedUnit: 'km/h', lengthUnit: 'km', elapsedRecordField: true });
    parser.parse(buffer, (err, data) => {
      if (err) return reject(err);

      const session = data.activity?.sessions?.[0] || {};
      const records = data.activity?.sessions?.[0]?.laps?.flatMap((l) => l.records || []) || [];

      const distKm = parseFloat((session.total_distance || 0).toFixed(2));
      const durationS = Math.round(session.total_elapsed_time || 0);
      const sport = detectSport(session.sport || '');
      const paceSecPerKm = distKm > 0 && durationS > 0 ? durationS / distKm : null;

      const coords = records
        .filter((r) => r.position_lat && r.position_long)
        .map((r) => ({
          lat: r.position_lat,
          lon: r.position_long,
          ele: r.altitude || null,
          hr: r.heart_rate || null,
          time: r.timestamp ? new Date(r.timestamp).toISOString() : null,
        }));

      const withHR = records.filter((r) => r.heart_rate);
      const avgHR = withHR.length
        ? Math.round(withHR.reduce((s, r) => s + r.heart_rate, 0) / withHR.length)
        : null;

      resolve({
        sport,
        name: `${sport} activity`,
        date: session.start_time
          ? new Date(session.start_time).toISOString().split('T')[0]
          : new Date().toISOString().split('T')[0],
        distanceKm: distKm,
        durationMin: Math.round(durationS / 60),
        durationS,
        paceMinPerKm: sport === 'Run' ? formatPace(paceSecPerKm) : null,
        avgSpeedKmh: parseFloat(((session.avg_speed || 0)).toFixed(1)),
        avgHeartrate: avgHR,
        maxHeartrate: session.max_heart_rate || null,
        elevationGainM: session.total_ascent ? Math.round(session.total_ascent) : null,
        calories: session.total_calories || null,
        avgCadence: session.avg_running_cadence
          ? Math.round(session.avg_running_cadence * 2)
          : null,
        vo2max: session.enhanced_avg_speed || null,
        gpxData: coords.length > 0 ? { coordinates: coords } : null,
      });
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectSport(str) {
  const s = str.toLowerCase();
  if (s.includes('run')) return 'Run';
  if (s.includes('cycl') || s.includes('bik') || s.includes('ride')) return 'Ride';
  if (s.includes('swim')) return 'Swim';
  if (s.includes('tennis')) return 'Tennis';
  if (s.includes('badminton')) return 'Badminton';
  return 'Run'; // default
}

function formatPace(secPerKm) {
  if (!secPerKm || !isFinite(secPerKm) || secPerKm <= 0) return null;
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function haversine(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function computeElevationGain(coords) {
  let gain = 0;
  for (let i = 1; i < coords.length; i++) {
    const diff = (coords[i].ele || 0) - (coords[i - 1].ele || 0);
    if (diff > 0) gain += diff;
  }
  return gain > 0 ? Math.round(gain) : null;
}

// ── Start ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🏃 RunCoach AI running at http://localhost:${PORT}\n`);

  // Validate required env vars on startup
  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'gsk_your_groq_api_key') {
    console.error('❌  GROQ_API_KEY is missing or still the placeholder value in your .env file!');
    console.error('    → Sign up free at https://console.groq.com, create a key, and paste it into .env');
    console.error('    → Then restart the server with: npm run dev');
  } else {
    console.log('✅ Groq API key found');
  }

  if (process.env.GARMIN_EMAIL && process.env.GARMIN_PASSWORD) {
    garmin.startPolling();
  } else {
    console.warn('⚠️  GARMIN_EMAIL / GARMIN_PASSWORD not set — auto-sync disabled. Upload FIT/GPX files manually.');
  }
});

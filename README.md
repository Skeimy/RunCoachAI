# 🏃 RunCoach AI

A **personal multi-sport training dashboard** with an AI coach.  
Connects to your **Garmin** account automatically. Supports Running, Cycling, Swimming, Tennis, and Badminton.  
AI coach powered by **Groq** (free).

---

## Features

| Feature | Details |
|---|---|
| 📊 **Dashboard** | Stats, weekly distance, pace trend — filtered by sport |
| 📋 **Activities** | All your sessions, searchable, with GPS map on detail |
| 🗺️ **GPS Map** | Interactive route map (Leaflet + OpenStreetMap, free) |
| 🎯 **Objectives** | Set distance, frequency, race, or pace goals with progress tracking |
| 🤖 **AI Coach** | Chat — get training plans, route suggestions, daily advice |
| 📁 **FIT/GPX upload** | Upload files manually as fallback |
| ✏️ **Manual log** | Log tennis/badminton sessions without a file |
| 📱 **PWA** | Add to your phone home screen |
| 🔄 **Auto-sync** | Polls Garmin Connect every 30 minutes automatically |

---

## Quick Start (local)

### 1. Install

```bash
cd runcoach-ai
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
GARMIN_EMAIL=your@email.com
GARMIN_PASSWORD=your_garmin_password

GROQ_API_KEY=gsk_...          # free at https://console.groq.com

SESSION_SECRET=any_long_random_string
APP_URL=http://localhost:3000
PORT=3000

SYNC_INTERVAL_MINUTES=30
INITIAL_SYNC_DAYS=90
```

### 3. Get your free Groq API key

1. Go to [https://console.groq.com](https://console.groq.com)
2. Sign up (free, no credit card)
3. Create an API key → paste it in `.env`

### 4. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The app will auto-sync your Garmin activities on startup.

---

## Deploy to your phone (Railway — free)

### 1. Push to GitHub

```bash
git init && git add . && git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/runcoach-ai.git
git push -u origin main
```

### 2. Deploy on Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Select your repo — Railway auto-detects Node.js and deploys
3. In **Variables**, add all your `.env` keys (same as above but set `APP_URL=https://your-app.railway.app`)

### 3. Add to phone home screen

- **iPhone (Safari)**: Share button → "Add to Home Screen"
- **Android (Chrome)**: Menu → "Install app"

---

## Using Without Garmin (FIT/GPX upload)

If you don't configure Garmin credentials, the app still works fully:

1. After each activity, export the `.fit` or `.gpx` file from your watch app (Garmin Connect, Polar Flow, etc.)
2. Click **+ Upload FIT/GPX** in the app
3. Drop the file — it's parsed and added to your dashboard instantly

For Tennis / Badminton sessions without GPS, use **+ Manual** to log duration, HR, etc.

---

## Project structure

```
runcoach-ai/
├── server.js        ← Express server, all routes, file parsers
├── garmin.js        ← Garmin Connect auto-sync
├── storage.js       ← JSON file store (activities, objectives)
├── llm.js           ← Groq AI coach
├── data/            ← Your data (gitignored)
├── public/
│   ├── index.html   ← Single-page app (5 tabs)
│   ├── style.css    ← Mobile-first navy/orange theme
│   ├── app.js       ← Charts, map, chat, objectives logic
│   ├── manifest.json
│   └── sw.js        ← Service worker (PWA)
├── .env.example
└── railway.toml
```

---

## AI Coach — What You Can Ask

- *"What should I train today?"*
- *"Build me a 4-week plan to run a 10K"*
- *"Suggest a 8km running route in Lyon"*
- *"Am I overtraining? Check my last 2 weeks"*
- *"How can I improve my cycling pace?"*
- *"What's my current fitness level?"*

The AI has full context of all your activities and objectives and answers in your language.

---

## License

MIT — personal use only

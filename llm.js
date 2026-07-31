const Groq = require('groq-sdk');

// Initialise lazily so the app doesn't crash at startup if the key
// is not yet available (e.g. Railway injects env vars after module load)
let _groq = null;
function getGroq() {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

const SPORT_LABELS = {
  Run: 'running',
  Ride: 'cycling',
  Swim: 'swimming',
  Tennis: 'tennis',
  Badminton: 'badminton',
};

const SYSTEM_PROMPT = `You are a concise personal sports coach. You have access to the athlete's training data across running, cycling, swimming, tennis, and badminton.

Rules:
- Be SHORT and direct. Maximum 4-6 sentences or bullet points per reply.
- Never pad or repeat yourself. Get straight to the point.
- Always reference the athlete's actual numbers (pace, distance, HR) when relevant.
- For training suggestions: one clear recommendation, not a list of options.
- For routes: name 2-3 real specific places max, with one sentence each.
- Respond in the same language the user writes in.

Map rule (IMPORTANT):
When you mention specific places, parks, trails or routes the athlete could go to, you MUST append a LOCATIONS block at the very end of your reply in this exact format — no exceptions:

LOCATIONS:[{"name":"Place name","description":"One short sentence why it fits","city":"City name","country":"Country name"}]

Only include this block when you mention actual geographic places. Do not include it for general training advice. The JSON must be valid and on a single line.`;

/**
 * Send a chat message to the LLM.
 * @param {Array}   history     - { role, content }[] conversation history
 * @param {string}  userMessage - Latest user message
 * @param {Object}  summary     - Output of storage.buildSummary()
 * @param {Array}   objectives  - Output of storage.getObjectivesWithProgress()
 * @returns {string} AI reply
 */
async function chat(history, userMessage, summary, objectives) {
  const contextBlock = buildContext(summary, objectives);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `Athlete's training data:\n\n${contextBlock}` },
    ...history.slice(-12),
    { role: 'user', content: userMessage },
  ];

  const completion = await getGroq().chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages,
    temperature: 0.7,
    max_tokens: 600,
  });

  return completion.choices[0].message.content;
}

function buildContext(summary, objectives) {
  if (!summary || summary.total === 0) {
    return 'No activities recorded yet. The athlete has just set up the app.';
  }

  const lines = [
    `=== OVERALL (last 90 days, all sports) ===`,
    `Total activities: ${summary.total}`,
    `Total distance: ${summary.totalDistanceKm} km`,
    `Total training time: ${summary.totalTimeHours} hours`,
    summary.avgHR ? `Average heart rate: ${summary.avgHR} bpm` : '',
    summary.avgPace ? `Average running pace: ${summary.avgPace} min/km` : '',
    ``,
    `=== RECENT ACTIVITIES (last 10) ===`,
    ...(summary.recentActivities || []).map((a) => {
      const parts = [
        `• [${a.sport}] ${a.date} — ${a.name}`,
        a.distanceKm ? `  ${a.distanceKm} km` : '',
        a.durationMin ? `in ${a.durationMin} min` : '',
        a.paceMinPerKm ? `@ ${a.paceMinPerKm}/km` : '',
        a.avgHeartrate ? `| HR: ${a.avgHeartrate} bpm` : '',
        a.elevationGainM ? `| ↑${a.elevationGainM}m` : '',
        a.calories ? `| ${a.calories} kcal` : '',
      ].filter(Boolean);
      return parts.join(' ');
    }),
    ``,
    `=== WEEKLY DISTANCES ===`,
    ...(summary.weeklyDistances || []).slice(-8).map((w) => `• ${w.week}: ${w.km} km`),
  ];

  if (objectives && objectives.length > 0) {
    lines.push('', '=== OBJECTIVES ===');
    objectives.forEach((o) => {
      lines.push(
        `• [${o.sport}] ${o.title} — ${o.progress ?? '?'}% complete` +
          (o.daysLeft !== null ? ` (${o.daysLeft} days left)` : '')
      );
    });
  }

  return lines.filter((l) => l !== null).join('\n');
}

module.exports = { chat };

// Runs inside GitHub Actions. Calls the Claude API with web search enabled,
// merges the results into data.json, and updates history.json for trend deltas.
// Requires the ANTHROPIC_API_KEY environment variable (set as a repo secret).

const fs = require('fs');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY environment variable.');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

const PROMPT = `Today's date is ${today}. You are a talent-intelligence research assistant for a technical recruiter at Intuit who hires for Engineering, Product and Design roles in India.

PART 1 — Company signals. Search the web for the most significant news from roughly the last 7 days about Tier 1 (Google, Meta, Amazon, Microsoft, Apple) and Tier 2 (Salesforce, Adobe, PayPal, Stripe, Workday, Oracle, Uber) companies:
- Layoffs / headcount reductions
- Hiring surges or notable job-posting increases
- New GCC / India office openings by any of these companies
- Org restructuring, new product lines, or executive moves

Only include named Tier 1/2 companies above — do not include IT services companies (TCS, Infosys, etc.), generic India GCC ecosystem stats, or aggregate industry-trend items without a named company.

Return 5 to 8 of the most relevant NEW items with a short recommendation each.

PART 2 — Talent insights. Search for Intuit's current open roles in Bangalore/India (try jobs.intuit.com or "Intuit careers India jobs"). Note the rough count and category breakdown (e.g. Software Engineering, Product Management, Design). Using that plus the Part 1 signals, produce:
- A market read per function (engineering, product, design): verdict is one of "hire_now", "selective", or "wait", with a one-sentence rationale grounded in actual signals.
- supply_pocket: one sentence on where the single biggest available talent pool is right now.
- wait_signal: one sentence on any pool that looks promising but hasn't fully materialized yet (e.g. an announced-but-not-yet-executed cut) — omit if none applies.
- targets: 3-5 items mapping a specific Intuit open-role type to the single best Tier 1/2 company to source it from right now, with a one-sentence reason.
- intuit_context: one sentence summarizing Intuit's current Bangalore/India role mix.

Respond with ONLY valid JSON, no markdown fences, no commentary, matching exactly this shape:
{
  "executive_summary": [
    {"insight": "one sentence, <=35 words", "action": "one sentence, <=20 words"}
  ],
  "talent_insights": {
    "market_reads": [
      {"function": "engineering|product|design", "verdict": "hire_now|selective|wait", "label": "short display label", "rationale": "<=40 words"}
    ],
    "supply_pocket": "<=30 words",
    "wait_signal": "<=30 words",
    "targets": [
      {"intuit_role": "string", "top_target": "company name(s)", "why": "<=25 words"}
    ],
    "intuit_context": "<=35 words",
    "intuit_context_source": "jobs.intuit.com",
    "intuit_context_updated": "${today}"
  },
  "signals": [
    {
      "company": "string",
      "segment": "big_tech | saas_fintech",
      "type": "layoff | hiring | gcc_opening | restructuring",
      "functions": ["engineering","product","design"],
      "date": "YYYY-MM-DD",
      "headline": "<=12 words",
      "summary": "<=2 sentences, <=40 words, paraphrased, no direct quotes",
      "recommendation": "<=25 words, specific and actionable",
      "source_name": "string",
      "source_url": "string"
    }
  ]
}

Provide exactly 3 executive_summary items, 3 market_reads (one per function), 3-5 targets, and 5 to 8 signals. Keep every field within its word limit.`;

function computeCounts(signals) {
  const c = { layoff: 0, hiring: 0, gcc_opening: 0, restructuring: 0 };
  (signals || []).forEach(s => { if (c[s.type] !== undefined) c[s.type]++; });
  return c;
}

function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function snapshotHistory(history, signals) {
  const counts = computeCounts(signals);
  const hist = history.slice();
  if (hist.length && hist[hist.length - 1].date === today) {
    hist[hist.length - 1] = { date: today, counts };
  } else {
    hist.push({ date: today, counts });
  }
  return hist.length > 24 ? hist.slice(hist.length - 24) : hist;
}

async function main() {
  const existing = readJsonSafe('data.json', { executive_summary: [], talent_insights: null, signals: [] });
  const history = readJsonSafe('history.json', []);

  console.log('Calling Claude API (claude-sonnet-5) with web search...');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: PROMPT }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }]
    })
  });

  const data = await resp.json();

  if (data.error) {
    console.error('API error:', JSON.stringify(data.error));
    process.exit(1);
  }

  const textBlocks = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  const start = textBlocks.indexOf('{');
  const end = textBlocks.lastIndexOf('}');
  if (start === -1 || end === -1) {
    console.error('No JSON object found in model response. Raw text:\n', textBlocks.slice(0, 800));
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlocks.slice(start, end + 1));
  } catch (e) {
    console.error('Failed to parse JSON from model response:', e.message);
    console.error('Raw text:\n', textBlocks.slice(0, 800));
    process.exit(1);
  }

  if (!parsed.signals || !Array.isArray(parsed.signals) || parsed.signals.length === 0) {
    console.error('Response had no usable signals array. Skipping update.');
    process.exit(1);
  }

  // Snapshot counts from BEFORE this update, so the dashboard can show a delta.
  const newHistory = snapshotHistory(history, existing.signals || []);

  const existingKeys = new Set(
    (existing.signals || []).map(s => (s.company + '|' + s.headline).toLowerCase())
  );

  const freshSignals = parsed.signals
    .filter(s => s && s.company && s.headline)
    .map((s, i) => ({ id: 'auto-' + Date.now() + '-' + i, ...s, functions: s.functions || [] }))
    .filter(s => !existingKeys.has((s.company + '|' + s.headline).toLowerCase()));

  console.log(`Found ${freshSignals.length} new signal(s) out of ${parsed.signals.length} returned.`);

  const merged = [...freshSignals, ...(existing.signals || [])]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 30);

  const newReport = {
    generated_at: new Date().toISOString(),
    executive_summary: (parsed.executive_summary && parsed.executive_summary.length)
      ? parsed.executive_summary
      : (existing.executive_summary || []),
    talent_insights: (parsed.talent_insights && Object.keys(parsed.talent_insights).length)
      ? parsed.talent_insights
      : (existing.talent_insights || null),
    signals: merged
  };

  fs.writeFileSync('data.json', JSON.stringify(newReport, null, 2) + '\n');
  fs.writeFileSync('history.json', JSON.stringify(newHistory, null, 2) + '\n');

  console.log('data.json and history.json updated successfully.');
}

main().catch(e => {
  console.error('Unexpected error:', e);
  process.exit(1);
});

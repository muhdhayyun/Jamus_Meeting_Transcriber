import { logger } from '../utils/logger.js';

const LIVE_SYSTEM_PROMPT = [
  'You are watching a meeting transcript arrive in real time and maintaining a short, ',
  'rolling "what\'s happening" summary for someone who stepped away and needs to catch up fast.',
  'Rules:',
  '- Respond in GitHub-flavored Markdown, 4-8 bullet points, most recent/important first.',
  '- Cover: what has been discussed, any decisions, and any action items mentioned so far.',
  '- It is fine if the meeting is still ongoing and incomplete — summarize only what has happened.',
  '- Do not invent content that was not said. Do not add a preamble or closing remarks.',
  '- Keep it terse; this updates every ~45 seconds, so prefer clarity over completeness.',
].join('\n');

/**
 * Generate (or refresh) a rolling live summary from the transcript-so-far.
 * Supports a local Ollama server (default) or the Groq cloud API.
 *
 * @returns {Promise<string>} the summary markdown, or throws on failure.
 */
export async function generateLiveSummary({ transcriptText, title, provider, ollama, groq }) {
  if (!transcriptText || !transcriptText.trim()) throw new Error('Nothing transcribed yet.');

  const userContent = `Meeting: ${title || 'Untitled'}\n\nTranscript so far:\n\n${transcriptText}`;

  if (provider === 'ollama') {
    return callOllama({ url: ollama?.url, model: ollama?.model, userContent });
  }
  if (provider === 'groq') {
    return callGroq({ apiKey: groq?.apiKey, model: groq?.model, userContent });
  }
  throw new Error(`Unknown live summary provider "${provider}".`);
}

async function callOllama({ url, model, userContent }) {
  const base = url || 'http://127.0.0.1:11434';
  const body = {
    model: model || 'llama3.1:8b',
    stream: false,
    messages: [
      { role: 'system', content: LIVE_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  };
  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Could not reach Ollama at ${base} (${err.message}). Is "ollama serve" running?`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Ollama error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.message?.content?.trim();
  if (!content) throw new Error('Ollama returned an empty response.');
  return content;
}

async function callGroq({ apiKey, model, userContent }) {
  if (!apiKey) throw new Error('No Groq API key set.');
  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'llama-3.3-70b-versatile',
        temperature: 0.3,
        messages: [
          { role: 'system', content: LIVE_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    });
  } catch (err) {
    throw new Error(`Could not reach Groq (${err.message}).`);
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('Groq rejected the API key (401). Check it in Settings.');
    const detail = await res.text().catch(() => '');
    throw new Error(`Groq error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Groq returned an empty response.');
  return content;
}

/** Best-effort check for a reachable Ollama server (used to disable the UI gracefully). */
export async function isOllamaReachable(url) {
  try {
    const res = await fetch(`${url || 'http://127.0.0.1:11434'}/api/tags`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

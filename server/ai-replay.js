const http = require('http');
const https = require('https');
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;

function ollamaRequest(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error));
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse Ollama response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildPrompt(events, startUrl) {
  const stepLines = events.map((e, i) => {
    const d = e.data || {};
    const parts = [`  ${i + 1}. type=${e.type}`];
    if (d.selector) parts.push(`selector="${d.selector}"`);
    if (d.text_snippet) parts.push(`text="${d.text_snippet}"`);
    if (d.final_value !== undefined) parts.push(`value="${String(d.final_value).slice(0, 50)}"`);
    if (d.input_type) parts.push(`input_type=${d.input_type}`);
    if (d.to_url) parts.push(`to_url="${d.to_url}"`);
    if (d.tag) parts.push(`tag=${d.tag}`);
    return parts.join(' ');
  }).join('\n');

  return `You are a QA replay optimization assistant. Analyze these recorded browser actions and suggest improvements for replay accuracy and speed.

Page URL: ${startUrl || 'unknown'}
Total steps: ${events.length}

Recorded events:
${stepLines}

For each step, return JSON with:
1. "better_selectors": array of 1-3 improved CSS selectors (prefer [data-cy], [data-testid], aria labels, then text content selectors)
2. "wait_type": suggested wait before acting: "element_visible" | "network_idle" | "navigation" | "timeout" | "none"
3. "wait_ms": suggested wait time in milliseconds
4. "skip": boolean - true only if this step is duplicate noise (e.g., duplicate checkbox input)

Also include:
5. "summary": one-line overview of what changed
6. "warnings": array of fragility warnings

Return ONLY valid JSON with this structure:
{
  "enriched_steps": [
    { "index": 1, "better_selectors": [...], "wait_type": "...", "wait_ms": 500, "skip": false }
  ],
  "summary": "...",
  "warnings": [...]
}`;
}

async function enrichSteps(events, startUrl) {
  if (!events || events.length === 0) return { enriched_steps: [], summary: 'No steps to analyze', warnings: [] };
  const maxSteps = 30;
  const truncated = events.length > maxSteps;
  const stepsToAnalyze = truncated ? events.slice(0, maxSteps) : events;
  const prompt = buildPrompt(stepsToAnalyze, startUrl);
  const model = 'qwen3:4b';

  const result = await ollamaRequest({
    model,
    prompt,
    stream: false,
    options: { num_predict: 4096, temperature: 0.1 },
  });

  const text = result.response || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { enriched_steps: [], summary: 'AI returned unparseable response', warnings: [text.slice(0, 500)], raw: text };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.enriched_steps)) {
      parsed.enriched_steps = [];
    }
    parsed.raw = text;
    parsed.truncated = truncated;
    return parsed;
  } catch (e) {
    return { enriched_steps: [], summary: 'Failed to parse AI response', warnings: [e.message, text.slice(0, 500)], raw: text };
  }
}

async function checkOllama() {
  try {
    await ollamaRequest({ model: 'qwen3:4b', prompt: 'ping', stream: false, options: { num_predict: 1 } });
    return true;
  } catch {
    return false;
  }
}

module.exports = { enrichSteps, checkOllama };
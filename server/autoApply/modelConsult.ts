// MODEL CONSULT — the "understand the question" layer.
//
// The deterministic layers (intent harness → bank → concepts → fuzzy) handle
// things they were built for. Everything else used to go straight to the
// human. This layer inserts the configured LLM ONCE per cycle, batched:
// it reads each open question WITH the candidate's facts and either answers
// with a fact-grounded value or escalates to the human ("ask"). It never
// invents: every returned value is validated downstream against the field's
// options or the facts text before it can be filled.
//
// Provider-agnostic: uses the app's configured LLM (askJson). Any capable
// instruction model works — DeepSeek/Qwen/Llama/Mistral/GPT/Claude — the
// contract is strict JSON, temperature 0.

import { askJson } from '../llm/askJson.js';
import { hasApiKeyConfigured } from '../llm/apiKeyGuard.js';

export interface ConsultField {
  ref: string;
  label: string;
  kind: string;
  required: boolean;
  options: string[];
}

export interface ConsultDecision {
  ref: string;
  action: 'answer' | 'ask' | 'skip';
  value?: string;
  reason?: string;
}

/** Local option matcher (mirrors agentDecision.optionKeys — kept local to
 *  avoid a module cycle; options comparison is intentionally tolerant). */
function optionKey(value: string): string[] {
  const v = String(value || '').toLowerCase().trim();
  const base = v.replace(/[^a-z0-9]/g, '');
  const paren = (v.match(/\(([^)]+)\)/) || ['', ''])[1].replace(/[^a-z0-9]/g, '');
  return [base, paren].filter(Boolean);
}

export function matchesOption(value: string, options: string[]): boolean {
  const wanted = optionKey(value);
  if (!wanted.length) return false;
  return options.some((o) => {
    const keys = optionKey(o);
    return keys.some((k) => wanted.some((w) => k === w || k.includes(w) || w.includes(k)));
  });
}

export function consultEnabled(): boolean {
  // Explicit override first (tests / ops), then the standard key gate.
  if (process.env.AUTO_APPLY_MODEL_CONSULT === '1') return true;
  if (process.env.AUTO_APPLY_MODEL_CONSULT === '0') return false;
  return hasApiKeyConfigured();
}

/** One batched consult call for up to `maxFields` open questions. */
export async function consultModelForFields(
  facts: string,
  fields: ConsultField[],
  maxFields = 10
): Promise<ConsultDecision[]> {
  const chosen = fields.slice(0, maxFields);
  if (!chosen.length || !consultEnabled()) return [];

  const questions = chosen
    .map(
      (f, i) =>
        `[${i}] label="${f.label}" type=${f.kind}${f.required ? ' required' : ''}${
          f.options.length ? ` options=${JSON.stringify(f.options.slice(0, 30))}` : ''
        }`
    )
    .join('\n');

  const prompt = `You are completing a REAL job application AS the candidate. For each question, decide the best answer USING ONLY the candidate facts below.

RULES:
- NEVER invent, guess or generalise a value that is not in the facts. If the facts do not clearly contain an answer, action must be "ask" (the human will answer in chat).
- Questions about OTHER PEOPLE (referrer, emergency contact, manager, references), legal consent, or unverifiable claims → "ask".
- Choice questions: pick EXACTLY one of the listed options (copy its text verbatim).
- Salary/notice/availability questions: use the candidate's stated values from the facts; if the field needs a plain number, give the number implied by the facts (e.g. a range → its lower bound).
- Be decisive when the facts clearly contain the answer; escalate otherwise.

CANDIDATE FACTS:
${facts}

QUESTIONS:
${questions}

Return valid JSON only — no markdown:
{"decisions":[{"index":0,"action":"answer"|"ask"|"skip","value":"...","reason":"..."}]}`;

  try {
    const parsed = await askJson<any>(prompt, { temperature: 0 });
    const list = Array.isArray(parsed?.decisions) ? parsed.decisions : [];
    const out: ConsultDecision[] = [];
    for (const d of list) {
      const idx = Number(d?.index);
      if (!Number.isFinite(idx) || idx < 0 || idx >= chosen.length) continue;
      const action = d?.action === 'answer' || d?.action === 'skip' ? d.action : 'ask';
      out.push({
        ref: chosen[idx].ref,
        action,
        value: typeof d?.value === 'string' ? d.value : undefined,
        reason: typeof d?.reason === 'string' ? d.reason.slice(0, 160) : undefined,
      });
    }
    return out;
  } catch (err: any) {
    // Fail-open to the human ask path — consult is best-effort, never a blocker.
    console.warn(`[consult] model consult failed: ${String(err?.message || err).slice(0, 140)}`);
    return [];
  }
}

// Robust JSON extraction from LLM completions.
//
// Reasoning models (minimax-m3's <thinking>…</thinking>, DeepSeek-R1-style
// chains) and fence-happy models wrap the requested JSON with prose,
// markdown fences, or a thinking block. Plain JSON.parse() then crashes
// ("Unexpected token '<'"). This helper strips the noise and parses the
// FIRST balanced {...} object — deterministic, no LLM, no guessing.

export function extractJsonObject(raw: string): any {
  let text = String(raw || '').trim();

  // 1. Strip markdown fences (```json ... ``` / ``` ... ```).
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/m, '').trim();

  // 2. Strip reasoning blocks (minimax/DeepSeek style).
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ').trim();

  // 3. Cut everything before the first '{' and after the last '}'.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error(`No JSON object found in the AI response: ${String(raw || '').slice(0, 200)}`);
  }
  const candidate = text.slice(first, last + 1);

  // 4. Balanced-brace safety: if the naive slice fails, walk braces.
  try {
    return JSON.parse(candidate);
  } catch {
    let depth = 0;
    let inStr = false;
    let esc = false;
    let start = -1;
    let end = -1;
    for (let i = first; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') { if (depth === 0) start = i; depth++; }
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (start === -1 || end === -1) {
      throw new Error(`Unbalanced JSON in the AI response: ${String(raw || '').slice(0, 200)}`);
    }
    return JSON.parse(text.slice(start, end + 1));
  }
}
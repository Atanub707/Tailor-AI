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

  // 3. Repair schema echoes: some models literally print the prompt's
  //    array notation "[...]" for arrays they couldn't fill.
  text = text.replace(/\[\s*\.\.\.\s*\]/g, '[]');

  // 4. Cut everything before the first '{' and after the last '}'.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error(`No JSON object found in the AI response: ${String(raw || '').slice(0, 200)}`);
  }
  const candidate = text.slice(first, last + 1);

  // 5. Parse; on failure repair common LLM errors (unquoted keys, trailing
  //    commas, missing commas, prose glued before/after the object) and retry.
  try {
    return JSON.parse(candidate);
  } catch (err1: any) {
    try {
      return JSON.parse(repairJsonSyntax(candidate));
    } catch (err2: any) {
      // Prose can contain braces before/inside the real JSON ("...{...}... Note: ...").
      // Walk each '{' start in document order (outer before inner) and keep the
      // FIRST slice that parses — that is the real top-level object.
      for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
        const end = firstBalancedClose(text, start);
        if (end <= start) continue;
        const sliced = text.slice(start, end + 1);
        try {
          return JSON.parse(sliced);
        } catch {
          try {
            return JSON.parse(repairJsonSyntax(sliced));
          } catch {
            /* try the next start */
          }
        }
      }
      throw new Error(
        `AI JSON is still invalid after repair: ${String(err1?.message || err1).slice(0, 160)}`,
      );
    }
  }
}

/**
 * Index of the '}' that closes the object opened at `from` (string-aware).
 * A depth-0 close is found without crossing back through the opener.
 */
function firstBalancedClose(text: string, from: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return text.length - 1;
}

/** Repair the most common LLM JSON syntax errors:
 *  1. unquoted member keys — `{ name: "x" }` -> `{"name":"x"}`  (string-aware)
 *  2. trailing commas — `[1, 2, ]` / `{"a": 1, }` -> `[1, 2]` / `{"a": 1}`
 *  3. missing commas between members — `"a": 1 "b": 2` -> `"a": 1, "b": 2`
 * Passes 2-3 are textual (a literal ',}' or 'val "key":' inside a CV string
 * is rare); pass 1 never touches inside strings. */
export function repairJsonSyntax(raw: string): string {
  let text = String(raw || '');

  // Pass 1: quote unquoted keys — scan outside strings only.
  //   { name: "x" }  ->  { "name": "x" }
  let out = '';
  let inStr = false;
  let esc = false;
  const s = text;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    // at '{' or ',' (outside strings): optional ws + identifier + ws + ':'
    if (ch === '{' || ch === ',') {
      out += ch;
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(s.slice(j));
      if (m) {
        const a = j + m[0].length;
        let q = a;
        while (q < s.length && /\s/.test(s[q])) q++;
        if (s[q] === ':') {
          out += '"' + m[0] + '"';
          i = a - 1;
          continue;
        }
      }
      continue;
    }
    out += ch;
  }
  text = out;

  // Pass 2: missing commas between a value end and the next member key
  //   "title": "x" "company": y   ->  "title": "x", "company": y
  text = text.replace(/("(?:[^"\\]|\\.)*"|[}\]])\s*"([A-Za-z_$][A-Za-z0-9_$]*)"\s*:/g, '$1,"$2":');

  // Pass 3: trailing commas before } or ]
  text = text.replace(/,([\s]*[\]}])/g, '$1');

  return text;
}

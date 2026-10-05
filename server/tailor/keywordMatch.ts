// keywordMatch — the ONE honest keyword-presence matcher.
//
// The old `norm().includes()` (strip ALL non-alphanumerics) turned "C++" into
// "c", which matches every word containing the letter "c" — so any keyword was
// "verified" for free and the tailoring score inflated without any tailoring.
//
// containsKeyword(text, keyword) rules:
//   - Keyword WITH symbols ("C++", "C#", "Node.js", "CI/CD"): true when the
//     raw lowercase literal appears in the text, OR the alphanumeric core
//     ("nodejs", "cicd") appears as a whole token once symbols are collapsed.
//     So "Node.js" text matches a "NodeJS" keyword and vice-versa.
//   - Keyword WITHOUT symbols ("Go", "Python", "Kubernetes"): whole-word match
//     only — "go" matches "go" but NOT "google".
//   - A 1-char core ("C++" -> "c") is never a match on its own.

export function keywordCore(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `keyword` genuinely appears in `text` (see module docs). */
export function containsKeyword(text: string, keyword: string): boolean {
  const t = String(text || '').toLowerCase();
  const k = String(keyword || '').toLowerCase().trim();
  if (!t || !k) return false;

  const core = keywordCore(k);
  const hasSymbols = /[^a-z0-9]/.test(k);
  if (hasSymbols) {
    // Literal first — "C++" needs its symbols, whatever its 1-char core.
    if (t.includes(k)) return true;
    if (core.length < 2) return false;
    // Collapse symbol runs into spaces so "node.js" -> "node js" still lets
    // the "nodejs" core match as a whole token.
    const merged = ' ' + t.replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    return new RegExp('(^| )' + escapeRegExp(core) + '( |$)').test(merged);
  }

  // Alphanumeric-only keyword: whole-word match, never a substring.
  if (core.length < 2) return false;
  return new RegExp('(^|[^a-z0-9])' + escapeRegExp(core) + '($|[^a-z0-9])').test(t);
}

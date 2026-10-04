// Auto Apply — static submission-safety scans over server/autoApply.
// The extension transport was removed with the Tailor Browser pivot; the
// remaining safety proofs are server-side.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeForComparison } from '../../server/autoApply/fillValidation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const serverAutoApplySources = (): Array<{ file: string; text: string }> => {
  const dir = path.join(root, 'server/autoApply');
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push({ file: full, text: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(dir);
  return out;
};

describe('Static submission-safety scan — server/autoApply', () => {
  it('contains no submit-capable patterns', () => {
    const forbidden: Array<{ name: string; re: RegExp }> = [
      { name: 'requestSubmit', re: /requestSubmit/ },
      { name: 'SubmitEvent', re: /SubmitEvent/ },
      { name: 'form.submit()', re: /\.submit\s*\(/ },
      { name: 'element.click()', re: /\.click\s*\(/ },
      { name: 'keydown-Enter', re: /keydown[\s\S]{0,40}Enter/i },
    ];
    for (const { file, text } of serverAutoApplySources()) {
      for (const { name, re } of forbidden) {
        expect(re.test(text), `${name} found in ${path.relative(root, file)}`).toBe(false);
      }
    }
  });

  it('keeps the frozen submission invariants', () => {
    const fillExecution = read('server/autoApply/fillExecution.ts');
    expect(fillExecution).toContain('SUBMISSION_TRANSPORT_ENABLED = false');
    expect(fillExecution).toContain('submissionPerformed: false');
    const validation = read('server/autoApply/fillValidation.ts');
    expect(validation).toContain('submissionPerformed: false');
  });
});

describe('Answer normalization (server)', () => {
  it('does not collapse materially different answers', () => {
    expect(normalizeForComparison('I led Kubernetes migrations.', 'TEXTAREA')).not.toBe(
      normalizeForComparison('I led Terraform migrations.', 'TEXTAREA'),
    );
  });
});

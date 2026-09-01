// Master CV extraction — LLM-agnostic JSON handling + honest fallback.
// The parser must survive model quirks (markdown fences, <thinking> blocks,
// prose around JSON) that previously pushed every model into the crude
// regex fallback ('Remote' location, hardcoded titles). LLM is MOCKED.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-parse-'));
process.env.TAILOR_DATA_DIR = tmpDir;

const serverSrc = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');

describe('Master CV extraction pipeline', () => {
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('the parser uses the model-agnostic askJson pipeline (not raw JSON.parse)', () => {
    // The root cause of the regression: raw JSON.parse could not read
    // fenced/wrapped model output, so every model fell into the fallback.
    expect(serverSrc).toContain("const { askJson } = await import('./server/llm/askJson.js')");
    const parseSection = serverSrc.slice(serverSrc.indexOf('async function parseCvWithLLM'), serverSrc.indexOf('async function startServer'));
    expect(parseSection).not.toContain('JSON.parse(jsonText)');
    expect(parseSection).toContain('askJson<any>(promptText');
  });

  it('the schema includes designation so the field can be extracted', () => {
    const parseSection = serverSrc.slice(serverSrc.indexOf('async function parseCvWithLLM'), serverSrc.indexOf('async function startServer'));
    expect(parseSection).toContain('designation');
    expect(parseSection).toMatch(/parsedData\.designation \|\| ''/);
  });

  it('the fallback parser never fabricates values', () => {
    const fallback = serverSrc.slice(serverSrc.indexOf('function fallbackParseCvFromText'), serverSrc.indexOf('import { ask } from'));
    for (const fake of [
      "'candidate@example.com'",
      "'+1 (555) 000-0000'",
      "'Remote'",
      "'Senior Engineer / IT Specialist'",
      "'Professional Organization'",
      "'2021 - Present'",
      "'Experienced software professional.'",
      "'Degree in Engineering / Science / Technology'",
    ]) {
      expect(fallback).not.toContain(fake);
    }
    expect(fallback).toContain('experiences: [],');
    expect(fallback).toContain('education: [],');
  });

  it('askJson survives the exact failure mode: fenced JSON output', async () => {
    const { extractJsonObject } = await import('../../server/llm/jsonExtract.js');
    const fenced = '```json\n{ "fullName": "Atanu Biswas", "designation": "Senior DevSecOps Engineer", "location": "Kolkata, India" }\n```';
    expect(extractJsonObject(fenced)).toEqual({ fullName: 'Atanu Biswas', designation: 'Senior DevSecOps Engineer', location: 'Kolkata, India' });
    const wrapped = 'Sure! Here is the result:\n{\n  "email": "atanu@example.com",\n  "phone": "+91 8420205661"\n}';
    expect(extractJsonObject(wrapped)).toEqual({ email: 'atanu@example.com', phone: '+91 8420205661' });
  });
});
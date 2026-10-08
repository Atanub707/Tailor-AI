// Auto Apply (Experimental) — isolated router. server.ts only mounts this;
// all logic lives in server/autoApply. Disabled flag → the endpoint does not
// exist (404), so production behavior is untouched.

import { Router } from 'express';
import { autoApplyEnabled, runAutoApplyDryRun, AutoApplyError } from './autoApplyService.js';
import { getCurrentUserId, getDb } from '../storage/fileStorage.js';
import {
  answerBankConfigFromEnv,
  ensureAnswerBankSchema,
  listAnswers,
  isPendingQuestion,
  upsertAnswer,
  updateAnswer,
  deleteAnswer,
} from './answerBank/answerBankStore.js';
import { answerQuestionForJob } from './answerBank/answerBankService.js';
import { answerMatchesOptions } from './agentDecision.js';
import { resumeAttachmentFilename } from '../applicationEngine/resumeNaming.js';
import { getAttempt } from '../applicationEngine/executionStore.js';
import { getEventTypesForAttempt, getEventsForAttempt } from '../applicationExperience/applicationEvents.js';
import { buildVerificationOutcome, latestVerificationEvent, summarizeVerification } from './fillVerification.js';
import { getPlanById } from '../applicationEngine/engine.js';
import { getPackageById } from '../applicationPackage/packageStore.js';
import type { AnswerType, AnswerSensitivity } from './answerBank/answerBankTypes.js';

/** Proactive question catalog (Section 8) — used to seed the bank before any
 *  application. Nothing is stored until the user saves an answer. */
const VALID_ANSWER_TYPES = new Set(['TEXT', 'TEXTAREA', 'BOOLEAN', 'SINGLE_SELECT', 'MULTI_SELECT', 'NUMBER', 'DATE']);
const VALID_SENSITIVITY = new Set(['NORMAL', 'PERSONAL', 'SENSITIVE', 'LEGAL']);

export function createAutoApplyRouter(): Router {
  const router = Router();

  // Frontend flag read (the ONLY surface that exists when disabled).
  router.get('/status', (_req, res) => {
    res.json({
      executionTransport: process.env.AUTO_APPLY_EXECUTION_TRANSPORT === 'extension' ? 'extension' : 'tailor_browser',
      enabled: autoApplyEnabled() });
  });

  // Lever-only read-only dry run. Never submits, never fills a browser.
  router.post('/dry-run', async (req, res) => {
    if (!autoApplyEnabled()) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    try {
      const jobId = typeof req.body?.jobId === 'string' ? req.body.jobId : '';
      const result = await runAutoApplyDryRun(jobId);
      res.json(result);
    } catch (err: any) {
      if (err instanceof AutoApplyError) {
        const status = err.code === 'UNAUTHENTICATED' ? 401 : err.code === 'INVALID_JOB_ID' ? 400 : 404;
        res.status(status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: 'Auto Apply dry-run failed.' });
    }
  });

  // ── Candidate Answer Bank (user-scoped; disabled by default) ───────────

  const bankEnabled = (): boolean => autoApplyEnabled() && answerBankConfigFromEnv().enabled;
  const requireUser = (res: any): string | null => {
    const userId = getCurrentUserId();
    if (!userId) {
      res.status(401).json({ error: 'Not signed in.' });
      return null;
    }
    return userId;
  };

  router.get('/answer-bank', async (_req, res) => {
    if (!autoApplyEnabled()) return void res.status(404).json({ error: 'Not found.' });
    const userId = requireUser(res);
    if (!userId) return;
    if (!answerBankConfigFromEnv().enabled) return void res.json({ enabled: false, answers: [] });
    ensureAnswerBankSchema();
    // Seed Lever's real question catalog as PENDING (idempotent): the user can
    // pre-answer everything Lever commonly asks, including voluntary EEO.
    try {
      const { seedLeverCatalog } = await import('./answerBank/leverQuestions.js');
      seedLeverCatalog(userId);
    } catch { /* seeding is best-effort */ }
    const answers = listAnswers(userId);
    res.json({ enabled: true, answers, pending: answers.filter(isPendingQuestion) });
  });


  router.post('/answer-bank', (req, res) => {
    if (!bankEnabled()) return void res.status(404).json({ error: 'Not found.' });
    const userId = requireUser(res);
    if (!userId) return;
    const body = req.body || {};
    const question = typeof body.canonicalQuestion === 'string' ? body.canonicalQuestion.trim() : '';
    const answer = body.answer;
    const validAnswer = typeof answer === 'string' || typeof answer === 'number' || typeof answer === 'boolean' || Array.isArray(answer);
    if (!question || question.length > 500 || !validAnswer) {
      return void res.status(400).json({ error: 'A question and an answer value are required.' });
    }
    const answerType = VALID_ANSWER_TYPES.has(String(body.answerType)) ? (String(body.answerType) as AnswerType) : 'TEXT';
    const sensitivity = VALID_SENSITIVITY.has(String(body.sensitivity)) ? (String(body.sensitivity) as AnswerSensitivity) : 'NORMAL';
    const record = upsertAnswer(userId, {
      canonicalQuestion: question,
      canonicalKey: typeof body.canonicalKey === 'string' && body.canonicalKey ? body.canonicalKey : undefined,
      questionCategory: typeof body.questionCategory === 'string' ? body.questionCategory : undefined,
      answerType,
      answerValue: answer,
      source: 'USER_PROVIDED',
      verificationStatus: 'VERIFIED',
      sensitivity,
      reusable: body.reusable !== false,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined,
    });
    res.json({ answer: record });
  });

  router.patch('/answer-bank/:id', (req, res) => {
    if (!bankEnabled()) return void res.status(404).json({ error: 'Not found.' });
    const userId = requireUser(res);
    if (!userId) return;
    const body = req.body || {};
    const patch: Parameters<typeof updateAnswer>[2] = {};
    if (body.answer !== undefined) patch.answerValue = body.answer;
    if (typeof body.reusable === 'boolean') patch.reusable = body.reusable;
    if (body.verificationStatus === 'VERIFIED' || body.verificationStatus === 'STALE' || body.verificationStatus === 'REVIEW_REQUIRED') {
      patch.verificationStatus = body.verificationStatus;
    }
    if (typeof body.sensitivity === 'string' && VALID_SENSITIVITY.has(body.sensitivity)) patch.sensitivity = body.sensitivity as AnswerSensitivity;
    if (body.expiresAt === null || typeof body.expiresAt === 'string') patch.expiresAt = body.expiresAt ?? undefined;
    const updated = updateAnswer(userId, req.params.id, patch);
    if (!updated) return void res.status(404).json({ error: 'Answer not found.' });
    res.json({ answer: updated });
  });

  router.delete('/answer-bank/:id', (req, res) => {
    if (!bankEnabled()) return void res.status(404).json({ error: 'Not found.' });
    const userId = requireUser(res);
    if (!userId) return;
    const deleted = deleteAnswer(userId, req.params.id);
    if (!deleted) return void res.status(404).json({ error: 'Answer not found.' });
    res.json({ deleted: true });
  });

  // Question learning: answer a missing question once; optional reuse.
  router.post('/answer-bank/learn', (req, res) => {
    if (!bankEnabled()) return void res.status(404).json({ error: 'Not found.' });
    const userId = requireUser(res);
    if (!userId) return;
    const body = req.body || {};
    const jobId = typeof body.jobId === 'string' ? body.jobId : '';
    const question = typeof body.question === 'string' ? body.question : '';
    const answer = body.answer;
    if (!jobId || !question || typeof answer !== 'string' || !answer.trim()) {
      return void res.status(400).json({ error: 'jobId, question and answer are required.' });
    }
    // Option-constrained questions: never persist an answer the form's own
    // list can't hold (real case: "West Bengal" into a US-state dropdown).
    const expectOptions = Array.isArray(body.options) ? body.options.map(String).filter(Boolean).slice(0, 60) : [];
    if (expectOptions.length && !answerMatchesOptions(String(answer), expectOptions)) {
      return void res.json({ stored: false, reason: 'ANSWER_NOT_IN_OPTIONS', options: expectOptions });
    }
    const result = answerQuestionForJob(userId, {
      jobId,
      question,
      answer,
      answerType: VALID_ANSWER_TYPES.has(String(body.answerType)) ? (String(body.answerType) as AnswerType) : undefined,
      questionCategory: typeof body.questionCategory === 'string' ? body.questionCategory : undefined,
      remember: body.remember !== false,
    });
    if (!result.stored && result.reason === 'JOB_NOT_FOUND') return void res.status(404).json({ error: 'Job not found.' });
    res.json(result);
  });

  // ── Fill-only execution — never submits ───────────────────────────────

  router.get('/fill/:attemptId/status', (req, res) => {
    if (!autoApplyEnabled()) return void res.status(404).json({ error: 'Not found.' });
    const userId = requireUser(res);
    if (!userId) return;
    const attempt = getAttempt(getDb(), userId, req.params.attemptId);
    if (!attempt) return void res.status(404).json({ error: 'Attempt not found.' });
    const eventTypes = [...getEventTypesForAttempt(getDb(), userId, attempt.id)];
    const verifyEvent = latestVerificationEvent(getEventsForAttempt(getDb(), userId, attempt.id));
    const plan = getPlanById(userId, attempt.planId);
    const pkg = getPackageById(userId, attempt.packageId);
    const outcome = verifyEvent && plan && pkg
      ? buildVerificationOutcome({
          attemptId: attempt.id,
          plan,
          metadata: verifyEvent.metadata,
          resumeExpectedHash: pkg.resumeSnapshot?.pdfHash ?? '',
          attemptStatus: attempt.status,
        })
      : null;
    res.json({
      attempt: {
        id: attempt.id,
        status: attempt.status,
        provider: attempt.provider,
        externalJobId: attempt.externalJobId,
      },
      events: eventTypes,
      eventTypes,
      verification: outcome ? summarizeVerification(outcome) : null,
      readyForUserSubmission: outcome?.readyForUserSubmission === true,
      submissionPerformed: false,
      submissionTransportEnabled: false,
    });
  });

  // Tailor Browser (desktop transport) — frozen plan handoff, no companion session used.
  // Reuses the SAME readiness/freeze/attempt machinery as the extension path.
  router.post('/browser/start', async (req, res) => {
    if (!autoApplyEnabled()) return void res.status(404).json({ error: 'Not found.' });
    const userId = requireUser(res);
    if (!userId) return;
    const jobId = typeof req.body?.jobId === 'string' ? req.body.jobId : '';
    if (!jobId) return void res.status(400).json({ error: 'INVALID_JOB_ID' });
    try {
      const { startFillExecution } = await import('./fillExecution.js');
      const result: any = await startFillExecution(jobId);
      if (result.status !== 'FILL_STARTED' && result.status !== 'USER_ACTION_REQUIRED') {
        return res.json(result);
      }
      const attempt = getAttempt(getDb(), userId, result.attemptId);
      if (!attempt) return void res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
      const plan = getPlanById(userId, attempt.planId);
      const pkg = getPackageById(userId, attempt.packageId);
      if (!plan || !pkg) return void res.status(404).json({ error: 'BINDINGS_MISSING' });
      const rawUrl = String(plan.inspection?.url || plan.target?.applyUrl || '');
      const applyUrl = /^https:\/\/jobs\.lever\.co\/.+\/apply$/.test(rawUrl) ? rawUrl : rawUrl.replace(/\/+$/, '') + '/apply';
      const fields = (plan.mappedFields || [])
        .filter((f) => f.value !== undefined && f.value !== null)
        .map((f) => ({
          providerFieldId: f.providerFieldId,
          label: f.label,
          type: f.type,
          required: !!f.required,
          approvedValue: typeof f.value === 'number' ? String(f.value) : f.value,
        }))
        .slice(0, 120);
      const resumeMeta = pkg.resumeSnapshot?.pdfHash
        ? {
            url: `/api/auto-apply/fill/${result.attemptId}/resume`,
            sha256: pkg.resumeSnapshot.pdfHash,
            filename: resumeAttachmentFilename(pkg),
            mimeType: 'application/pdf',
          }
        : null;
      return res.json({
        status: 'BROWSER_READY',
        attemptId: result.attemptId,
        userId,
        checkpoint: Array.isArray(result.blockers) && result.blockers.length ? result.blockers[0] : null,
        plan: {
          provider: 'lever',
          attemptId: result.attemptId,
          url: applyUrl,
          postingId: plan.target?.externalJobId || '',
          company: plan.target?.company || '',
          title: plan.target?.title || '',
          requirementsFingerprint: plan.requirementsFingerprint || '',
          fields,
          resume: resumeMeta,
        },
      });
    } catch (err: any) {
      if (err instanceof AutoApplyError) {
        return void res.status(err.code === 'UNAUTHENTICATED' ? 401 : 404).json({ error: err.message, code: err.code });
      }
      return void res.status(500).json({ error: 'BROWSER_START_FAILED' });
    }
  });

  // Exact frozen resume bytes for Tailor Browser (web-session auth; validated PDF + size).
  router.get('/fill/:attemptId/resume', async (req, res) => {
    if (!autoApplyEnabled()) return void res.status(404).json({ error: 'Not found.' });
    const userId = requireUser(res);
    if (!userId) return;
    const attempt = getAttempt(getDb(), userId, req.params.attemptId);
    if (!attempt) return void res.status(404).json({ error: 'Attempt not found.' });
    const pkg = getPackageById(userId, attempt.packageId);
    const hash = pkg?.resumeSnapshot?.pdfHash;
    if (!hash) return void res.status(404).json({ error: 'RESUME_ARTIFACT_MISSING' });
    try {
      const { readPdfArtifact } = await import('../applicationPackage/artifactStore.js');
      const bytes = readPdfArtifact(hash);
      if (!bytes.length) return void res.status(404).json({ error: 'ARTIFACT_MISSING' });
      if (bytes.length > 5 * 1024 * 1024) return void res.status(413).json({ error: 'ARTIFACT_TOO_LARGE' });
      if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return void res.status(422).json({ error: 'ARTIFACT_INVALID' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${resumeAttachmentFilename(pkg)}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return void res.send(bytes);
    } catch {
      return void res.status(500).json({ error: 'RESUME_READ_FAILED' });
    }
  });

  // Phase 7/10/12 — REAL, value-free execution telemetry for the live inspector.
  // Actual extension events + read-back statuses; no field VALUES ever leave the DB.
  router.get('/:attemptId/events', (req, res) => {
    if (!autoApplyEnabled()) return void res.status(404).json({ error: 'Not found.' });
    const userId = requireUser(res);
    if (!userId) return;
    const attempt = getAttempt(getDb(), userId, req.params.attemptId);
    if (!attempt) return void res.status(404).json({ error: 'Attempt not found.' });
    const all = getEventsForAttempt(getDb(), userId, attempt.id);
    const events = all.slice(-40).map((e) => ({
      eventType: e.eventType,
      reasonCode: e.reasonCode || null,
      createdAt: e.createdAt,
    }));
    const verifyEvent = latestVerificationEvent(all) as { metadata?: Record<string, unknown> } | undefined;
    const plan = getPlanById(userId, attempt.planId);
    const statuses = String(verifyEvent?.metadata?.statuses || '');
    const prettify = (id: string) => String(id || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const fields = plan && statuses
      ? plan.mappedFields
          .map((f, i) => ({ name: prettify((f as { providerFieldId?: string }).providerFieldId || `field ${i + 1}`), status: statuses[i] || '' }))
          .filter((f) => f.status)
          .slice(0, 40)
      : [];
    res.json({
      attempt: { id: attempt.id, status: attempt.status, provider: attempt.provider, externalJobId: attempt.externalJobId },
      events,
      fields,
      readyForUserSubmission: attempt.status === 'READY_FOR_USER_SUBMISSION',
    });
  });

  return router;
}

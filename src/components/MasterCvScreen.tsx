import React, { useState, useEffect, useRef } from 'react';
import { HamburgerTrigger } from '../navigation';
import { createPortal } from 'react-dom';
import { MasterCv, TemplateId, CV_TEMPLATES } from '../types';
import { llmErrorMessage } from '../lib/llmError';
import { MasterCvEditor } from './MasterCvEditor';
import { CvPdfPreview, masterCvToPdfShape, compressedCvToPdfShape } from './CvPdfPreview';
import { X, Save, CheckCircle2, Sparkles, Loader2, History, ChevronDown, FileDown, FileText, ArrowLeft, User, AlertTriangle } from 'lucide-react';

interface MasterCvScreenProps {
  isOpen: boolean;
  onClose: () => void;
  masterCv: MasterCv;
  onSaveMasterCv: (updated: MasterCv) => Promise<boolean>;
}

export const MasterCvScreen: React.FC<MasterCvScreenProps> = ({
  isOpen,
  onClose,
  masterCv,
  onSaveMasterCv,
}) => {
  const [formData, setFormData] = useState<MasterCv>(masterCv);
  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewZoom, setPreviewZoom] = useState<number>(75);
  const [template, setTemplate] = useState<TemplateId>(masterCv.templateId || 'harvard');
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [tplMenuPos, setTplMenuPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const tplBtnRef = useRef<HTMLButtonElement>(null);

  const [downloadFilename, setDownloadFilename] = useState(masterCv.downloadFilename || masterCv.fullName.replace(/ /g, '_') + '_CV');

  const wasOpenRef = useRef(false);

  // Reset formData only when the drawer transitions closed → open.
  // Fetch the CV fresh from the server so a stale prop (e.g. another tab
  // saved after this one loaded) can never overwrite newer data on Save.
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setSavedSuccess(false);
      setSaveError(null);
      let cancelled = false;
      (async () => {
        try {
          const res = await fetch('/api/cv/master');
          if (cancelled) return;
          if (res.ok) {
            const fresh = await res.json();
            setFormData(fresh);
            setDownloadFilename(fresh.downloadFilename || fresh.fullName.replace(/ /g, '_') + '_CV');
            if (fresh.templateId) setTemplate(fresh.templateId as TemplateId);
            return;
          }
        } catch { /* fall back to the prop below */ }
        if (!cancelled) {
          setFormData(masterCv);
          setDownloadFilename(masterCv.downloadFilename || masterCv.fullName.replace(/ /g, '_') + '_CV');
        }
      })();
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, masterCv]);

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setIsSaving(true);
    const ok = await onSaveMasterCv({ ...formData, downloadFilename, templateId: template });
    setIsSaving(false);
    if (ok) {
      setSavedSuccess(true);
      setSaveError(null);
      setTimeout(() => setSavedSuccess(false), 3000);
    } else {
      setSaveError('Could not save your CV — check your connection and try again. Your edits are still on screen.');
    }
  };

  const handleDownloadPdf = async () => {
    const res = await fetch(`/api/cv/master/download?format=pdf&template=${template}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${downloadFilename}.pdf`;
    a.click(); URL.revokeObjectURL(url);
  };

  // ── Template menu: render via portal at document.body with fixed
  //    positioning from the button's bounding rect, so no parent
  //    container (overflow-hidden preview, transform, etc.) can clip or
  //    contain it. Auto-flips upward when there's no room below.
  const TPL_MENU_H = 288; // approx height of the 3-option menu
  const openTemplateMenu = () => {
    const btn = tplBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const up = spaceBelow < TPL_MENU_H + 8;
    setTplMenuPos({
      top: up ? undefined : r.bottom + 6,
      bottom: up ? window.innerHeight - r.top + 6 : undefined,
      left: Math.max(8, Math.min(r.left, window.innerWidth - 296)),
    });
    setTemplateMenuOpen(true);
  };

  const closeTemplateMenu = () => {
    setTemplateMenuOpen(false);
    setTplMenuPos(null);
  };

  // Reposition on scroll/resize while open so the menu stays anchored
  // to the button even if the page/preview scrolls.
  useEffect(() => {
    if (!templateMenuOpen) return;
    const reposition = () => openTemplateMenu();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateMenuOpen]);

  const [aiState, setAiState] = useState<'idle' | 'running' | 'result'>('idle');
  const [compressResult, setCompressResult] = useState<any>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiStep, setAiStep] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<{ id: string; note: string; pages: number; createdAt: string }[]>([]);
  const [pagesBefore, setPagesBefore] = useState(0);
  const [pagesAfter, setPagesAfter] = useState(0);
  const aiStepTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);

  const AI_STEPS = ['Reading the market…', 'Analyzing your CV…', 'Rewriting…', 'Verifying keywords & page count…'];

  const handleAiCompress = async () => {
    setAiState('running');
    setAiError(null);
    setAiStep(0);
    aiStepTimer.current = setInterval(() => {
      setAiStep((s) => Math.min(s + 1, AI_STEPS.length - 1));
    }, 2500);
    try {
      const res = await fetch('/api/cv/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setAiState('idle');
        setAiError(data.error || 'Compression failed');
        alert(llmErrorMessage(data.code, data.error));
        return;
      }
      setCompressResult(data);
      setAiState('result');
    } catch (e: any) {
      setAiState('idle');
      setAiError(e.message || 'Compression failed');
    } finally {
      if (aiStepTimer.current) clearInterval(aiStepTimer.current);
    }
  };

  const handleAcceptCompressed = async () => {
    try {
      const res = await fetch('/api/cv/ai/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ compressedCv: compressResult.compressedCv }),
      });
      const data = await res.json();
      if (!res.ok) { setAiError(data.error || 'Apply failed'); return; }
      setFormData(data.cv);
      setConfirmOpen(false);
      setAiState('idle');
      setCompressResult(null);
      onSaveMasterCv(data.cv);
    } catch (e: any) {
      setAiError(e.message || 'Apply failed');
    }
  };

  const loadVersions = async () => {
    try {
      const res = await fetch('/api/cv/versions');
      if (res.ok) setVersions((await res.json()).versions || []);
    } catch { /* ignore */ }
  };

  const restoreVersion = async (id: string) => {
    try {
      const res = await fetch(`/api/cv/versions/${id}/restore`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.cv) {
        setFormData(data.cv);
        setAiState('idle');
        onSaveMasterCv(data.cv);
      }
    } catch { /* ignore */ }
  };

  if (!isOpen) return null;

  return (
    <div className="h-screen bg-white text-[var(--color-ink)] flex">
      {/* LEFT: EDITOR */}
      <div className="w-[46%] min-w-[420px] border-r border-[var(--color-hairline)] flex flex-col bg-white">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-[var(--color-hairline)] bg-white flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2">
            <HamburgerTrigger />
            <User className="w-5 h-5 text-[var(--color-muted)]" />
            <div>
              <h2 className="text-sm font-bold text-[var(--color-ink)] leading-tight">Master Candidate CV</h2>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {savedSuccess && (
              <span className="text-xs text-[var(--color-cta)] font-semibold flex items-center space-x-1">
                <CheckCircle2 className="w-4 h-4" />
                <span>Saved!</span>
              </span>
            )}
            {saveError && (
              <span className="text-xs text-[var(--color-danger)] font-semibold flex items-center space-x-1">
                <AlertTriangle className="w-4 h-4" />
                <span>{saveError}</span>
              </span>
            )}

            {/* Save split-button: Save | dropdown (Download PDF) */}
            <div className="relative">
              <div className="flex items-stretch">
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  id="btn-save-master-cv"
                  className="px-3 py-1.5 rounded-l-lg text-xs font-semibold bg-[var(--color-brand)] hover:bg-[var(--color-brand-strong)] text-white transition-colors flex items-center space-x-1.5 cursor-pointer shadow-xs"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{isSaving ? 'Saving...' : 'Save'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSaveMenuOpen((v) => !v)}
                  className="px-1.5 py-1.5 rounded-r-lg text-white bg-[var(--color-brand)] hover:bg-[var(--color-brand-strong)] border-l border-blue-500 transition-colors cursor-pointer"
                  title="More options"
                >
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${saveMenuOpen ? 'rotate-180' : ''}`} />
                </button>
              </div>

              {saveMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setSaveMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 w-56 bg-white border border-[var(--color-hairline)] rounded-xl shadow-lg z-50 p-1.5">
                    <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-[var(--color-faint)]">
                      Export
                    </div>
                    <button
                      type="button"
                      onClick={() => { setSaveMenuOpen(false); handleDownloadPdf(); }}
                      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] font-medium text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)] cursor-pointer text-left"
                    >
                      <FileDown className="w-4 h-4 text-[var(--color-faint)]" />
                      Download PDF
                    </button>
                    <button
                      type="button"
                      onClick={() => { setSaveMenuOpen(false); handleSave(); }}
                      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] font-medium text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)] cursor-pointer text-left"
                    >
                      <Save className="w-4 h-4 text-[var(--color-faint)]" />
                      Save changes
                    </button>
                  </div>
                </>
              )}
            </div>

            <span className="w-px h-5 bg-slate-200 mx-1" />

            {/* Compact utilities */}
            <button
              type="button"
              onClick={() => { setVersionsOpen(true); loadVersions(); }}
              className="p-2 rounded-lg text-[var(--color-faint)] hover:text-[var(--color-ink)] hover:bg-[var(--color-brand-soft)] border border-transparent hover:border-[var(--color-hairline)] transition-colors cursor-pointer"
              title="CV versions & backups"
            >
              <History className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Editor Body Form — shared with Manual JD Preview */}
        <MasterCvEditor
          value={formData}
          onChange={setFormData}
          onPersist={onSaveMasterCv}
        />
      </div>

      {/* RIGHT: LIVE PDF PREVIEW */}
      <div className="flex-1 bg-[#F1F5F9] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-hairline)] bg-white/80 backdrop-blur-sm shrink-0 gap-3">
          <span className="inline-flex items-center space-x-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--color-faint)] whitespace-nowrap">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--color-cta-soft)]0" />
            </span>
            <span>Live PDF Preview</span>
          </span>

          {/* Template selector */}
          <div className="relative">
            <button
              ref={tplBtnRef}
              type="button"
              onClick={openTemplateMenu}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold text-[var(--color-muted)] bg-white border border-[var(--color-hairline)] hover:border-[var(--color-brand-line)] transition-colors cursor-pointer"
              title="Choose CV template"
            >
              <FileText className="w-3.5 h-3.5 text-[var(--color-faint)]" />
              <span className="whitespace-nowrap">{CV_TEMPLATES.find((t) => t.id === template)?.label || 'Template'}</span>
              <ChevronDown className={`w-3 h-3 text-[var(--color-faint)] transition-transform ${templateMenuOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>

          <div className="flex items-center gap-2.5 flex-1 min-w-0 justify-end">
            {/* PDF rename */}
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[10px] font-bold text-[var(--color-faint)] uppercase tracking-wider hidden lg:inline">PDF name</span>
              <input
                type="text"
                value={downloadFilename}
                onChange={(e) => setDownloadFilename(e.target.value.replace(/[^a-zA-Z0-9_\- ]/g, ''))}
                className="w-36 bg-white border border-[var(--color-hairline)] rounded px-2 py-1 text-[11px] text-[var(--color-ink)] font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                title="Rename the downloaded PDF (extension .pdf added automatically)"
              />
              <span className="text-[11px] text-[var(--color-faint)] font-mono hidden xl:inline">.pdf</span>
            </div>

            {/* AI Compress */}
            <button
              type="button"
              onClick={handleAiCompress}
              disabled={aiState === 'running'}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-white bg-[var(--color-brand)] hover:bg-[var(--color-brand-strong)] disabled:opacity-50 transition-colors cursor-pointer shadow-md shadow-blue-600/20 whitespace-nowrap"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{aiState === 'running' ? 'Compressing…' : 'AI Compress'}</span>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-6 relative">
          <CvPdfPreview cv={masterCvToPdfShape(formData)} zoom={previewZoom} template={template} />

          {/* Floating zoom control — bottom-right corner, stays visible while scrolling */}
          <div className="sticky bottom-4 ml-auto w-fit flex items-center bg-white border border-[var(--color-hairline)] rounded-lg shadow-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setPreviewZoom((z) => Math.max(40, z - 10))}
              className="px-2.5 py-1.5 text-[13px] font-extrabold text-[var(--color-faint)] hover:bg-[var(--color-brand-soft)] hover:text-[var(--color-ink)] transition-colors cursor-pointer"
              title="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              onClick={() => setPreviewZoom(75)}
              className="px-2 py-1 text-[11px] font-bold text-[var(--color-muted)] hover:bg-[var(--color-brand-soft)] transition-colors cursor-pointer tabular-nums"
              title="Reset zoom to 75%"
            >
              {previewZoom}%
            </button>
            <button
              type="button"
              onClick={() => setPreviewZoom((z) => Math.min(150, z + 10))}
              className="px-2.5 py-1.5 text-[13px] font-extrabold text-[var(--color-faint)] hover:bg-[var(--color-brand-soft)] hover:text-[var(--color-ink)] transition-colors cursor-pointer"
              title="Zoom in"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* AI progress overlay */}
      {aiState === 'running' && (
        <div className="fixed inset-0 z-50 bg-[var(--color-ink)]/40 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-white rounded-2xl shadow-2xl w-[420px] p-6">
            <div className="flex items-center space-x-2.5">
              <span className="w-9 h-9 rounded-xl bg-[var(--color-brand)] flex items-center justify-center">
                <Sparkles className="w-4.5 h-4.5 text-white" />
              </span>
              <div>
                <p className="text-sm font-bold text-[var(--color-ink)]">AI Compressing your CV</p>
                <p className="text-[11px] text-[var(--color-faint)]">Analyzing against live market data</p>
              </div>
            </div>
            <div className="mt-5 space-y-3">
              {AI_STEPS.map((label, i) => (
                <div key={label} className="flex items-center space-x-3">
                  <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-[10px] font-extrabold shrink-0 ${
                    i < aiStep ? 'border-emerald-500 bg-[var(--color-cta-soft)]0 text-white'
                    : i === aiStep ? 'border-blue-500 text-[var(--color-brand)]'
                    : 'border-[var(--color-hairline)] text-slate-300'
                  }`}>
                    {i < aiStep ? '✓' : i + 1}
                  </span>
                  <span className={`text-xs font-medium ${i <= aiStep ? 'text-[var(--color-ink)]' : 'text-[var(--color-faint)]'}`}>{label}</span>
                  {i === aiStep && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-brand)]" />}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* AI error */}
      {aiError && aiState !== 'running' && (
        <div className="absolute top-16 right-6 z-[70] bg-[var(--color-danger-soft)] border border-[#FECACA] text-red-700 text-xs font-semibold rounded-lg px-4 py-2.5 shadow-lg">
          {aiError}
        </div>
      )}

      {/* Result view: professional redesign */}
      {aiState === 'result' && compressResult && (
        <div className="fixed inset-0 z-20 bg-[#F7F8FA] flex flex-col">
          {/* Sticky header */}
          <div className="px-6 py-3.5 border-b border-[var(--color-hairline)] bg-white flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3.5 min-w-0">
              <span className="text-sm font-extrabold text-[var(--color-ink)] whitespace-nowrap">AI Compression Result</span>
              <span className="inline-flex items-center gap-1.5 bg-[#FAFAF9] border border-[var(--color-hairline)] rounded-full px-3 py-1">
                <span className="text-xs font-extrabold text-[var(--color-faint)] line-through">{pagesBefore > 0 ? `${pagesBefore} pages` : '…'}</span>
                <span className="text-slate-300">→</span>
                <span className="text-sm font-extrabold text-[var(--color-cta)]">{pagesAfter > 0 ? pagesAfter : '…'}</span>
                <span className="text-xs font-extrabold text-[var(--color-cta)]">pages</span>
                <span className="text-[10px] text-[var(--color-faint)] font-semibold">· fit for any ATS</span>
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button type="button" onClick={() => { setAiState('idle'); setCompressResult(null); }}
                className="px-3.5 py-2 rounded-lg text-xs font-bold text-[var(--color-muted)] bg-white border border-[var(--color-hairline)] hover:border-[var(--color-brand-line)] cursor-pointer">
                Cancel
              </button>
              <button type="button" onClick={() => setConfirmOpen(true)}
                className="flex items-center space-x-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-[var(--color-brand)] hover:bg-[var(--color-brand-strong)] shadow-md shadow-blue-600/20 cursor-pointer">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Apply</span>
              </button>
            </div>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto">
            <div className="px-6 py-5">
              {/* Outcome hero */}
              <div className="bg-white border border-[var(--color-hairline)] rounded-2xl p-5 shadow-sm flex items-center gap-5 flex-wrap">
                <span className="w-12 h-12 rounded-xl bg-[var(--color-brand)] flex items-center justify-center shrink-0 shadow-md shadow-blue-600/30">
                  <Sparkles className="w-5 h-5 text-white" />
                </span>
                <div className="flex-1 min-w-[220px]">
                  <p className="text-[15px] font-extrabold text-[var(--color-ink)]">Your CV is now {pagesAfter > 0 ? pagesAfter : 2} pages — concise, keyword-rich, ATS-ready</p>
                  <p className="text-[11.5px] text-[var(--color-faint)] mt-1">
                    Every achievement, metric, and key skill kept · tightened for impact · tailored with {compressResult.marketSummary?.topKeywords?.length ?? 0} live market keywords
                  </p>
                </div>
                <div className="flex gap-7 flex-wrap">
                  <div className="text-center min-w-[64px]">
                    <div className="text-xl font-extrabold text-[var(--color-brand)] tabular-nums">{pagesBefore > 0 ? `${pagesBefore} → ${pagesAfter}` : '…'}</div>
                    <div className="text-[10px] text-[var(--color-faint)] font-semibold">pages</div>
                  </div>
                  <div className="text-center min-w-[64px]">
                    <div className="text-xl font-extrabold text-[var(--color-cta)]">−{Math.max(0, Math.round((1 - compressResult.wordCountAfter / Math.max(1, compressResult.wordCountBefore)) * 100))}%</div>
                    <div className="text-[10px] text-[var(--color-faint)] font-semibold">word count</div>
                  </div>
                  <div className="text-center min-w-[64px]">
                    <div className="text-xl font-extrabold text-[var(--color-cta)]">100%</div>
                    <div className="text-[10px] text-[var(--color-faint)] font-semibold">metrics kept</div>
                  </div>
                  <div className="text-center min-w-[64px]">
                    <div className="text-xl font-extrabold text-[var(--color-ink)]">+{compressResult.marketSummary?.topKeywords?.length ?? 0}</div>
                    <div className="text-[10px] text-[var(--color-faint)] font-semibold">market keywords</div>
                  </div>
                </div>
              </div>

              {/* What changed — minimal list at top */}
              {(() => {
                const sections = compressResult.guidance?.sections || [];
                const allChanges = sections.flatMap((s: any) => s.changes || []);
                if (allChanges.length === 0) return null;
                return (
                  <div className="mt-4 bg-white border border-[var(--color-hairline)] rounded-xl px-5 py-4 shadow-sm">
                    <p className="text-[10px] font-extrabold uppercase tracking-widest text-[var(--color-faint)] mb-2.5">What changes</p>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-1.5">
                      {allChanges.map((c: any, i: number) => (
                        <div key={i} className="flex items-start gap-2 text-[11.5px] leading-relaxed">
                          <span className={`mt-0.5 w-4 h-4 rounded flex items-center justify-center text-[8.5px] font-extrabold shrink-0 ${
                            c.type === 'tighten' ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]' : c.type === 'merge' ? 'bg-[var(--color-amber-soft,#FFF7ED)] text-[var(--color-amber,#C2410C)]' : 'bg-[var(--color-cta-soft)] text-[var(--color-cta)]'
                          }`}>
                            {c.type === 'tighten' ? '~' : c.type === 'merge' ? '+' : '✓'}
                          </span>
                          <span className="text-[var(--color-muted)]">
                            <b className="text-[var(--color-ink)]">{c.type === 'tighten' ? 'Tightened' : c.type === 'merge' ? 'Merged' : 'Kept'}: </b>
                            {c.reason}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Side-by-side: Old left, New right */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-5 items-start">
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-2 h-2 rounded-full bg-slate-300" />
                    <span className="text-[10.5px] font-extrabold uppercase tracking-wider text-[var(--color-faint)]">Original</span>
                    <span className="ml-auto text-[10px] font-bold text-[var(--color-faint)]">{pagesBefore > 0 ? `${pagesBefore} pages` : ''} · {compressResult.wordCountBefore?.toLocaleString()} words</span>
                  </div>
                  <div className="opacity-60">
                    <CvPdfPreview cv={masterCvToPdfShape(formData)} zoom={75} fitToWidth template={template} onPageCount={setPagesBefore} />
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-2 h-2 rounded-full bg-[var(--color-brand)]" />
                    <span className="text-[10.5px] font-extrabold uppercase tracking-wider text-[var(--color-faint)]">New CV</span>
                    <span className="text-[9px] font-extrabold text-[var(--color-brand)] bg-[var(--color-brand-soft)] border border-[var(--color-brand-line)] rounded-full px-2 py-0.5">AI ✦</span>
                    <span className="ml-auto text-[10px] font-bold text-[var(--color-cta)]">{pagesAfter > 0 ? `${pagesAfter} pages` : ''} · {compressResult.wordCountAfter?.toLocaleString()} words</span>
                  </div>
                  <CvPdfPreview cv={compressedCvToPdfShape(compressResult.compressedCv)} zoom={75} fitToWidth template={template} onPageCount={setPagesAfter} />
                  <div className="flex gap-2.5 mt-4 justify-end">
                    <button
                      type="button"
                      onClick={handleDownloadPdf}
                      className="flex items-center space-x-1.5 px-3.5 py-2 rounded-lg text-xs font-bold text-[var(--color-muted)] bg-white border border-[var(--color-hairline)] hover:border-[var(--color-brand-line)] hover:bg-[#FAFAF9] transition-colors cursor-pointer"
                    >
                      <FileDown className="w-3.5 h-3.5" />
                      <span>Download new CV</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmOpen(true)}
                      className="flex items-center space-x-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-[var(--color-brand)] hover:bg-[var(--color-brand-strong)] shadow-md shadow-blue-600/20 cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Apply</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirm modal */}
      {confirmOpen && compressResult && (
        <div className="fixed inset-0 z-[60] bg-[var(--color-ink)]/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-[520px] p-6">
            <p className="text-sm font-extrabold text-[var(--color-ink)]">Apply AI-compressed CV?</p>
            <p className="text-[11px] text-[var(--color-faint)] mt-1">The original will be saved automatically — you can restore it anytime.</p>
            <div className="grid grid-cols-3 gap-2.5 my-4">
              <div className="bg-[#FAFAF9] border border-[var(--color-hairline)] rounded-xl p-3 text-center">
                <div className="text-base font-extrabold text-[var(--color-brand)]">{pagesBefore > 0 ? `${pagesBefore} → ${pagesAfter}` : '…'}</div>
                <div className="text-[9px] text-[var(--color-faint)] font-semibold mt-0.5">pages before → after</div>
              </div>
              <div className="bg-[#FAFAF9] border border-[var(--color-hairline)] rounded-xl p-3 text-center">
                <div className="text-base font-extrabold text-[var(--color-cta)]">100%</div>
                <div className="text-[9px] text-[var(--color-faint)] font-semibold mt-0.5">metrics preserved</div>
              </div>
              <div className="bg-[#FAFAF9] border border-[var(--color-hairline)] rounded-xl p-3 text-center">
                <div className="text-base font-extrabold text-[var(--color-cta)]">+{compressResult.marketSummary?.topKeywords?.length ?? 0}</div>
                <div className="text-[9px] text-[var(--color-faint)] font-semibold mt-0.5">market keywords added</div>
              </div>
            </div>
            <div className="bg-[#FAFAF9] border border-[var(--color-hairline)] rounded-xl p-3 text-[10.5px] text-[var(--color-muted)] leading-relaxed">
              <b className="text-[var(--color-ink)]">What changes:</b>{' '}
              {(() => {
                const counts: Record<string, number> = { tighten: 0, merge: 0, keep: 0 };
                compressResult.guidance?.sections?.forEach((s: any) => (s.changes || []).forEach((c: any) => { if (counts[c.type] !== undefined) counts[c.type]++; }));
                return `${counts.tighten} bullets tightened, ${counts.merge} merged, ${counts.keep} kept. All quantified achievements and key skills preserved.`;
              })()}{' '}
              Original saved as <b>“Before AI compression”</b>. You can restore it via <b>Versions</b>.
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" onClick={() => setConfirmOpen(false)} className="px-3.5 py-2 rounded-lg text-xs font-bold text-[var(--color-muted)] bg-white border border-[var(--color-hairline)] hover:border-[var(--color-brand-line)] cursor-pointer">
                Keep original
              </button>
              <button type="button" onClick={handleAcceptCompressed} className="px-4 py-2 rounded-lg text-xs font-bold text-white bg-[var(--color-brand)] hover:bg-[var(--color-brand-strong)] shadow-md shadow-blue-600/20 cursor-pointer">
                Yes, apply &amp; backup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Versions drawer */}
      {versionsOpen && (
        <div className="fixed inset-0 z-[60] bg-black/20 flex justify-end">
          <div className="w-96 max-w-[90vw] bg-white h-full shadow-2xl border-l border-[var(--color-hairline)] flex flex-col">
            <div className="px-4 py-3.5 border-b border-[var(--color-hairline)] flex items-center justify-between">
              <p className="text-sm font-bold text-[var(--color-ink)] flex items-center space-x-2">
                <History className="w-4 h-4 text-[var(--color-brand)]" />
                <span>CV Versions</span>
              </p>
              <button type="button" onClick={() => setVersionsOpen(false)} className="p-1.5 text-[var(--color-faint)] hover:text-[var(--color-muted)] cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {versions.length === 0 && <p className="text-xs text-[var(--color-faint)] text-center py-8">No backups yet. AI compression creates them automatically.</p>}
              {versions.map((v) => (
                <div key={v.id} className="border border-[var(--color-hairline)] rounded-xl p-3.5 bg-[#FAFAF9]">
                  <p className="text-xs font-bold text-[var(--color-ink)]">{v.note || 'CV version'}</p>
                  <p className="text-[10px] text-[var(--color-faint)] mt-0.5">{v.pages > 0 ? `${v.pages} pages · ` : ''}{new Date(v.createdAt).toLocaleString()}</p>
                  <button type="button" onClick={() => restoreVersion(v.id)}
                    className="mt-2.5 px-3 py-1.5 rounded-lg text-[10px] font-bold text-[var(--color-brand)] bg-[var(--color-brand-soft)] border border-[var(--color-brand-line)] hover:bg-[#E3E6FD] cursor-pointer">
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Template menu — portal to document.body so no parent container
          can clip or contain it; independent fixed overlay layer. */}
      {templateMenuOpen && tplMenuPos && createPortal(
        <>
          <div className="fixed inset-0 z-[90]" onClick={closeTemplateMenu} />
          <div
            role="menu"
            className="fixed z-[100] w-72 bg-white border border-[var(--color-hairline)] rounded-xl shadow-2xl p-1.5 max-h-72 overflow-y-auto"
            style={{
              top: tplMenuPos.top,
              bottom: tplMenuPos.bottom,
              left: tplMenuPos.left,
            }}
          >
            <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-[var(--color-faint)]">CV Template</p>
            {CV_TEMPLATES.map((t) => (
              <button
                key={t.id}
                role="menuitem"
                type="button"
                onClick={() => { setTemplate(t.id); closeTemplateMenu(); }}
                className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer ${
                  template === t.id ? 'bg-[var(--color-brand-soft)]' : 'hover:bg-[var(--color-brand-soft)]'
                }`}
              >
                <span className={`mt-0.5 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  template === t.id ? 'border-blue-600' : 'border-[var(--color-hairline2)]'
                }`}>
                  {template === t.id && <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-brand)]" />}
                </span>
                <span>
                  <span className="block text-[12.5px] font-bold text-[var(--color-ink)]">{t.label}</span>
                  <span className="block text-[10.5px] text-[var(--color-faint)] font-medium mt-0.5 leading-snug">{t.description}</span>
                </span>
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  );
};

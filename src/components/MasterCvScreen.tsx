import React, { useState, useEffect, useRef } from 'react';
import { HamburgerTrigger } from '../navigation';
import { createPortal } from 'react-dom';
import { MasterCv, TemplateId, CV_TEMPLATES } from '../types';
import { llmErrorMessage } from '../lib/llmError';
import { MasterCvEditor } from './MasterCvEditor';
import { CvPdfPreview, masterCvToPdfShape } from './CvPdfPreview';
import { X, Save, CheckCircle2, Loader2, History, ChevronDown, FileDown, FileText, ArrowLeft, User, AlertTriangle } from 'lucide-react';

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

  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<{ id: string; note: string; pages: number; createdAt: string }[]>([]);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);

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
        setSavedSuccess(true);
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
              onClick={handleDownloadPdf}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-[var(--color-hairline)] text-[var(--color-muted)] hover:border-[var(--color-brand-line)] hover:text-[var(--color-ink)] transition-colors cursor-pointer"
              title="Download CV as PDF"
            >
              <FileDown className="w-3.5 h-3.5" />
              <span>Download PDF</span>
            </button>
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

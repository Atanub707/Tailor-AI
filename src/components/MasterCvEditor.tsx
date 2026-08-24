import React, { useState, useRef } from 'react';
import { Sparkles, Loader2, Upload, CheckCircle2, Plus, Trash2, GripVertical, Briefcase, Code, FolderGit2, GraduationCap, Award, User, TrendingUp, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { MasterCv } from '../types';
import { PREDEFINED_ROLES, PREDEFINED_KEYWORDS } from '../constants/suggestions';
import { searchLocations } from '../lib/locations';
import { DateRangePicker } from './DateRangePicker';
import { TagInput } from './TagInput';

// The Master Candidate CV editor — the single source of truth for editing a
// CV in the Master CV screen. The Manual JD Preview reuses this EXACT
// component so both look and behave identically (the score card is the only
// extra on the Manual JD side, added outside this editor).

interface MasterCvEditorProps {
  value: MasterCv;
  onChange: (next: MasterCv) => void;
  // Optional: persist (used by the skill-gaps "Add to CV" action on the
  // Master CV screen). Manual JD passes a local-only persister.
  onPersist?: (cv: MasterCv) => Promise<boolean>;
  // Optional AI markers: when provided, items matching these lookups get a
  // labeled badge (✦ AI) — used by Manual JD to highlight AI-added content.
  aiSkillLookup?: (text: string) => boolean;
  aiBulletLookup?: (text: string) => boolean;
  // Hide the resume upload/parse banner — Manual JD Preview doesn't offer
  // resume import (the CV is already tailored); Master CV shows it.
  hideUpload?: boolean;
  // Hide the market skill-gaps panel (Master CV only; Manual JD fills gaps
  // through the tailor itself).
  hideSkillGaps?: boolean;
}

export const MasterCvEditor: React.FC<MasterCvEditorProps> = ({ value, onChange, onPersist, aiSkillLookup, aiBulletLookup, hideUpload = false, hideSkillGaps = false }) => {
  const formData = value;
  const setFormData = (next: MasterCv | ((prev: MasterCv) => MasterCv)) => {
    onChange(typeof next === 'function' ? (next as (prev: MasterCv) => MasterCv)(formData) : next);
  };

  const [masterCvLocationOptions, setMasterCvLocationOptions] = useState<string[]>([]);
  const [rawPasteText, setRawPasteText] = useState('');
  const [isParsingText, setIsParsingText] = useState(false);
  const [showPasteBox, setShowPasteBox] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [extractedFileName, setExtractedFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [skillGaps, setSkillGaps] = useState<{ skill: string; count: number; totalScored: number }[]>([]);
  const [selectedGaps, setSelectedGaps] = useState<Set<string>>(new Set());
  const [showGaps, setShowGaps] = useState(false);
  const [gapsLoading, setGapsLoading] = useState(false);
  const [gapsAddedMsg, setGapsAddedMsg] = useState<string | null>(null);

  const [summarySuggestions, setSummarySuggestions] = useState<{ label: string; text: string }[]>([]);
  const [isImprovingSummary, setIsImprovingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const fetchSkillGaps = async () => {
    setGapsLoading(true);
    try {
      const res = await fetch('/api/cv/skill-gaps');
      if (res.ok) {
        const data = await res.json();
        setSkillGaps(data.gaps || []);
      }
    } catch { /* ignore */ }
    setGapsLoading(false);
  };

  const handleAskAiSummary = async () => {
    if (!formData.summary.trim()) {
      setSummaryError('Write a brief summary first, then ask AI to improve it.');
      return;
    }
    setIsImprovingSummary(true);
    setSummaryError(null);
    setSummarySuggestions([]);
    try {
      const res = await fetch('/api/cv/improve-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: formData.summary,
          experiences: formData.experiences,
          skills: formData.skills,
          certifications: formData.certifications,
          fullName: formData.fullName,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSummarySuggestions(data.options || []);
      } else {
        const err = await res.json();
        setSummaryError(err.error || 'Failed to generate suggestions.');
      }
    } catch {
      setSummaryError('AI request failed. Please try again.');
    }
    setIsImprovingSummary(false);
  };

  const applySummarySuggestion = (text: string) => {
    setFormData({ ...formData, summary: text });
    setSummarySuggestions([]);
  };

  const toggleGap = (skill: string) => {
    setSelectedGaps((prev) => {
      const next = new Set(prev);
      if (next.has(skill)) next.delete(skill);
      else next.add(skill);
      return next;
    });
  };

  const addSelectedGapsToCv = async () => {
    if (selectedGaps.size === 0) return;
    const updated = { ...formData };
    const newSkills: string[] = Array.from(selectedGaps);
    const skillsCat = updated.skills.find((s) => s.category.toLowerCase().includes('skill') || s.category === 'Core Competencies');
    if (skillsCat) {
      const normalized = newSkills.map((s) => s.charAt(0).toUpperCase() + s.slice(1));
      const existing = new Set(skillsCat.items.map((i) => i.toLowerCase()));
      skillsCat.items = [...normalized.filter((n) => !existing.has(n.toLowerCase())), ...skillsCat.items];
    } else {
      updated.skills = [{ category: 'Core Competencies', items: newSkills.map((s) => s.charAt(0).toUpperCase() + s.slice(1)) }, ...updated.skills];
    }
    setFormData(updated);
    setSkillGaps((prev) => prev.filter((g) => !selectedGaps.has(g.skill)));
    setSelectedGaps(new Set());
    if (onPersist) await onPersist(updated);
    setGapsAddedMsg(`Added ${newSkills.length} skill${newSkills.length > 1 ? 's' : ''} and saved to profile.`);
    setTimeout(() => setGapsAddedMsg(null), 4000);
  };

  const handleParseRawText = async () => {
    if (!rawPasteText.trim()) return;
    setIsParsingText(true);
    setParseError(null);
    setExtractedFileName(null);
    try {
      const res = await fetch('/api/cv/parse-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: rawPasteText }),
      });
      if (!res.ok) {
        const text = await res.text();
        let errMsg = 'Failed to extract resume details';
        try {
          const errJson = JSON.parse(text);
          errMsg = errJson.error || errJson.message || errMsg;
        } catch {
          if (text && text.length < 300) errMsg = text;
        }
        throw new Error(errMsg);
      }
      const data = await res.json();
      if (data.success && data.cv) {
        setFormData(data.cv);
        setShowPasteBox(false);
        setRawPasteText('');
        setExtractedFileName('Pasted Raw Text');
      } else {
        setParseError(data.error || 'Failed to extract resume details');
      }
    } catch (err: any) {
      setParseError(err.message || 'Error communicating with server');
    } finally {
      setIsParsingText(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsParsingText(true);
    setParseError(null);
    setExtractedFileName(null);
    const bodyData = new FormData();
    bodyData.append('resume', file);
    try {
      const res = await fetch('/api/cv/upload-file', { method: 'POST', body: bodyData });
      if (!res.ok) {
        const text = await res.text();
        let errMsg = 'Failed to extract resume from file';
        try {
          const errJson = JSON.parse(text);
          errMsg = errJson.error || errJson.message || errMsg;
        } catch {
          if (text && text.length < 300) errMsg = text;
        }
        throw new Error(errMsg);
      }
      const data = await res.json();
      if (data.success && data.cv) {
        setFormData(data.cv);
        setExtractedFileName(file.name);
      } else {
        setParseError(data.error || 'Failed to extract resume from file');
      }
    } catch (err: any) {
      setParseError(err.message || 'Error uploading resume file');
    } finally {
      setIsParsingText(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const updateExperienceResponsibility = (expIdx: number, respIdx: number, val: string) => {
    const updated = { ...formData } as MasterCv;
    updated.experiences[expIdx].responsibilities[respIdx] = val;
    setFormData(updated);
  };
  const addExperienceResponsibility = (expIdx: number) => {
    const updated = { ...formData } as MasterCv;
    updated.experiences[expIdx].responsibilities.push('New responsibility or key achievement...');
    setFormData(updated);
  };
  const removeExperienceResponsibility = (expIdx: number, respIdx: number) => {
    const updated = { ...formData } as MasterCv;
    updated.experiences[expIdx].responsibilities.splice(respIdx, 1);
    setFormData(updated);
  };
  const addExperience = () => {
    const updated = { ...formData } as MasterCv;
    updated.experiences = [{
      id: `exp-${Date.now()}`,
      title: 'Job Title',
      company: 'Company Name',
      location: 'Remote / City, State',
      dates: '2022 - Present',
      responsibilities: ['Key responsibility or major accomplishment...'],
    }, ...updated.experiences];
    setFormData(updated);
  };
  const removeExperience = (expIdx: number) => {
    const updated = { ...formData } as MasterCv;
    updated.experiences.splice(expIdx, 1);
    setFormData(updated);
  };
  const addEducation = () => {
    const updated = { ...formData } as MasterCv;
    if (!updated.education) updated.education = [];
    updated.education = [{
      id: `edu-${Date.now()}`,
      degree: 'B.S. Computer Science',
      institution: 'University Name',
      dates: '2018 - 2022',
      details: 'Major in Software Engineering',
    }, ...updated.education];
    setFormData(updated);
  };
  const removeEducation = (eduIdx: number) => {
    const updated = { ...formData } as MasterCv;
    if (updated.education) updated.education.splice(eduIdx, 1);
    setFormData(updated);
  };
  const addSkillCategory = () => {
    const updated = { ...formData } as MasterCv;
    updated.skills = [{
      category: 'New Category',
      items: ['Skill 1', 'Skill 2'],
    }, ...(updated.skills || [])];
    setFormData(updated);
  };
  const removeSkillCategory = (skIdx: number) => {
    const updated = { ...formData } as MasterCv;
    updated.skills.splice(skIdx, 1);
    setFormData(updated);
  };
  const addProject = () => {
    const newProject = {
      id: `proj-${Date.now()}`,
      name: 'Project Name',
      description: 'Key project description, highlights, and results...',
      technologies: ['React', 'Node.js', 'TypeScript'],
      link: '',
      dates: '2023',
    };
    setFormData((prev) => ({ ...prev, projects: [newProject, ...(prev.projects || [])] }));
  };
  const removeProject = (pIdx: number) => {
    setFormData((prev) => ({ ...prev, projects: (prev.projects || []).filter((_, i) => i !== pIdx) }));
  };
  const addCertification = () => {
    const updated = { ...formData } as MasterCv;
    if (!updated.certifications) updated.certifications = [];
    updated.certifications = [{
      id: `cert-${Date.now()}`,
      name: 'AWS Certified Solutions Architect',
      issuer: 'Amazon Web Services',
      date: '2023',
      link: '',
    }, ...updated.certifications];
    setFormData(updated);
  };
  const removeCertification = (cIdx: number) => {
    const updated = { ...formData } as MasterCv;
    if (updated.certifications) updated.certifications.splice(cIdx, 1);
    setFormData(updated);
  };

  const [dragProjectIdx, setDragProjectIdx] = useState<number | null>(null);
  const [dragExpIdx, setDragExpIdx] = useState<number | null>(null);
  const [dragCertIdx, setDragCertIdx] = useState<number | null>(null);
  const handleProjectDragStart = (e: React.DragEvent, idx: number) => { setDragProjectIdx(idx); e.dataTransfer.effectAllowed = 'move'; };
  const handleProjectDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const handleProjectDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    if (dragProjectIdx === null || dragProjectIdx === targetIdx) { setDragProjectIdx(null); return; }
    setFormData((prev) => {
      const projects = [...(prev.projects || [])];
      const [moved] = projects.splice(dragProjectIdx, 1);
      projects.splice(targetIdx, 0, moved);
      return { ...prev, projects };
    });
    setDragProjectIdx(null);
  };
  const handleExpDragStart = (e: React.DragEvent, idx: number) => { setDragExpIdx(idx); e.dataTransfer.effectAllowed = 'move'; };
  const handleExpDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const handleExpDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    if (dragExpIdx === null || dragExpIdx === targetIdx) { setDragExpIdx(null); return; }
    setFormData((prev) => {
      const experiences = [...prev.experiences];
      const [moved] = experiences.splice(dragExpIdx, 1);
      experiences.splice(targetIdx, 0, moved);
      return { ...prev, experiences };
    });
    setDragExpIdx(null);
  };
  const handleCertDragStart = (e: React.DragEvent, idx: number) => { setDragCertIdx(idx); e.dataTransfer.effectAllowed = 'move'; };
  const handleCertDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const handleCertDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    if (dragCertIdx === null || dragCertIdx === targetIdx) { setDragCertIdx(null); return; }
    setFormData((prev) => {
      const certs = [...(prev.certifications || [])];
      const [moved] = certs.splice(dragCertIdx, 1);
      certs.splice(targetIdx, 0, moved);
      return { ...prev, certifications: certs };
    });
    setDragCertIdx(null);
  };

  const [dragSkillIdx, setDragSkillIdx] = useState<number | null>(null);
  const handleSkillDragStart = (e: React.DragEvent, idx: number) => { setDragSkillIdx(idx); e.dataTransfer.effectAllowed = 'move'; };
  const handleSkillDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const handleSkillDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    if (dragSkillIdx === null || dragSkillIdx === targetIdx) { setDragSkillIdx(null); return; }
    setFormData((prev) => {
      const skills = [...(prev.skills || [])];
      const [moved] = skills.splice(dragSkillIdx, 1);
      skills.splice(targetIdx, 0, moved);
      return { ...prev, skills };
    });
    setDragSkillIdx(null);
  };

  const aiMark = (fn?: (t: string) => boolean, t?: string) =>
    fn && t && fn(t) ? (
      <span className="inline-flex items-center gap-0.5 ml-1 px-1.5 py-0.5 rounded text-[9px] font-extrabold uppercase tracking-wide text-purple-700 bg-purple-100 border border-purple-200 align-middle shrink-0" title="AI-generated">✦ AI</span>
    ) : null;

  return (
    <form onSubmit={(e) => e.preventDefault()} className="flex-1 overflow-y-auto p-5 space-y-5 text-xs text-[var(--color-ink)]">
      {/* File Upload & Quick Paste Auto-Extract Banner (hidden on Manual JD) */}
      {!hideUpload && (
      <div className="bg-[var(--color-brand-soft)] border border-[var(--color-brand-line)] p-4 rounded-xl text-blue-900 space-y-3 shadow-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Sparkles className="w-4.5 h-4.5 text-[var(--color-brand)]" />
            <span className="font-bold text-xs text-blue-950">Upload & Scrape Resume (PDF, DOCX, TXT)</span>
          </div>
          <button
            type="button"
            onClick={() => setShowPasteBox(!showPasteBox)}
            className="text-xs text-[var(--color-brand)] font-semibold underline hover:text-blue-900 cursor-pointer"
          >
            {showPasteBox ? 'Hide Raw Text Box' : 'Paste Raw Text Instead'}
          </button>
        </div>
        <div className="grid grid-cols-1 gap-2">
          <input ref={fileInputRef} type="file" accept=".pdf,.docx,.doc,.txt,.md" onChange={handleFileUpload} className="hidden" id="cv-file-upload-input" />
          <label htmlFor="cv-file-upload-input" className={`border-2 border-dashed rounded-lg p-4 bg-white hover:bg-[var(--color-brand-soft)]/50 border-[var(--color-brand)] hover:border-blue-500 transition-all flex flex-col items-center justify-center cursor-pointer text-center ${isParsingText ? 'opacity-50 pointer-events-none' : ''}`}>
            {isParsingText ? (
              <div className="flex items-center space-x-2 py-1 text-[var(--color-brand)] font-bold">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>AI is reading & extracting A to Z resume details...</span>
              </div>
            ) : (
              <div className="flex flex-col items-center space-y-1">
                <Upload className="w-6 h-6 text-[var(--color-brand)] mb-1" />
                <span className="font-bold text-blue-900 text-xs">Click to upload candidate CV (PDF, DOCX, TXT)</span>
                <span className="text-[11px] text-[var(--color-brand)]">AI will automatically extract contact details, summary, work history, education, & skills into the fields below!</span>
              </div>
            )}
          </label>
        </div>
        {extractedFileName && (
          <div className="bg-[var(--color-cta-soft)] border border-[var(--color-cta-line)] p-2.5 rounded-lg flex items-center justify-between text-emerald-800 text-xs font-medium">
            <div className="flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4 text-[var(--color-cta)]" />
              <span>Successfully extracted from <strong>{extractedFileName}</strong>! All fields populated below.</span>
            </div>
          </div>
        )}
        {parseError && (
          <p className="text-xs text-[var(--color-danger)] font-semibold bg-[var(--color-danger-soft)] p-2 rounded border border-[#FECACA]">
            {parseError}
          </p>
        )}
        {showPasteBox && (
          <div className="space-y-2 pt-2 border-t border-[var(--color-brand-line)]">
            <p className="text-[11px] text-blue-800">Paste raw text from candidate's resume to parse directly:</p>
            <textarea rows={5} value={rawPasteText} onChange={(e) => setRawPasteText(e.target.value)} placeholder="Paste candidate's full resume text here..." className="w-full bg-white border border-[var(--color-brand)] rounded p-2.5 text-xs text-[var(--color-ink)] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-600" />
            <div className="flex justify-end">
              <button type="button" onClick={handleParseRawText} disabled={isParsingText || !rawPasteText.trim()} className="px-3 py-1.5 bg-[var(--color-brand)] hover:bg-[var(--color-brand-strong)] disabled:bg-blue-300 text-white font-semibold rounded text-xs flex items-center space-x-1.5 cursor-pointer shadow-xs">
                {isParsingText ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>Extracting CV Data...</span></>
                ) : (
                  <><Sparkles className="w-3.5 h-3.5" /><span>Auto-Fill Form Fields</span></>
                )}
              </button>
             </div>
           </div>
         )}
       </div>
      )}

      {/* Predefined Datalists for Master CV */}
      <datalist id="mastercv-locations">
        {masterCvLocationOptions.map((loc) => <option key={loc} value={loc} />)}
      </datalist>
      <datalist id="mastercv-roles">
        {PREDEFINED_ROLES.map((role) => <option key={role} value={role} />)}
      </datalist>
      <datalist id="mastercv-keywords">
        {PREDEFINED_KEYWORDS.map((kw) => <option key={kw} value={kw} />)}
      </datalist>

      {/* Contact Details Section */}
      <div className="bg-[#FAFAF9] p-4 rounded-lg border border-[var(--color-hairline)] space-y-3">
        <h3 className="font-bold text-[var(--color-ink)] uppercase tracking-wider text-[11px] flex items-center space-x-1.5">
          <User className="w-3.5 h-3.5 text-[var(--color-muted)]" />
          <span>Contact Information</span>
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[var(--color-muted)] font-medium mb-1">Full Name</label>
            <input type="text" value={formData.fullName} onChange={(e) => setFormData({ ...formData, fullName: e.target.value })} placeholder="e.g. Alex Johnson" className="w-full bg-white border border-[var(--color-hairline)] rounded px-2.5 py-1.5 text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-slate-900 font-medium" />
          </div>
          <div>
            <label className="block text-[var(--color-muted)] font-medium mb-1">Email Address</label>
            <input type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} placeholder="alex@example.com" className="w-full bg-white border border-[var(--color-hairline)] rounded px-2.5 py-1.5 text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-slate-900" />
          </div>
          <div>
            <label className="block text-[var(--color-muted)] font-medium mb-1">Phone Number</label>
            <input type="text" value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} placeholder="+1 (555) 000-0000" className="w-full bg-white border border-[var(--color-hairline)] rounded px-2.5 py-1.5 text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-slate-900" />
          </div>
          <div>
            <label className="block text-[var(--color-muted)] font-medium mb-1">Location</label>
            <input type="text" list="mastercv-locations" value={formData.location} onChange={(e) => {
              setFormData({ ...formData, location: e.target.value });
              const q = e.target.value.trim();
              if (q.length >= 1) searchLocations(q, 10).then((list) => setMasterCvLocationOptions(list.map((l) => l.label)));
              else setMasterCvLocationOptions([]);
            }} placeholder="City, State / Country or Remote" className="w-full bg-white border border-[var(--color-hairline)] rounded px-2.5 py-1.5 text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-slate-900" />
            <div className="flex flex-wrap gap-1 mt-1">
              {masterCvLocationOptions.slice(0, 4).map((loc) => (
                <button key={loc} type="button" onClick={() => setFormData({ ...formData, location: loc })} className="text-[10px] font-semibold text-[var(--color-brand)] bg-[var(--color-brand-soft)] border border-var(--color-hairline) rounded px-2 py-0.5 hover:bg-blue-100 cursor-pointer">{loc}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[var(--color-muted)] font-medium mb-1">Portfolio (Website)</label>
            <input type="url" value={formData.website || ''} onChange={(e) => setFormData({ ...formData, website: e.target.value })} placeholder="https://yourportfolio.com" className="w-full bg-white border border-[var(--color-hairline)] rounded px-2.5 py-1.5 text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-slate-900" />
          </div>
          <div>
            <label className="block text-[var(--color-muted)] font-medium mb-1">LinkedIn</label>
            <input type="url" value={formData.linkedin || ''} onChange={(e) => setFormData({ ...formData, linkedin: e.target.value })} placeholder="https://linkedin.com/in/yourname" className="w-full bg-white border border-[var(--color-hairline)] rounded px-2.5 py-1.5 text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-slate-900" />
          </div>
          <div>
            <label className="block text-[var(--color-muted)] font-medium mb-1">GitHub</label>
            <input type="url" value={formData.github || ''} onChange={(e) => setFormData({ ...formData, github: e.target.value })} placeholder="https://github.com/yourname" className="w-full bg-white border border-[var(--color-hairline)] rounded px-2.5 py-1.5 text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-slate-900" />
          </div>
        </div>
      </div>

      {/* Master Professional Summary */}
      <div className="bg-[#FAFAF9] p-4 rounded-lg border border-[var(--color-hairline)] space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-[var(--color-ink)] uppercase tracking-wider text-[11px]">
            Master Professional Summary
          </h3>
          <button type="button" onClick={handleAskAiSummary} disabled={isImprovingSummary} className="flex items-center space-x-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[var(--color-ink)] hover:bg-[#14113B] text-white transition-colors cursor-pointer disabled:opacity-50" title="Ask AI to improve your summary">
            {isImprovingSummary ? (<><Loader2 className="w-3 h-3 animate-spin" /><span>Analyzing...</span></>) : (<><Sparkles className="w-3 h-3" /><span>Ask AI</span></>)}
          </button>
        </div>
        <textarea rows={4} value={formData.summary} onChange={(e) => setFormData({ ...formData, summary: e.target.value })} placeholder="Candidate's comprehensive professional background summary..." className="w-full bg-white border border-[var(--color-hairline)] rounded p-2.5 text-[var(--color-ink)] leading-relaxed focus:outline-none focus:ring-1 focus:ring-slate-900" />
        {summaryError && (<p className="text-[11px] text-[var(--color-danger)] font-medium">{summaryError}</p>)}
        {summarySuggestions.length > 0 && (
          <div className="space-y-2 pt-1">
            <p className="text-[11px] font-semibold text-[var(--color-brand)] flex items-center space-x-1">
              <Sparkles className="w-3 h-3" />
              <span>AI Suggested Summaries — click one to apply:</span>
            </p>
            {summarySuggestions.map((opt, idx) => (
              <button type="button" key={idx} onClick={() => applySummarySuggestion(opt.text)} className="w-full text-left p-3 rounded-lg border border-[var(--color-brand-line)] bg-white hover:border-blue-400 hover:shadow-sm transition-all cursor-pointer group" title={`Apply "${opt.label}"`}>
                <span className="block text-[10px] font-bold text-[var(--color-brand)] uppercase tracking-wide mb-1 group-hover:underline">{opt.label}</span>
                <span className="text-xs text-[var(--color-muted)] leading-relaxed">{opt.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Work Experience History */}
      <div className="bg-[#FAFAF9] p-4 rounded-lg border border-[var(--color-hairline)] space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-[var(--color-ink)] uppercase tracking-wider text-[11px] flex items-center space-x-1.5">
            <Briefcase className="w-3.5 h-3.5 text-[var(--color-muted)]" />
            <span>Work Experience History</span>
          </h3>
          <button type="button" onClick={addExperience} className="text-[11px] font-semibold text-[var(--color-brand)] hover:text-blue-800 flex items-center space-x-1 cursor-pointer">
            <Plus className="w-3 h-3" />
            <span>Add Position</span>
          </button>
        </div>
        {formData.experiences.map((exp, expIdx) => (
          <div key={exp.id || expIdx} draggable onDragStart={(e) => handleExpDragStart(e, expIdx)} onDragOver={handleExpDragOver} onDrop={(e) => handleExpDrop(e, expIdx)} className={`bg-white p-3.5 rounded-lg border space-y-3 cursor-grab active:cursor-grabbing transition-all ${dragExpIdx === expIdx ? 'border-blue-400 ring-2 ring-blue-200 opacity-70' : 'border-[var(--color-hairline)] hover:border-[var(--color-brand-line)]'}`}>
            <div className="flex items-center justify-between pb-2 border-b border-[var(--color-hairline)]">
              <span className="font-bold text-[var(--color-muted)] text-[11px] flex items-center space-x-1.5">
                <GripVertical className="w-3.5 h-3.5 text-[var(--color-faint)]" />
                <span>Position #{expIdx + 1}</span>
              </span>
              <button type="button" onClick={() => removeExperience(expIdx)} className="text-[var(--color-faint)] hover:text-[var(--color-danger)] p-1 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="block text-[var(--color-faint)] text-[11px]">Job Title</label>
                <input type="text" list="mastercv-roles" value={exp.title} onChange={(e) => { const updated = { ...formData } as MasterCv; updated.experiences[expIdx].title = e.target.value; setFormData(updated); }} className="w-full border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)] font-bold" />
              </div>
              <div>
                <label className="block text-[var(--color-faint)] text-[11px]">Company</label>
                <input type="text" value={exp.company} onChange={(e) => { const updated = { ...formData } as MasterCv; updated.experiences[expIdx].company = e.target.value; setFormData(updated); }} className="w-full border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)]" />
              </div>
              <div>
                <label className="block text-[var(--color-faint)] text-[11px]">Location</label>
                <input type="text" value={exp.location || ''} onChange={(e) => { const updated = { ...formData } as MasterCv; updated.experiences[expIdx].location = e.target.value; setFormData(updated); }} placeholder="e.g. San Francisco, CA / Remote" className="w-full border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)]" />
              </div>
              <div>
                <label className="block text-[var(--color-faint)] text-[11px]">Dates / Period</label>
                <DateRangePicker value={exp.dates || ''} onChange={(v) => { const updated = { ...formData } as MasterCv; updated.experiences[expIdx].dates = v; setFormData(updated); }} placeholder="e.g. Jan 2021 - Present" />
              </div>
            </div>
            <div>
              <label className="block text-[var(--color-faint)] text-[11px] mb-1 font-semibold">Responsibilities & Achievements</label>
              <div className="space-y-1.5">
                {exp.responsibilities.map((resp, respIdx) => (
                  <div key={respIdx} className="flex items-center space-x-1.5">
                    <input type="text" value={resp} onChange={(e) => updateExperienceResponsibility(expIdx, respIdx, e.target.value)} className="flex-1 border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)]" />
                    {aiMark(aiBulletLookup, resp)}
                    <button type="button" onClick={() => removeExperienceResponsibility(expIdx, respIdx)} className="p-1 text-[var(--color-faint)] hover:text-[var(--color-danger)] cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => addExperienceResponsibility(expIdx)} className="mt-2 text-[11px] font-semibold text-[var(--color-brand)] hover:text-blue-800 flex items-center space-x-1 cursor-pointer">
                <Plus className="w-3 h-3" />
                <span>Add Responsibility Bullet</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Education History */}
      <div className="bg-[#FAFAF9] p-4 rounded-lg border border-[var(--color-hairline)] space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-[var(--color-ink)] uppercase tracking-wider text-[11px] flex items-center space-x-1.5">
            <GraduationCap className="w-3.5 h-3.5 text-[var(--color-muted)]" />
            <span>Education History</span>
          </h3>
          <button type="button" onClick={addEducation} className="text-[11px] font-semibold text-[var(--color-brand)] hover:text-blue-800 flex items-center space-x-1 cursor-pointer">
            <Plus className="w-3 h-3" />
            <span>Add Education</span>
          </button>
        </div>
        {(formData.education || []).map((edu, eduIdx) => (
          <div key={edu.id || eduIdx} className="bg-white p-3 rounded-lg border border-[var(--color-hairline)] space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-[var(--color-muted)] text-[11px]">Degree #{eduIdx + 1}</span>
              <button type="button" onClick={() => removeEducation(eduIdx)} className="text-[var(--color-faint)] hover:text-[var(--color-danger)] p-1 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="block text-[var(--color-faint)] text-[11px]">Degree / Qualification</label>
                <input type="text" value={edu.degree} onChange={(e) => { const updated = { ...formData } as MasterCv; updated.education[eduIdx].degree = e.target.value; setFormData(updated); }} className="w-full border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)] font-bold" />
              </div>
              <div>
                <label className="block text-[var(--color-faint)] text-[11px]">Institution / University</label>
                <input type="text" value={edu.institution} onChange={(e) => { const updated = { ...formData } as MasterCv; updated.education[eduIdx].institution = e.target.value; setFormData(updated); }} className="w-full border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)]" />
              </div>
              <div>
                <label className="block text-[var(--color-faint)] text-[11px]">Dates / Graduation Year</label>
                <DateRangePicker value={edu.dates || ''} onChange={(v) => { const updated = { ...formData } as MasterCv; updated.education[eduIdx].dates = v; setFormData(updated); }} placeholder="Pick start & end date" />
              </div>
              <div>
                <label className="block text-[var(--color-faint)] text-[11px]">Honors / Details</label>
                <input type="text" value={edu.details || ''} onChange={(e) => { const updated = { ...formData } as MasterCv; updated.education[eduIdx].details = e.target.value; setFormData(updated); }} className="w-full border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)]" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Technical Skills */}
      <div className="bg-[#FAFAF9] p-4 rounded-lg border border-[var(--color-hairline)] space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-[var(--color-ink)] uppercase tracking-wider text-[11px] flex items-center space-x-1.5">
            <Code className="w-3.5 h-3.5 text-[var(--color-muted)]" />
            <span>Technical Skills & Core Competencies</span>
          </h3>
          <button type="button" onClick={addSkillCategory} className="text-[11px] font-semibold text-[var(--color-brand)] hover:text-blue-800 flex items-center space-x-1 cursor-pointer">
            <Plus className="w-3 h-3" />
            <span>Add Skill Category</span>
          </button>
        </div>
        <div className="space-y-2">
          {(formData.skills || []).map((sk, skIdx) => (
            <div key={skIdx} draggable onDragStart={(e) => handleSkillDragStart(e, skIdx)} onDragOver={handleSkillDragOver} onDrop={(e) => handleSkillDrop(e, skIdx)} className={`flex items-center space-x-2 bg-white p-2 rounded border cursor-grab active:cursor-grabbing transition-all ${dragSkillIdx === skIdx ? 'border-blue-400 ring-2 ring-blue-200 opacity-70' : 'border-[var(--color-hairline)] hover:border-[var(--color-brand-line)]'}`}>
              <GripVertical className="w-3.5 h-3.5 text-[var(--color-faint)] shrink-0" />
              <input type="text" value={sk.category} onChange={(e) => { const updated = { ...formData } as MasterCv; updated.skills[skIdx].category = e.target.value; setFormData(updated); }} placeholder="Category Name" className="w-1/3 border border-[var(--color-hairline)] rounded px-2 py-1 font-bold text-[var(--color-ink)]" />
              <TagInput value={sk.items} onChange={(items) => { const updated = { ...formData } as MasterCv; updated.skills[skIdx].items = items; setFormData(updated); }} placeholder="Type a skill and press comma (,) or Enter…" />
              <button type="button" onClick={() => removeSkillCategory(skIdx)} className="p-1 text-[var(--color-faint)] hover:text-[var(--color-danger)] cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
        {aiSkillLookup && (
          <div className="text-[10.5px] font-semibold text-[var(--color-faint)]">
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-extrabold uppercase tracking-wide text-purple-700 bg-purple-100 border border-purple-200 mr-1">✦ AI</span>
            Skills added by AI for this job — remove any you don't genuinely have. New skills you type are yours.
          </div>
        )}
      </div>

      {/* Projects Section */}
      <div className="bg-[#FAFAF9] p-4 rounded-lg border border-[var(--color-hairline)] space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-[var(--color-ink)] uppercase tracking-wider text-[11px] flex items-center space-x-1.5">
            <FolderGit2 className="w-3.5 h-3.5 text-[var(--color-muted)]" />
            <span>Featured Projects & Portfolio</span>
          </h3>
          <button type="button" onClick={addProject} className="text-[11px] font-semibold text-[var(--color-brand)] hover:text-blue-800 flex items-center space-x-1 cursor-pointer">
            <Plus className="w-3 h-3" />
            <span>Add Project</span>
          </button>
        </div>
        {(formData.projects || []).map((proj, pIdx) => (
          <div key={proj.id || pIdx} draggable onDragStart={(e) => handleProjectDragStart(e, pIdx)} onDragOver={handleProjectDragOver} onDrop={(e) => handleProjectDrop(e, pIdx)} className={`bg-white p-3 rounded-lg border space-y-2.5 cursor-grab active:cursor-grabbing transition-all ${dragProjectIdx === pIdx ? 'border-blue-400 ring-2 ring-blue-200 opacity-70' : 'border-[var(--color-hairline)] hover:border-[var(--color-brand-line)]'}`}>
            <div className="flex items-center justify-between">
              <span className="font-bold text-[var(--color-muted)] text-[11px] flex items-center space-x-1.5">
                <GripVertical className="w-3.5 h-3.5 text-[var(--color-faint)]" />
                <span>Project #{pIdx + 1}</span>
              </span>
              <button type="button" onClick={() => removeProject(pIdx)} className="text-[var(--color-faint)] hover:text-[var(--color-danger)] p-1 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="block text-[var(--color-faint)] text-[11px]">Project Name</label>
                <input type="text" value={proj.name} onChange={(e) => { const updated = { ...formData } as MasterCv; updated.projects[pIdx].name = e.target.value; setFormData(updated); }} className="w-full border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)] font-bold" />
              </div>
              <div>
                <label className="block text-[var(--color-faint)] text-[11px]">Link / URL</label>
                <input type="text" value={proj.link || ''} onChange={(e) => { const updated = { ...formData } as MasterCv; updated.projects[pIdx].link = e.target.value; setFormData(updated); }} className="w-full border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)]" />
              </div>
            </div>
            <div>
              <label className="block text-[var(--color-faint)] text-[11px]">Description</label>
              <textarea rows={2} value={proj.description || ''} onChange={(e) => { const updated = { ...formData } as MasterCv; updated.projects[pIdx].description = e.target.value; setFormData(updated); }} className="w-full border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)]" />
            </div>
            <div>
              <label className="block text-[var(--color-faint)] text-[11px]">Technologies (comma separated)</label>
              <input type="text" value={(proj.technologies || []).join(', ')} onChange={(e) => { const updated = { ...formData } as MasterCv; updated.projects[pIdx].technologies = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); setFormData(updated); }} className="w-full border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)]" />
            </div>
          </div>
        ))}
      </div>

      {/* Certifications & Credentials */}
      <div className="bg-[#FAFAF9] p-4 rounded-lg border border-[var(--color-hairline)] space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-[var(--color-ink)] uppercase tracking-wider text-[11px] flex items-center space-x-1.5">
            <Award className="w-3.5 h-3.5 text-[var(--color-muted)]" />
            <span>Certifications, Licenses & Credentials</span>
          </h3>
          <button type="button" onClick={addCertification} className="text-[11px] font-semibold text-[var(--color-brand)] hover:text-blue-800 flex items-center space-x-1 cursor-pointer">
            <Plus className="w-3 h-3" />
            <span>Add Certification</span>
          </button>
        </div>
        {(formData.certifications || []).map((cert, cIdx) => (
          <div key={cert.id || cIdx} draggable onDragStart={(e) => handleCertDragStart(e, cIdx)} onDragOver={handleCertDragOver} onDrop={(e) => handleCertDrop(e, cIdx)} className={`bg-white p-3 rounded-lg border space-y-2 cursor-grab active:cursor-grabbing transition-all ${dragCertIdx === cIdx ? 'border-blue-400 ring-2 ring-blue-200 opacity-70' : 'border-[var(--color-hairline)] hover:border-[var(--color-brand-line)]'}`}>
            <div className="flex items-center justify-between">
              <span className="font-bold text-[var(--color-muted)] text-[11px] flex items-center space-x-1.5">
                <GripVertical className="w-3.5 h-3.5 text-[var(--color-faint)]" />
                <span>Certification #{cIdx + 1}</span>
              </span>
              <button type="button" onClick={() => removeCertification(cIdx)} className="text-[var(--color-faint)] hover:text-[var(--color-danger)] p-1 cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="sm:col-span-2">
                <label className="block text-[var(--color-faint)] text-[11px]">Certification Title / Name</label>
                <input type="text" value={cert.name} onChange={(e) => { const updated = { ...formData } as MasterCv; if (!updated.certifications) updated.certifications = []; updated.certifications[cIdx].name = e.target.value; setFormData(updated); }} placeholder="e.g. AWS Certified Solutions Architect - Associate" className="w-full border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)] font-bold" />
              </div>
              <div>
                <label className="block text-[var(--color-faint)] text-[11px]">Issuer / Organization</label>
                <input type="text" value={cert.issuer || ''} onChange={(e) => { const updated = { ...formData } as MasterCv; if (!updated.certifications) updated.certifications = []; updated.certifications[cIdx].issuer = e.target.value; setFormData(updated); }} placeholder="e.g. Amazon Web Services, Google, Coursera" className="w-full border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)]" />
              </div>
              <div>
                <label className="block text-[var(--color-faint)] text-[11px]">Date Issued / Expiration</label>
                <input type="text" value={cert.date || ''} onChange={(e) => { const updated = { ...formData } as MasterCv; if (!updated.certifications) updated.certifications = []; updated.certifications[cIdx].date = e.target.value; setFormData(updated); }} placeholder="e.g. Nov 2023" className="w-full border border-[var(--color-hairline)] rounded px-2 py-1 text-[var(--color-ink)]" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Skill Gaps Section (Master CV only) */}
      {!hideSkillGaps && (
      <div className="bg-[#FAFAF9] border border-[var(--color-hairline)] rounded-lg overflow-hidden">
        <button type="button" onClick={() => { if (!showGaps) fetchSkillGaps(); setShowGaps(!showGaps); }} className="w-full flex items-center justify-between p-3.5 text-xs font-bold text-[var(--color-ink)] hover:bg-[var(--color-brand-soft)] transition-colors cursor-pointer">
          <div className="flex items-center space-x-2">
            <TrendingUp className="w-4 h-4 text-[var(--color-brand)]" />
            <span>Skill Gaps from Market</span>
            {skillGaps.length > 0 && (
              <span className="px-1.5 py-0.2 rounded bg-[var(--color-brand-soft)] text-[var(--color-brand)] text-[10px] font-bold">{skillGaps.length}</span>
            )}
          </div>
          {showGaps ? <ChevronDown className="w-4 h-4 text-[var(--color-faint)]" /> : <ChevronRight className="w-4 h-4 text-[var(--color-faint)]" />}
        </button>
        {showGaps && (
          <div className="px-3.5 pb-3.5 space-y-2">
            {gapsLoading ? (
              <div className="flex items-center space-x-2 text-xs text-[var(--color-faint)] py-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Analyzing scored jobs...</span>
              </div>
            ) : skillGaps.length === 0 ? (
              <div className="flex items-center space-x-2 text-xs text-[var(--color-faint)] py-2">
                <AlertTriangle className="w-3.5 h-3.5 text-[var(--color-amber,#C2410C)]" />
                <span>No scored jobs yet. Run match analysis on jobs first.</span>
              </div>
            ) : (
              <>
                {gapsAddedMsg && (
                  <div className="px-2 py-1.5 rounded bg-[var(--color-cta-soft)] border border-[var(--color-cta-line)] text-emerald-800 text-[11px] font-medium">{gapsAddedMsg}</div>
                )}
                <p className="text-[11px] text-[var(--color-faint)]">Skills most frequently missing across {skillGaps[0]?.totalScored || 0} scored jobs. Check the ones you have and add them to your CV.</p>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {skillGaps.map((gap) => (
                    <label key={gap.skill} className="flex items-center space-x-2 px-2 py-1.5 rounded hover:bg-white cursor-pointer text-xs">
                      <input type="checkbox" checked={selectedGaps.has(gap.skill)} onChange={() => toggleGap(gap.skill)} className="rounded border-[var(--color-hairline2)] cursor-pointer" />
                      <span className="flex-1 font-medium text-[var(--color-ink)]">{gap.skill}</span>
                      <span className="text-[10px] font-semibold text-[var(--color-faint)]">{gap.count}/{gap.totalScored} jobs</span>
                    </label>
                  ))}
                </div>
                {selectedGaps.size > 0 && (
                  <button type="button" onClick={addSelectedGapsToCv} className="w-full px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--color-brand)] hover:bg-[var(--color-brand-strong)] text-white transition-colors cursor-pointer">
                    Add {selectedGaps.size} Skill{selectedGaps.size > 1 ? 's' : ''} to CV
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      )}
    </form>
  );
};

import React, { useLayoutEffect, useMemo, useRef, useState, useEffect } from 'react';
import { MasterCv, TemplateId } from '../types';
import { CV_PAGE, CV_TEMPLATE_GEOMETRY, cvContentHeight, cvContentWidth } from '../constants/cvTemplateConfig';
import { displayUrl } from '../lib/displayUrl';

// Normalized shape mirroring server-side TailoredCv (as produced by generatePdfBuffer)
export interface PdfCvShape {
  candidateName: string;
  targetRole?: string;
  contactInfo: {
    email?: string;
    phone?: string;
    location?: string;
    linkedin?: string;
    github?: string;
    website?: string;
  };
  professionalSummary: string;
  technicalSkills: { category: string; skills: string[] }[];
  coreCompetencies?: string[];
  workExperience: { title: string; company: string; location?: string; dates: string; highlights: string[] }[];
  projects?: { name: string; description?: string; technologies?: string[]; link?: string; dates?: string }[];
  education: { degree: string; institution: string; dates: string; details?: string }[];
  certifications?: (string | { name: string; issuer?: string; date?: string; link?: string })[];
}

// Convert a MasterCv into the same shape the server uses for generatePdfBuffer
export function masterCvToPdfShape(m: MasterCv): PdfCvShape {
  return {
    candidateName: m.fullName || 'CANDIDATE NAME',
    targetRole: (m as any).designation || m.experiences?.[0]?.title || '',
    contactInfo: {
      email: m.email,
      phone: m.phone,
      location: m.location,
      linkedin: m.linkedin,
      github: m.github,
      website: m.website,
    },
    professionalSummary: m.summary || '',
    technicalSkills: (m.skills || []).map((s) => ({ category: s.category, skills: s.items })),
    workExperience: (m.experiences || []).map((e) => ({
      title: e.title,
      company: e.company,
      location: e.location,
      dates: e.dates,
      highlights: e.responsibilities || [],
    })),
    projects: (m.projects || []).map((p) => ({
      name: p.name,
      description: p.description,
      technologies: p.technologies,
      link: p.link,
      dates: p.dates,
    })),
    education: (m.education || []).map((e) => ({
      degree: e.degree,
      institution: e.institution,
      dates: e.dates,
      details: e.details,
    })),
    certifications: (m.certifications || []).map((c) =>
      typeof c === 'string' ? c : { name: c.name, issuer: c.issuer, date: c.date }
    ),
  };
}

// Convert an AI-compressed CV payload (server analyze/accept shape) into the
// same normalized shape used for PDF rendering.
export function compressedCvToPdfShape(cv: any): PdfCvShape {
  return {
    candidateName: cv.candidateName || '',
    targetRole: cv.targetRole || '',
    contactInfo: cv.contactInfo || {},
    professionalSummary: cv.professionalSummary || '',
    technicalSkills: Array.isArray(cv.technicalSkills) ? cv.technicalSkills : [],
    coreCompetencies: Array.isArray(cv.coreCompetencies) ? cv.coreCompetencies : [],
    workExperience: Array.isArray(cv.workExperience) ? cv.workExperience : [],
    projects: Array.isArray(cv.projects) ? cv.projects : [],
    education: Array.isArray(cv.education) ? cv.education : [],
    certifications: Array.isArray(cv.certifications) ? cv.certifications : [],
  };
}

function getContactItems(cv: PdfCvShape): { label: string; url?: string }[] {
  const items: { label: string; url?: string }[] = [];
  if (cv.contactInfo.email) items.push({ label: cv.contactInfo.email, url: `mailto:${cv.contactInfo.email}` });
  if (cv.contactInfo.phone) items.push({ label: cv.contactInfo.phone });
  if (cv.contactInfo.location) items.push({ label: cv.contactInfo.location });
  if (cv.contactInfo.linkedin) items.push({ label: 'LinkedIn', url: cv.contactInfo.linkedin });
  if (cv.contactInfo.github) items.push({ label: 'GitHub', url: cv.contactInfo.github });
  if (cv.contactInfo.website) items.push({ label: 'Portfolio', url: cv.contactInfo.website });
  return items;
}

// ── Page geometry — shared with the PDF generator (cvTemplateConfig.ts) ──
// Letter 8.5x11 at 72dpi. All margins/content widths come from the shared
// config so the preview lays out with EXACTLY the PDF's geometry.
const PAGE_W = CV_PAGE.width;
const PAGE_H = CV_PAGE.height;

// Scale a pt value to the current zoom (all sizes scale linearly, so the
// wrap points and relative heights stay identical at every zoom level).
const pt = (v: number, zoom: number) => Math.round(v * (zoom / 100));

// ── Template styles — same structure/blocks for all three, only the
//    visual treatment changes (colors, name size, density, rules).
//    All variants stay single-column with standard headings → ATS-safe.
export interface CvTemplateStyle {
  accent: string;           // section headers / rules
  nameSize: number;
  roleSize: number;
  headingSize: number;
  expTitleSize: number;
  skillCategorySize: number;
  roleColor: string;
  ruleWidth: number;        // section rule thickness
  bodySize: number;
  bulletSize: number;
  sectionSpacing: number;   // spacing before a section title
  sectionGap: number;       // legacy alias of sectionSpacing
  lineHeight: number;
  nameWeight: number;
  skillsColumnGap: number;  // 0 = single column
}

// Derived from the shared geometry config — never defined twice.
function toTemplateStyle(g: (typeof CV_TEMPLATE_GEOMETRY)[TemplateId]): CvTemplateStyle {
  return {
    accent: g.accent,
    nameSize: g.nameSize,
    roleSize: g.roleSize,
    headingSize: g.headingSize,
    expTitleSize: g.expTitleSize,
    skillCategorySize: g.skillCategorySize,
    roleColor: g.roleColor,
    ruleWidth: g.ruleWidth,
    bodySize: g.bodySize,
    bulletSize: g.bulletSize,
    sectionSpacing: g.sectionSpacing,
    sectionGap: g.sectionSpacing,
    lineHeight: g.bodyLineHeight,
    nameWeight: g.nameWeight,
    skillsColumnGap: g.skillsColumnGap,
  };
}

export const CV_TEMPLATE_STYLES: Record<TemplateId, CvTemplateStyle> = {
  'harvard': toTemplateStyle(CV_TEMPLATE_GEOMETRY.harvard),
  'jake': toTemplateStyle(CV_TEMPLATE_GEOMETRY.jake),
  'atanu': toTemplateStyle(CV_TEMPLATE_GEOMETRY.atanu),
  'atanu-pro': toTemplateStyle(CV_TEMPLATE_GEOMETRY['atanu-pro']),
};
// A single atomic layout unit. `keepAfter` mirrors pdfkit's ensurePageSpace:
// the block requires at least that many pt to remain below it, otherwise it
// moves to the next page (prevents orphaned section titles / headers).
interface CvBlock {
  key: string;
  keepAfter?: number;
  render: (zoom: number) => React.ReactNode;
}

interface CvPdfPreviewProps {
  cv: PdfCvShape;
  zoom?: number;
  template?: TemplateId;
  onPageCount?: (n: number) => void;
  /** Auto-scale pages to fill the container width (up to 100%) — use in
   *  side-by-side views so pages use the full lane without side gaps. */
  fitToWidth?: boolean;
}

/**
 * HTML replica of the server-side PDF (docxGenerator.ts / generatePdfBuffer),
 * rendered PAGE-WISE: content that exceeds one Letter page flows onto the
 * next sheet, using the same break rules as pdfkit (section headers and
 * experience headers keep with their content; bullets are atomic).
 */
export const CvPdfPreview: React.FC<CvPdfPreviewProps> = ({ cv, zoom = 100, template = 'harvard', onPageCount, fitToWidth = false }) => {
  const safeTemplate: TemplateId = template === 'jake' || template === 'atanu' || template === 'harvard' || template === 'atanu-pro' ? template : 'harvard';
  const style = CV_TEMPLATE_STYLES[safeTemplate] || CV_TEMPLATE_STYLES.harvard;
  // Margins/content from the SHARED geometry (identical to the PDF).
  const marginX = CV_TEMPLATE_GEOMETRY[safeTemplate].marginLeft;
  const marginY = CV_TEMPLATE_GEOMETRY[safeTemplate].marginTop;
  const contentW = cvContentWidth(safeTemplate);
  const contentH = cvContentHeight(safeTemplate);
  const lineHeight = style.lineHeight;
  const blocks = useMemo(() => buildBlocks(cv, style, safeTemplate), [cv, style, safeTemplate]);
  const measurerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<CvBlock[][]>([]);
  const [fitZoom, setFitZoom] = useState<number>(zoom);

  useEffect(() => {
    onPageCount?.(pages.length);
  }, [pages, onPageCount]);

  // Auto-fit: measure the container and scale pages to fill its width.
  useEffect(() => {
    if (!fitToWidth) { setFitZoom(zoom); return; }
    const el = rootRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) {
        // leave ~16px breathing room, cap at 100%, snap to 5%
        const z = Math.min(100, Math.floor(((w - 16) / PAGE_W) * 100 / 5) * 5);
        setFitZoom(Math.max(40, z));
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitToWidth, zoom]);

  const effectiveZoom = fitToWidth ? fitZoom : zoom;

  // Measure every block at 100% zoom (exact PDF metrics), then paginate.
  useLayoutEffect(() => {
    const el = measurerRef.current;
    if (!el) return;
    const heights: Record<string, number> = {};
    Array.from(el.children).forEach((child, i) => {
      heights[blocks[i]?.key ?? ''] = (child as HTMLElement).getBoundingClientRect().height;
    });
    setPages(paginate(blocks, heights, contentH));
  }, [blocks, contentH]);

  return (
    <div ref={rootRef} className="flex flex-col items-center gap-6 w-full">
      {/* Hidden measurer — renders every block at 100% with the exact PDF
          content width so heights are measured truthfully. */}
      <div
        ref={measurerRef}
        aria-hidden
        style={{
          position: 'absolute',
          left: -99999,
          top: 0,
          width: contentW,
          fontFamily: 'Helvetica, Arial, sans-serif',
          color: '#1F2937',
          fontSize: '9.5px',
          lineHeight,
          visibility: 'hidden',
          pointerEvents: 'none',
        }}
      >
        {blocks.map((b) => (
          <div key={b.key}>{b.render(100)}</div>
        ))}
      </div>

      {/* Stacked A4 pages */}
      {pages.map((page, pi) => (
        <div
          key={pi}
          className="bg-white shadow-2xl rounded-sm"
          style={{
            width: pt(PAGE_W, effectiveZoom),
            height: pt(PAGE_H, effectiveZoom),
            padding: `${pt(marginY, effectiveZoom)}px ${pt(marginX, effectiveZoom)}px`,
            overflow: 'hidden',
            fontFamily: 'Helvetica, Arial, sans-serif',
            color: '#1F2937',
            fontSize: `${pt(9.5, effectiveZoom)}px`,
            lineHeight,
          }}
        >
          {page.map((b) => (
            <div key={b.key}>{b.render(effectiveZoom)}</div>
          ))}
        </div>
      ))}
    </div>
  );
};

// ── Pagination: greedy page fill with orphan protection ──
function paginate(blocks: CvBlock[], heights: Record<string, number>, contentH: number): CvBlock[][] {
  const pages: CvBlock[][] = [];
  let current: CvBlock[] = [];
  let used = 0;

  for (const b of blocks) {
    const h = heights[b.key] ?? 16;
    const required = h + (b.keepAfter ?? 0);
    if (used > 0 && used + required > contentH) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(b);
    used += h;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

// ── Build the atomic block list in document order ──
function buildBlocks(cv: PdfCvShape, s: CvTemplateStyle, template: TemplateId = 'harvard'): CvBlock[] {
  if (template === 'harvard') {
    return buildHarvardBlocks(cv);
  }
  if (template === 'jake') {
    return buildJakeBlocks(cv, s);
  }
  if (template === 'atanu') {
    return buildAtanuBlocks(cv, s);
  }
  if (template === 'atanu-pro') {
    return buildAtanuProBlocks(cv, s);
  }
  const blocks: CvBlock[] = [];
  const contacts = getContactItems(cv);
  const hasTechSkills = cv.technicalSkills.length > 0 || (cv.coreCompetencies?.length || 0) > 0;

  const section = (title: string): CvBlock => ({
    key: `sec-${title}`,
    keepAfter: 40, // never orphan a section title at the bottom of a page
    render: (zoom) => <SectionTitle zoom={zoom} style={s}>{title}</SectionTitle>,
  });

  // 1. Name + role + contact (always together)
  blocks.push({
    key: 'header',
    render: (zoom) => (
      <div style={{ paddingBottom: pt(4, zoom) }}>
        <div
          style={{
            textAlign: 'center',
            fontFamily: 'Helvetica-Bold, Helvetica, Arial, sans-serif',
            fontSize: `${pt(s.nameSize, zoom)}px`,
            fontWeight: s.nameWeight,
            color: '#111827',
            textTransform: 'uppercase',
            letterSpacing: s.nameSize >= 20 ? '0.05em' : '0.02em',
          }}
        >
          {cv.candidateName || 'CANDIDATE NAME'}
        </div>
        {cv.targetRole && (
          <div
            style={{
              textAlign: 'center',
              fontWeight: 700,
              fontSize: `${pt(10, zoom)}px`,
              color: s.roleColor,
              paddingTop: pt(3, zoom),
            }}
          >
            {cv.targetRole}
          </div>
        )}
        {contacts.length > 0 && (
          <div style={{ textAlign: 'center', fontSize: `${pt(9, zoom)}px`, paddingTop: pt(6, zoom) }}>
            {contacts.map((c, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span style={{ color: '#9CA3AF', margin: `0 ${pt(5, zoom)}px` }}>•</span>}
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: '#0055BB', textDecoration: 'underline' }}>
                    {c.label}
                  </a>
                ) : (
                  <span style={{ color: '#374151' }}>{c.label}</span>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    ),
  });

  // 2. Professional Summary
  if (cv.professionalSummary) {
    blocks.push(section('PROFESSIONAL SUMMARY'));
    blocks.push({
      key: 'summary',
      render: (zoom) => (
        <div style={{ color: '#1F2937', fontSize: `${pt(s.bodySize, zoom)}px`, lineHeight: s.lineHeight, paddingBottom: pt(4, zoom) }}>{cv.professionalSummary}</div>
      ),
    });
  }

  // 3. Technical Skills
  if (hasTechSkills) {
    blocks.push(section('TECHNICAL SKILLS & COMPETENCIES'));
    cv.technicalSkills.forEach((cat, i) => {
      blocks.push({
        key: `skill-${i}`,
        render: (zoom) => (
          <div style={{ fontSize: `${pt(s.bodySize, zoom)}px`, lineHeight: s.lineHeight, paddingBottom: pt(3, zoom) }}>
            <span style={{ fontWeight: 700, color: '#111827' }}>{cat.category}: </span>
            <span style={{ color: '#374151' }}>{cat.skills.join(', ')}</span>
          </div>
        ),
      });
    });
    if (cv.technicalSkills.length === 0 && cv.coreCompetencies) {
      blocks.push({
        key: 'skill-competencies',
        render: (zoom) => (
          <div style={{ color: '#1F2937', fontSize: `${pt(s.bodySize, zoom)}px`, lineHeight: s.lineHeight, paddingBottom: pt(3, zoom) }}>{cv.coreCompetencies.join(', ')}</div>
        ),
      });
    }
  }

  // 4. Professional Experience
  if (cv.workExperience.length > 0) {
    blocks.push(section('PROFESSIONAL EXPERIENCE'));
    cv.workExperience.forEach((exp, i) => {
      // Header stays with at least one bullet (pdfkit ensurePageSpace(45))
      blocks.push({
        key: `exp-${i}-head`,
        keepAfter: 30,
        render: (zoom) => (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, paddingBottom: pt(2, zoom) }}>
            <span style={{ fontWeight: 700, fontSize: `${pt(s.expTitleSize, zoom)}px`, color: '#111827' }}>
              {[exp.title, exp.company].filter(Boolean).join('   |   ')}
            </span>
            <span style={{ fontStyle: 'italic', fontSize: `${pt(8.5, zoom)}px`, color: '#4B5563', whiteSpace: 'nowrap' }}>
              {[exp.dates, exp.location].filter(Boolean).join('   |   ')}
            </span>
          </div>
        ),
      });
      exp.highlights.forEach((hl, j) => {
        blocks.push({
          key: `exp-${i}-b${j}`,
          render: (zoom) => <Bullet zoom={zoom} text={hl} style={s} />,
        });
      });
    });
  }

  // 5. Featured Projects
  if (cv.projects && cv.projects.length > 0) {
    blocks.push(section('FEATURED PROJECTS'));
    cv.projects.forEach((p, i) => {
      blocks.push({
        key: `proj-${i}-head`,
        keepAfter: 25,
        render: (zoom) => (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, paddingBottom: pt(2, zoom) }}>
            <span style={{ fontWeight: 700, fontSize: `${pt(s.expTitleSize, zoom)}px`, color: '#111827' }}>
              {p.name}
              {p.link && (
                <a href={p.link} target="_blank" rel="noopener noreferrer" style={{ color: '#0055BB', fontSize: `${pt(9, zoom)}px`, fontWeight: 400, marginLeft: pt(6, zoom) }}>
                  | View Project
                </a>
              )}
            </span>
            {p.dates && (
              <span style={{ fontStyle: 'italic', fontSize: `${pt(8.5, zoom)}px`, color: '#4B5563', whiteSpace: 'nowrap' }}>
                {p.dates}
              </span>
            )}
          </div>
        ),
      });
      if (p.technologies && p.technologies.length > 0) {
        blocks.push({
          key: `proj-${i}-tech`,
          render: (zoom) => (
            <div style={{ fontSize: `${pt(9, zoom)}px`, lineHeight: s.lineHeight, paddingBottom: pt(2, zoom) }}>
              <span style={{ fontWeight: 700, color: '#374151' }}>Technologies: </span>
              <span style={{ color: '#4B5563' }}>{p.technologies.join(', ')}</span>
            </div>
          ),
        });
      }
      if (p.description) {
        blocks.push({ key: `proj-${i}-desc`, render: (zoom) => <Bullet zoom={zoom} text={p.description} style={s} /> });
      }
    });
  }

  // 6. Education
  if (cv.education.length > 0) {
    blocks.push(section('EDUCATION'));
    cv.education.forEach((e, i) => {
      blocks.push({
        key: `edu-${i}`,
        keepAfter: 15,
        render: (zoom) => (
          <div style={{ fontSize: `${pt(s.bodySize, zoom)}px`, lineHeight: s.lineHeight, paddingBottom: pt(6, zoom) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: `${pt(s.expTitleSize, zoom)}px`, color: '#111827' }}>{e.degree}</span>
              {e.dates && (
                <span style={{ fontStyle: 'italic', fontSize: `${pt(8.5, zoom)}px`, color: '#4B5563', whiteSpace: 'nowrap' }}>
                  {e.dates}
                </span>
              )}
            </div>
            <div style={{ color: '#374151' }}>{e.institution}</div>
          </div>
        ),
      });
    });
  }

  // 7. Certifications
  if (cv.certifications && cv.certifications.length > 0) {
    blocks.push(section('CERTIFICATIONS & CREDENTIALS'));
    cv.certifications.forEach((cert, i) => {
      const parts = typeof cert === 'string' ? [cert] : [cert.name, cert.issuer, cert.date].filter(Boolean);
      blocks.push({ key: `cert-${i}`, render: (zoom) => <Bullet zoom={zoom} text={parts.join('   |   ')} style={s} /> });
    });
  }

  return blocks;
}


// ── Harvard — official Harvard College bullet-point resume ──
// centered bold name + centered contact (•), centered bold uppercase
// headings (no rules), org bold left / city right, title left / dates
// right, • bullets.
function buildHarvardBlocks(cv: PdfCvShape): CvBlock[] {
  const blocks: CvBlock[] = [];
  const contacts = getContactItems(cv);

  const section = (title: string): CvBlock => ({
    key: `sec-${title}`,
    keepAfter: 30,
    render: (zoom) => (
      <div style={{ margin: `${pt(10, zoom)}px 0 ${pt(5, zoom)}px` }}>
        <div style={{ textAlign: 'center', fontSize: `${pt(11, zoom)}px`, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#111111' }}>
          {title}
        </div>
      </div>
    ),
  });

  blocks.push({
    key: 'header',
    render: (zoom) => (
      <div style={{ marginBottom: pt(8, zoom) }}>
        <div style={{ textAlign: 'center', fontSize: `${pt(15, zoom)}px`, fontWeight: 700, textTransform: 'uppercase', color: '#111111' }}>
          {cv.candidateName || 'CANDIDATE NAME'}
        </div>
        {contacts.length > 0 && (
          <div style={{ textAlign: 'center', fontSize: `${pt(10, zoom)}px`, color: '#111111', marginTop: pt(3, zoom) }}>
            {contacts.map((c, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span style={{ padding: `0 ${pt(4, zoom)}px` }}>•</span>}
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: '#111111', textDecoration: 'none' }}>{c.label}</a>
                ) : (
                  <span>{c.label}</span>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    ),
  });

  if (cv.professionalSummary) {
    blocks.push(section('Summary'));
    blocks.push({
      key: 'summary',
      render: (zoom) => (
        <div style={{ fontSize: `${pt(10.5, zoom)}px`, color: '#111111', lineHeight: 1.3, textAlign: 'justify', paddingBottom: pt(4, zoom) }}>
          {cv.professionalSummary}
        </div>
      ),
    });
  }

  if (cv.education.length > 0) {
    blocks.push(section('Education'));
    cv.education.forEach((e, i) => {
      blocks.push({
        key: `edu-${i}`,
        keepAfter: 20,
        render: (zoom) => (
          <div style={{ marginBottom: pt(6, zoom) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
              <span style={{ fontWeight: 700, fontSize: `${pt(10.5, zoom)}px`, color: '#111111' }}>{e.institution}</span>
              {e.dates && <span style={{ fontSize: `${pt(10.5, zoom)}px`, whiteSpace: 'nowrap' }}>{e.dates}</span>}
            </div>
            {e.degree && <div style={{ fontWeight: 700, fontSize: `${pt(10.5, zoom)}px`, marginTop: pt(1, zoom) }}>{e.degree}</div>}
          </div>
        ),
      });
    });
  }

  if (cv.workExperience.length > 0) {
    blocks.push(section('Experience'));
    cv.workExperience.forEach((exp, i) => {
      blocks.push({
        key: `exp-${i}-head`,
        keepAfter: 30,
        render: (zoom) => (
          <div style={{ marginBottom: pt(2, zoom) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
              <span style={{ fontWeight: 700, fontSize: `${pt(10.5, zoom)}px`, color: '#111111' }}>{exp.company}</span>
              {exp.location && <span style={{ fontSize: `${pt(10.5, zoom)}px`, whiteSpace: 'nowrap' }}>{exp.location}</span>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
              <span style={{ fontWeight: 700, fontSize: `${pt(10.5, zoom)}px` }}>{exp.title}</span>
              {exp.dates && <span style={{ fontSize: `${pt(10.5, zoom)}px`, whiteSpace: 'nowrap' }}>{exp.dates}</span>}
            </div>
          </div>
        ),
      });
      exp.highlights.forEach((hl, j) => {
        blocks.push({ key: `exp-${i}-b${j}`, render: (zoom) => <HarvardBullet zoom={zoom} text={hl} /> });
      });
      blocks.push({ key: `exp-${i}-gap`, render: () => <div style={{ height: 6 }} /> });
    });
  }

  if (cv.projects && cv.projects.length > 0) {
    blocks.push(section('Projects'));
    cv.projects.forEach((p, i) => {
      blocks.push({
        key: `proj-${i}`,
        keepAfter: 20,
        render: (zoom) => (
          <div style={{ marginBottom: pt(5, zoom) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
              <span style={{ fontWeight: 700, fontSize: `${pt(10.5, zoom)}px`, color: '#111111' }}>{p.name}</span>
              {p.dates && <span style={{ fontSize: `${pt(10.5, zoom)}px`, whiteSpace: 'nowrap' }}>[{p.dates}]</span>}
            </div>
            {p.description && (
              <div style={{ fontSize: `${pt(10.5, zoom)}px`, paddingLeft: pt(13, zoom), position: 'relative', textAlign: 'justify' }}>
                <span style={{ position: 'absolute', left: 0 }}>•</span>
                {p.description}
              </div>
            )}
            {p.link && (
              <a href={p.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: `${pt(10.5, zoom)}px`, color: '#111111', textDecoration: 'none' }}>
                {displayUrl(p.link)}
              </a>
            )}
          </div>
        ),
      });
    });
  }

  if (cv.technicalSkills.length > 0) {
    blocks.push(section('Skills & Interests'));
    cv.technicalSkills.forEach((cat, i) => {
      blocks.push({
        key: `skill-${i}`,
        render: (zoom) => (
          <div style={{ fontSize: `${pt(10.5, zoom)}px`, lineHeight: 1.3, marginBottom: pt(2.5, zoom) }}>
            <span style={{ fontWeight: 700, color: '#111111' }}>{cat.category}: </span>
            <span style={{ color: '#111111' }}>{cat.skills.join(', ')}</span>
          </div>
        ),
      });
    });
  }

  if (cv.certifications && cv.certifications.length > 0) {
    blocks.push(section('Certifications'));
    cv.certifications.forEach((cert, i) => {
      let nameT = '';
      let issuer = '';
      if (typeof cert === 'string') nameT = cert;
      else { nameT = cert.name || ''; issuer = cert.issuer || ''; }
      blocks.push({
        key: `cert-${i}`,
        render: (zoom) => (
          <div style={{ fontSize: `${pt(10.5, zoom)}px`, marginBottom: pt(2, zoom) }}>
            {issuer && <span style={{ fontWeight: 700, color: '#111111' }}>{issuer}</span>}
            <span style={{ color: '#111111' }}>{(issuer ? '  —  ' : '') + nameT}</span>
          </div>
        ),
      });
    });
  }

  return blocks;
}

const SectionTitle: React.FC<{ zoom: number; style: CvTemplateStyle; children: React.ReactNode }> = ({ zoom, style, children }) => (
  <div style={{ paddingTop: pt(style.sectionGap, zoom), paddingBottom: pt(6, zoom) }}>
    <div
      style={{
        fontWeight: 700,
        fontSize: `${pt(10.5, zoom)}px`,
        color: style.accent,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >
      {children}
    </div>
    <div style={{ height: Math.max(1, Math.round(style.ruleWidth * (zoom / 100))), background: style.accent, opacity: 0.6, marginTop: pt(3, zoom) }} />
  </div>
);

const Bullet: React.FC<{ zoom: number; text: string; style: CvTemplateStyle }> = ({ zoom, text, style }) => {
  const clean = String(text || '').replace(/^[*•\-]\s*/, '').trim();
  if (!clean) return null;
  return (
    <div style={{ display: 'flex', gap: pt(6, zoom), fontSize: `${pt(style.bulletSize, zoom)}px`, lineHeight: style.lineHeight, paddingBottom: pt(2, zoom) }}>
      <span style={{ color: '#4B5563', flexShrink: 0 }}>•</span>
      <span style={{ color: '#1F2937' }}>{clean}</span>
    </div>
  );
};

function buildAtanuBlocks(cv: PdfCvShape, s: CvTemplateStyle): CvBlock[] {
  const blocks: CvBlock[] = [];
  const contacts = getContactItems(cv);

  const section = (title: string): CvBlock => ({
    key: `sec-${title}`,
    keepAfter: 40,
    render: (zoom) => (
      <div style={{ margin: `${pt(10, zoom)}px 0 ${pt(6, zoom)}px` }}>
        <div
          style={{
            fontSize: `${pt(11, zoom)}px`,
            fontWeight: 400,
            textTransform: 'uppercase',
            letterSpacing: '1.5px',
            color: '#0F766E',
            paddingBottom: pt(2, zoom),
            borderBottom: `${Math.max(1, Math.round(pt(1.2, zoom)))}px solid #0F766E`,
          }}
        >
          {title}
        </div>
      </div>
    ),
  });

  // 1. Centered header: name (24px, 3px letter-spacing) + contact line
  blocks.push({
    key: 'header',
    render: (zoom) => (
      <div style={{ marginBottom: pt(10, zoom) }}>
        <div
          style={{
            textAlign: 'center',
            fontFamily: 'Helvetica-Bold, Helvetica, Arial, sans-serif',
            fontSize: `${pt(24, zoom)}px`,
            fontWeight: 700,
            color: '#0F172A',
            textTransform: 'uppercase',
            letterSpacing: '3px',
            marginBottom: pt(3, zoom),
          }}
        >
          {cv.candidateName || 'CANDIDATE NAME'}
        </div>
        {cv.targetRole && (
          <div
            style={{
              textAlign: 'center',
              fontSize: `${pt(12, zoom)}px`,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '1.5px',
              color: '#0F766E',
              marginBottom: pt(3, zoom),
            }}
          >
            {cv.targetRole}
          </div>
        )}
        {contacts.length > 0 && (
          <div style={{ textAlign: 'center', fontSize: `${pt(9, zoom)}px`, color: '#374151' }}>
            {contacts.map((c, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span style={{ color: '#9CA3AF', padding: `0 ${pt(4, zoom)}px` }}>|</span>}
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: '#0F766E', textDecoration: 'none' }}>
                    {c.label}
                  </a>
                ) : (
                  <span>{c.label}</span>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    ),
  });

  // 2. Summary
  if (cv.professionalSummary) {
    blocks.push(section('Summary'));
    blocks.push({
      key: 'summary',
      render: (zoom) => (
        <div style={{ color: '#1F2937', fontSize: `${pt(9.5, zoom)}px`, lineHeight: 1.42, textAlign: 'justify', paddingBottom: pt(4, zoom) }}>
          {cv.professionalSummary}
        </div>
      ),
    });
  }

  // 3. Skills — 2-column grid
  const hasSkills = cv.technicalSkills.length > 0 || (cv.coreCompetencies?.length || 0) > 0;
  if (hasSkills) {
    blocks.push(section('Skills'));
    if (cv.technicalSkills.length === 0 && cv.coreCompetencies) {
      blocks.push({
        key: 'skill-competencies',
        render: (zoom) => (
          <div style={{ color: '#1F2937', fontSize: `${pt(9.5, zoom)}px`, lineHeight: 1.42, paddingBottom: pt(4, zoom) }}>
            {cv.coreCompetencies.join(', ')}
          </div>
        ),
      });
    } else {
      blocks.push({
        key: 'skills-grid',
        render: (zoom) => (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', columnGap: pt(s.skillsColumnGap, zoom), paddingBottom: pt(4, zoom) }}>
            {cv.technicalSkills.map((cat, i) => (
              <div key={i} style={{ fontSize: `${pt(9.5, zoom)}px`, lineHeight: 1.42, marginBottom: pt(2.5, zoom), color: '#1F2937' }}>
                <span style={{ fontWeight: 700, color: '#0F172A' }}>{cat.category}: </span>
                <span style={{ color: '#374151' }}>{cat.skills.join(', ')}</span>
              </div>
            ))}
          </div>
        ),
      });
    }
  }

  // 4. Work Experience — role (navy) — company (teal), period right, loc below
  if (cv.workExperience.length > 0) {
    blocks.push(section('Work Experience'));
    cv.workExperience.forEach((exp, i) => {
      blocks.push({
        key: `exp-${i}-head`,
        keepAfter: 30,
        render: (zoom) => (
          <div style={{ paddingBottom: pt(2, zoom) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: `${pt(10.5, zoom)}px` }}>
                <span style={{ color: '#0F172A' }}>{exp.title}</span>
                {exp.company && <span style={{ color: '#0F766E' }}>{'  —  '}{exp.company}</span>}
              </span>
              {exp.dates && (
                <span style={{ fontSize: `${pt(9, zoom)}px`, color: '#6B7280', whiteSpace: 'nowrap' }}>{exp.dates}</span>
              )}
            </div>
            {exp.location && (
              <div style={{ fontSize: `${pt(9, zoom)}px`, color: '#6B7280', marginBottom: pt(3, zoom) }}>{exp.location}</div>
            )}
          </div>
        ),
      });
      exp.highlights.forEach((hl, j) => {
        blocks.push({ key: `exp-${i}-b${j}`, render: (zoom) => <HarvardBullet zoom={zoom} text={hl} /> });
      });
      blocks.push({ key: `exp-${i}-gap`, render: (zoom) => <div style={{ height: pt(5.5, zoom) }} /> });
    });
  }

  // 5. Projects — bold title + [year] + description + teal link
  if (cv.projects && cv.projects.length > 0) {
    const projYears: number[] = [];
    for (const pp of cv.projects) {
      const ym = /(19|20)\d{2}/.exec(pp.dates || '');
      if (ym) projYears.push(parseInt(ym[0], 10));
    }
    const range = projYears.length > 0 ? ` (${Math.min(...projYears)} \u2013 ${Math.max(...projYears)})` : '';
    blocks.push(section('Projects' + range));
    cv.projects.forEach((p, i) => {
      blocks.push({
        key: `proj-${i}`,
        keepAfter: 20,
        render: (zoom) => (
          <div style={{ marginBottom: pt(4, zoom) }}>
            <span style={{ fontWeight: 700, fontSize: `${pt(9.5, zoom)}px`, color: '#0F172A' }}>{p.name}</span>
            {p.dates && (
              <span style={{ fontSize: `${pt(9, zoom)}px`, color: '#6B7280' }}>{'  ['}{p.dates}{']'}</span>
            )}
            {p.description && (
              <div style={{ fontSize: `${pt(9.5, zoom)}px`, color: '#1F2937', lineHeight: 1.42 }}>{p.description}</div>
            )}
            {p.link && (
              <a href={p.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: `${pt(9.5, zoom)}px`, color: '#0F766E', textDecoration: 'none' }}>
                {displayUrl(p.link)}
              </a>
            )}
          </div>
        ),
      });
    });
  }

  // 6. Education — single line: institution (bold) — degree + period
  if (cv.education.length > 0) {
    blocks.push(section('Education'));
    cv.education.forEach((e, i) => {
      blocks.push({
        key: `edu-${i}`,
        render: (zoom) => (
          <div style={{ fontSize: `${pt(9.5, zoom)}px`, lineHeight: 1.42, marginBottom: pt(2, zoom) }}>
            <span style={{ fontWeight: 700, color: '#0F172A' }}>{e.institution}</span>
            <span style={{ color: '#1F2937' }}>
              {(e.degree ? '  —  ' + e.degree : '')}
              {e.dates ? '   ' + e.dates : ''}
            </span>
          </div>
        ),
      });
    });
  }

  // 7. Certifications — issuer (bold) — name (year)
  if (cv.certifications && cv.certifications.length > 0) {
    blocks.push(section('Certifications'));
    cv.certifications.forEach((cert, i) => {
      let issuer = '';
      let name = '';
      let date = '';
      if (typeof cert === 'string') {
        name = cert;
      } else {
        issuer = cert.issuer || '';
        name = cert.name || '';
        date = cert.date || '';
      }
      blocks.push({
        key: `cert-${i}`,
        render: (zoom) => (
          <div style={{ fontSize: `${pt(9.5, zoom)}px`, lineHeight: 1.42, marginBottom: pt(2, zoom) }}>
            {issuer && <span style={{ fontWeight: 700, color: '#0F172A' }}>{issuer}</span>}
            <span style={{ color: '#1F2937' }}>
              {(issuer ? '  —  ' : '') + name}
              {date ? ' (' + date + ')' : ''}
            </span>
          </div>
        ),
      });
    });
  }

  return blocks;
}

const HarvardBullet: React.FC<{ zoom: number; text: string }> = ({ zoom, text }) => {
  const clean = String(text || '').replace(/^[*•\-]\s*/, '').trim();
  if (!clean) return null;
  return (
    <div style={{ display: 'flex', fontSize: `${pt(9.5, zoom)}px`, lineHeight: 1.42, paddingBottom: pt(2.5, zoom), paddingLeft: pt(11, zoom) }}>
      <span style={{ color: '#0F766E', fontWeight: 700, flexShrink: 0, marginLeft: pt(-11, zoom), width: pt(11, zoom) }}>•</span>
      <span style={{ color: '#1F2937', textAlign: 'justify' }}>{clean}</span>
    </div>
  );
};

// ── Jake — Jake Ryan one-page developer resume ──
// black ink, uppercase name left, '—' bullets, black rules under
// headings, 2-column skills grid, tight 9px type.
// ── Atanu Pro — premium navy/blue layout ──
// navy name + gray title + contact, 2px accent rule under the header,
// uppercase section headings with a 2px accent bottom border, bullets with
// a 0.25in hanging indent, italic meta lines, 2-column skills grid,
// projects with links shown only when a public URL exists.
function buildAtanuProBlocks(cv: PdfCvShape, s: CvTemplateStyle): CvBlock[] {
  const blocks: CvBlock[] = [];
  const NAVY = '#1F2937';
  const GRAY = '#4B5563';
  const contacts = getContactItems(cv);
  const HANGING = 18; // 0.25in

  const section = (title: string): CvBlock => ({
    key: `sec-${title}`,
    keepAfter: 36,
    render: (zoom) => (
      <div style={{ margin: `${pt(s.sectionSpacing, zoom)}px 0 ${pt(6, zoom)}px` }}>
        <div
          style={{
            fontSize: `${pt(s.headingSize, zoom)}px`,
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: '1.2px',
            color: NAVY,
            paddingBottom: pt(4, zoom),
            borderBottom: `${Math.max(1, Math.round(pt(s.ruleWidth, zoom)))}px solid ${s.accent}`,
          }}
        >
          {title}
        </div>
      </div>
    ),
  });

  // 1. Header: name + title + contact + accent rule
  blocks.push({
    key: 'header',
    render: (zoom) => (
      <div style={{ marginBottom: pt(8, zoom) }}>
        <div style={{ fontSize: `${pt(s.nameSize, zoom)}px`, fontWeight: 800, color: NAVY, letterSpacing: '0.5px', textTransform: 'uppercase' }}>
          {cv.candidateName || 'CANDIDATE NAME'}
        </div>
        {cv.targetRole && (
          <div style={{ fontSize: `${pt(s.roleSize, zoom)}px`, fontWeight: 600, color: s.roleColor, marginTop: pt(2, zoom) }}>
            {cv.targetRole}
          </div>
        )}
        {contacts.length > 0 && (
          <div style={{ fontSize: `${pt(9, zoom)}px`, color: GRAY, marginTop: pt(4, zoom) }}>
            {contacts.map((c, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span style={{ color: '#9CA3AF', padding: `0 ${pt(5, zoom)}px` }}>|</span>}
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: s.accent, textDecoration: 'none' }}>{c.label}</a>
                ) : (
                  <span>{c.label}</span>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
        <div style={{ height: Math.max(1, Math.round(pt(s.ruleWidth, zoom))), background: s.accent, marginTop: pt(10, zoom) }} />
      </div>
    ),
  });

  // 2. Summary
  if (cv.professionalSummary) {
    blocks.push(section('Summary'));
    blocks.push({
      key: 'summary',
      render: (zoom) => (
        <div style={{ color: NAVY, fontSize: `${pt(s.bodySize, zoom)}px`, lineHeight: s.lineHeight, textAlign: 'justify', paddingBottom: pt(4, zoom) }}>
          {cv.professionalSummary}
        </div>
      ),
    });
  }

  // 3. Skills — 2-column grid (shared column gap)
  const skillCats = cv.technicalSkills || [];
  const hasCore = (cv.coreCompetencies || []).length > 0;
  if (skillCats.length > 0 || hasCore) {
    blocks.push(section('Skills'));
    if (skillCats.length > 0) {
      blocks.push({
        key: 'skills-grid',
        render: (zoom) => (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', columnGap: pt(s.skillsColumnGap, zoom), paddingBottom: pt(4, zoom) }}>
            {skillCats.map((cat, i) => (
              <div key={i} style={{ fontSize: `${pt(s.skillCategorySize, zoom)}px`, lineHeight: s.lineHeight, marginBottom: pt(2.5, zoom), color: NAVY }}>
                <span style={{ fontWeight: 700, color: NAVY }}>{cat.category}: </span>
                <span style={{ color: GRAY }}>{cat.skills.join(', ')}</span>
              </div>
            ))}
          </div>
        ),
      });
    } else {
      blocks.push({
        key: 'skill-competencies',
        render: (zoom) => (
          <div style={{ color: NAVY, fontSize: `${pt(s.bodySize, zoom)}px`, lineHeight: s.lineHeight, paddingBottom: pt(4, zoom) }}>
            {cv.coreCompetencies.join(', ')}
          </div>
        ),
      });
    }
  }

  // 4. Experience — title/company left, italic dates right, hanging bullets
  if (cv.workExperience.length > 0) {
    blocks.push(section('Experience'));
    cv.workExperience.forEach((exp, i) => {
      blocks.push({
        key: `exp-${i}-head`,
        keepAfter: 28,
        render: (zoom) => (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, paddingBottom: pt(2, zoom) }}>
            <span style={{ fontWeight: 700, fontSize: `${pt(s.expTitleSize, zoom)}px`, color: NAVY }}>
              {exp.title}
              {exp.company && <span style={{ color: GRAY }}>{'  —  '}{exp.company}</span>}
            </span>
            <span style={{ fontStyle: 'italic', fontSize: `${pt(8.5, zoom)}px`, color: GRAY, whiteSpace: 'nowrap' }}>
              {[exp.dates, exp.location].filter(Boolean).join('  |  ')}
            </span>
          </div>
        ),
      });
      exp.highlights.forEach((hl, j) => {
        blocks.push({
          key: `exp-${i}-b${j}`,
          render: (zoom) => (
            <div style={{ display: 'flex', fontSize: `${pt(s.bulletSize, zoom)}px`, lineHeight: s.lineHeight, paddingBottom: pt(2, zoom), paddingLeft: pt(HANGING, zoom) }}>
              <span style={{ color: s.accent, fontWeight: 700, flexShrink: 0, marginLeft: pt(-HANGING, zoom), width: pt(HANGING, zoom) }}>•</span>
              <span style={{ color: NAVY, textAlign: 'justify' }}>{String(hl || '').replace(/^[*•\-]\s*/, '').trim()}</span>
            </div>
          ),
        });
      });
      blocks.push({ key: `exp-${i}-gap`, render: (zoom) => <div style={{ height: pt(5.5, zoom) }} /> });
    });
  }

  // 5. Projects — link line only when a public URL exists
  if (cv.projects && cv.projects.length > 0) {
    blocks.push(section('Projects'));
    cv.projects.forEach((p, i) => {
      blocks.push({
        key: `proj-${i}`,
        keepAfter: 20,
        render: (zoom) => (
          <div style={{ marginBottom: pt(4, zoom) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: `${pt(s.expTitleSize, zoom)}px`, color: NAVY }}>{p.name}</span>
              {p.dates && <span style={{ fontStyle: 'italic', fontSize: `${pt(8.5, zoom)}px`, color: GRAY }}>[{p.dates}]</span>}
            </div>
            {p.description && (
              <div style={{ fontSize: `${pt(s.bodySize, zoom)}px`, color: NAVY, lineHeight: s.lineHeight, textAlign: 'justify', marginTop: pt(2, zoom) }}>
                {p.description}
              </div>
            )}
            {p.link && (
              <a href={p.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: `${pt(s.bodySize, zoom)}px`, color: s.accent, textDecoration: 'none' }}>
                {displayUrl(p.link)}
              </a>
            )}
          </div>
        ),
      });
    });
  }

  // 6. Education — italic dates
  if (cv.education.length > 0) {
    blocks.push(section('Education'));
    cv.education.forEach((e, i) => {
      blocks.push({
        key: `edu-${i}`,
        render: (zoom) => (
          <div style={{ fontSize: `${pt(s.bodySize, zoom)}px`, lineHeight: s.lineHeight, marginBottom: pt(2, zoom) }}>
            <span style={{ fontWeight: 700, color: NAVY }}>{e.institution}</span>
            <span style={{ color: NAVY }}>
              {(e.degree ? '  —  ' + e.degree : '')}
              {e.dates ? <span style={{ fontStyle: 'italic', color: GRAY }}>{'   ' + e.dates}</span> : null}
            </span>
          </div>
        ),
      });
    });
  }

  // 7. Certifications
  if (cv.certifications && cv.certifications.length > 0) {
    blocks.push(section('Certifications'));
    cv.certifications.forEach((cert, i) => {
      let nameT = '';
      let issuer = '';
      if (typeof cert === 'string') nameT = cert;
      else { nameT = cert.name || ''; issuer = cert.issuer || ''; }
      blocks.push({
        key: `cert-${i}`,
        render: (zoom) => (
          <div style={{ fontSize: `${pt(s.bodySize, zoom)}px`, lineHeight: s.lineHeight, marginBottom: pt(2, zoom) }}>
            {issuer && <span style={{ fontWeight: 700, color: NAVY }}>{issuer}</span>}
            <span style={{ color: NAVY }}>{(issuer ? '  —  ' : '') + nameT}</span>
          </div>
        ),
      });
    });
  }

  return blocks;
}

function buildJakeBlocks(cv: PdfCvShape, s: CvTemplateStyle): CvBlock[] {
  const blocks: CvBlock[] = [];
  const contacts = getContactItems(cv);

  const section = (title: string): CvBlock => ({
    key: `sec-${title}`,
    keepAfter: 30,
    render: (zoom) => (
      <div style={{ margin: `${pt(8, zoom)}px 0 ${pt(5, zoom)}px` }}>
        <div style={{ fontSize: `${pt(11, zoom)}px`, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.2px', color: '#111111', paddingBottom: pt(3, zoom), borderBottom: '1px solid #111111' }}>
          {title}
        </div>
      </div>
    ),
  });

  blocks.push({
    key: 'header',
    render: (zoom) => (
      <div style={{ marginBottom: pt(8, zoom) }}>
        <div style={{ fontSize: `${pt(24, zoom)}px`, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', color: '#111111' }}>
          {cv.candidateName || 'CANDIDATE NAME'}
        </div>
        {cv.targetRole && (
          <div style={{ fontSize: `${pt(11.5, zoom)}px`, fontWeight: 600, color: '#555555', margin: `${pt(2, zoom)}px 0 ${pt(6, zoom)}px` }}>
            {cv.targetRole}
          </div>
        )}
        {contacts.length > 0 && (
          <div style={{ fontSize: `${pt(9.5, zoom)}px`, color: '#444444' }}>
            {contacts.map((c, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span style={{ color: '#AAAAAA', padding: `0 ${pt(5, zoom)}px` }}>|</span>}
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: '#111111', textDecoration: 'none', borderBottom: '1px solid #BBBBBB' }}>{c.label}</a>
                ) : (
                  <span>{c.label}</span>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    ),
  });

  if (cv.professionalSummary) {
    blocks.push(section('Summary'));
    blocks.push({
      key: 'summary',
      render: (zoom) => (
        <div style={{ fontSize: `${pt(9, zoom)}px`, color: '#1A1A1A', lineHeight: 1.35, textAlign: 'justify', paddingBottom: pt(4, zoom) }}>
          {cv.professionalSummary}
        </div>
      ),
    });
  }

  if (cv.technicalSkills.length > 0) {
    blocks.push(section('Skills'));
      blocks.push({
        key: 'skills-grid',
        render: (zoom) => (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', columnGap: pt(s.skillsColumnGap, zoom), paddingBottom: pt(4, zoom) }}>
            {cv.technicalSkills.map((cat, i) => (
              <div key={i} style={{ fontSize: `${pt(9, zoom)}px`, lineHeight: 1.35, marginBottom: pt(2.5, zoom) }}>
                <span style={{ fontWeight: 700, color: '#111111' }}>{cat.category}: </span>
                <span style={{ color: '#1A1A1A' }}>{cat.skills.join(', ')}</span>
              </div>
            ))}
          </div>
        ),
      });
  }

  if (cv.workExperience.length > 0) {
    blocks.push(section('Experience'));
    cv.workExperience.forEach((exp, i) => {
      blocks.push({
        key: `exp-${i}-head`,
        keepAfter: 25,
        render: (zoom) => (
          <div style={{ marginBottom: pt(2, zoom) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontWeight: 700, fontSize: `${pt(9.5, zoom)}px`, color: '#111111' }}>
                {exp.title}
                {exp.company && <span style={{ color: '#555555' }}>{'  —  '}{exp.company}</span>}
              </span>
              {exp.dates && <span style={{ fontSize: `${pt(8.5, zoom)}px`, color: '#777777', whiteSpace: 'nowrap' }}>{exp.dates}</span>}
            </div>
            {exp.location && <div style={{ fontSize: `${pt(9, zoom)}px`, color: '#777777' }}>{exp.location}</div>}
          </div>
        ),
      });
      exp.highlights.forEach((hl, j) => {
        blocks.push({ key: `exp-${i}-b${j}`, render: (zoom) => <JakeBullet zoom={zoom} text={hl} /> });
      });
      blocks.push({ key: `exp-${i}-gap`, render: () => <div style={{ height: 4 }} /> });
    });
  }

  if (cv.projects && cv.projects.length > 0) {
    blocks.push(section('Projects'));
    cv.projects.forEach((p, i) => {
      blocks.push({
        key: `proj-${i}`,
        keepAfter: 18,
        render: (zoom) => (
          <div style={{ marginBottom: pt(3, zoom) }}>
            <span style={{ fontWeight: 700, fontSize: `${pt(9.5, zoom)}px`, color: '#111111' }}>{p.name}</span>
            {p.dates && <span style={{ fontSize: `${pt(8.5, zoom)}px`, color: '#777777' }}>{'  ['}{p.dates}{']'}</span>}
            {p.description && (
              <div style={{ fontSize: `${pt(9, zoom)}px`, color: '#1A1A1A', lineHeight: 1.35 }}>{p.description}</div>
            )}
            {p.link && (
              <a href={p.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: `${pt(9, zoom)}px`, color: '#111111', textDecoration: 'none', borderBottom: '1px solid #BBBBBB' }}>
                {displayUrl(p.link)}
              </a>
            )}
          </div>
        ),
      });
    });
  }

  if (cv.education.length > 0) {
    blocks.push(section('Education'));
    cv.education.forEach((e, i) => {
      blocks.push({
        key: `edu-${i}`,
        render: (zoom) => (
          <div style={{ fontSize: `${pt(9.5, zoom)}px`, lineHeight: 1.35, marginBottom: pt(2.5, zoom) }}>
            <span style={{ fontWeight: 700, color: '#111111' }}>{e.institution}</span>
            <span style={{ color: '#1A1A1A' }}>{(e.degree ? '  —  ' + e.degree : '')}{e.dates ? '   ' + e.dates : ''}</span>
          </div>
        ),
      });
    });
  }

  if (cv.certifications && cv.certifications.length > 0) {
    blocks.push(section('Certifications'));
    cv.certifications.forEach((cert, i) => {
      let nameT = '';
      let issuer = '';
      if (typeof cert === 'string') nameT = cert;
      else { nameT = cert.name || ''; issuer = cert.issuer || ''; }
      blocks.push({
        key: `cert-${i}`,
        render: (zoom) => (
          <div style={{ fontSize: `${pt(9.5, zoom)}px`, marginBottom: pt(2.5, zoom) }}>
            {issuer && <span style={{ fontWeight: 700, color: '#111111' }}>{issuer}</span>}
            <span style={{ color: '#1A1A1A' }}>{(issuer ? '  —  ' : '') + nameT}</span>
          </div>
        ),
      });
    });
  }

  return blocks;
}

const JakeBullet: React.FC<{ zoom: number; text: string }> = ({ zoom, text }) => {
  const clean = String(text || '').replace(/^[*•\-]\s*/, '').trim();
  if (!clean) return null;
  return (
    <div style={{ display: 'flex', fontSize: `${pt(9, zoom)}px`, lineHeight: 1.35, paddingBottom: pt(1.5, zoom), paddingLeft: pt(12, zoom) }}>
      <span style={{ color: '#111111', flexShrink: 0, marginLeft: pt(-12, zoom), width: pt(12, zoom) }}>—</span>
      <span style={{ color: '#1A1A1A', textAlign: 'justify' }}>{clean}</span>
    </div>
  );
};

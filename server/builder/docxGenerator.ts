import PDFDocument from 'pdfkit';
import path from 'node:path';

// Embed REAL font files (LiberationSans — metric-compatible with
// Helvetica, ships inside pdfjs-dist). Standard-14 fonts are NOT embedded
// in the PDF, which makes their glyphs unextractable for ATS text-layer
// verification. Embedded fonts always map.
function registerEmbeddedFonts(doc: PDFKit.PDFDocument): void {
  try {
    const fontDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts');
    doc.registerFont('HelveticaEmbed', path.join(fontDir, 'LiberationSans-Regular.ttf'));
    doc.registerFont('HelveticaEmbed-Bold', path.join(fontDir, 'LiberationSans-Bold.ttf'));
    doc.registerFont('HelveticaEmbed-Oblique', path.join(fontDir, 'LiberationSans-Italic.ttf'));
  } catch {
    // best-effort: fall back to standard fonts (extraction may degrade)
  }
}
import { TailoredCv } from '../../src/types.js';
import { CV_TEMPLATE_GEOMETRY, cvSkillsColumnWidth } from '../../src/constants/cvTemplateConfig.js';
import { displayUrl } from '../../src/lib/displayUrl.js';

interface ContactLink {
  type: 'email' | 'phone' | 'location' | 'linkedin' | 'github' | 'website';
  label: string;
  url?: string;
}

function getContactLinks(cv: TailoredCv): ContactLink[] {
  const links: ContactLink[] = [];
  const c = cv.contactInfo || {};

  if (c.email) {
    links.push({
      type: 'email',
      label: String(c.email),
      url: `mailto:${c.email}`,
    });
  }

  if (c.phone) {
    links.push({
      type: 'phone',
      label: String(c.phone),
      url: `tel:${String(c.phone).replace(/[^\d+]/g, '')}`,
    });
  }

  if (c.location) {
    links.push({
      type: 'location',
      label: String(c.location),
    });
  }

  if (c.linkedin) {
    let url = String(c.linkedin).trim();
    if (!url.startsWith('http')) {
      if (url.includes('linkedin.com')) {
        url = `https://${url}`;
      } else {
        const handle = url.replace(/^\/?in\//, '').replace(/^\//, '');
        url = `https://linkedin.com/in/${handle}`;
      }
    }
    links.push({
      type: 'linkedin',
      label: 'LinkedIn',
      url,
    });
  }

  if (c.github) {
    let url = String(c.github).trim();
    if (!url.startsWith('http')) {
      if (url.includes('github.com')) {
        url = `https://${url}`;
      } else {
        const handle = url.replace(/^\//, '');
        url = `https://github.com/${handle}`;
      }
    }
    links.push({
      type: 'github',
      label: 'GitHub',
      url,
    });
  }

  if (c.website) {
    let url = String(c.website).trim();
    if (!url.startsWith('http')) {
      url = `https://${url}`;
    }
    links.push({
      type: 'website',
      label: 'Portfolio',
      url,
    });
  }

  return links;
}

/**
 * Helper to ensure URLs have http/https/mailto/tel prefix
 */
function normalizeUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const trimmed = String(url).trim();
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed) || /^tel:/i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}


function sanitizeText(str: any): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2022/g, '•')
    .replace(/\u2026/g, '...')
    .replace(/[^\x00-\xFF]/g, '')
    .trim();
}

/**
 * Generate a PDF buffer matching the exact top-notch ATS specification with clickable hyperlinks.
 * `template` mirrors the frontend CV_TEMPLATE_STYLES so the downloaded PDF matches the preview.
 */
export function generatePdfBuffer(cv: TailoredCv, template: string = 'harvard'): Promise<Buffer> {
  if (template !== 'harvard' && template !== 'jake' && template !== 'atanu' && template !== 'atanu-pro') {
    template = 'harvard';
  }
  if (template === 'harvard') {
    return generateHarvardPdf(cv);
  }
  if (template === 'jake') {
    return generateJakePdf(cv);
  }
  if (template === 'atanu') {
    return generateAtanuPdf(cv);
  }
  if (template === 'atanu-pro') {
    return generateAtanuProPdf(cv);
  }
}


/**
 * Draw one entry-header line: left text + right-aligned text on the same
 * line, WITHOUT overlap — the right text is positioned on the same
 * baseline using measured heights, even when the left text wraps.
 */
function entryHeaderLine(
  doc: any,
  opts: {
    left: string;
    right?: string;
    x: number;
    rightEdge: number;
    size?: number;
    leftBold?: boolean;
    rightBold?: boolean;
    color?: string;
    rightColor?: string;
  }
): number {
  const size = opts.size || 10.5;
  const color = opts.color || '#111111';
  const rightColor = opts.rightColor || color;
  const leftW = opts.right ? Math.max(140, (opts.rightEdge - opts.x) * 0.6) : opts.rightEdge - opts.x;
  const startY = doc.y;
  doc.font(opts.leftBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
  const leftH = doc.heightOfString(opts.left, { width: leftW });
  doc.text(opts.left, opts.x, doc.y, { width: leftW });
  pdfDebug('entryHeader-left', opts.x, startY, leftW, leftH, doc.y);
  if (opts.right) {
    doc.font(opts.rightBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(rightColor);
    const rightW = Math.min(doc.widthOfString(opts.right), (opts.rightEdge - opts.x) * 0.4);
    const rightY = doc.y - Math.max(0, leftH - 12);
    doc.text(opts.right, opts.rightEdge - rightW, rightY, { width: rightW });
    pdfDebug('entryHeader-right', opts.rightEdge - rightW, rightY, rightW, 12, doc.y);
  }
  return Math.max(leftH, 12);
}

const PDF_DEBUG = process.env.PDF_DEBUG === '1';
/** Temporary diagnostic: logs every key PDF element's placement. */
function pdfDebug(el: string, x: number, y: number, w: number, h: number, nextY: number) {
  if (PDF_DEBUG) console.log(`[pdf-debug] ${el} x=${x.toFixed(1)} y=${y.toFixed(1)} w=${w.toFixed(1)} h=${h.toFixed(1)} nextY=${nextY.toFixed(1)}`);
}

function generateAtanuPdf(cv: TailoredCv): Promise<Buffer> {
  const geo = CV_TEMPLATE_GEOMETRY.atanu;
  const ACCENT = '#0F766E';
  const NAVY = '#0F172A';
  const BODY = '#1F2937';
  const MUTED = '#6B7280';
  const FAINT = '#9CA3AF';

  const MARGIN_X = geo.marginLeft;  // 36 pt (shared)
  const MARGIN_Y = geo.marginTop;   // 32.4 pt (shared)
  const LINE_GAP = geo.pdfLineGap;  // 1.2 pt (shared)
  const PAGE_W = 8.5 * 72;    // 612
  const PAGE_H = 11 * 72;     // 792
  const leftMargin = MARGIN_X;
  const rightMargin = PAGE_W - MARGIN_X; // 576
  const contentWidth = rightMargin - leftMargin; // 540
  const pageBottom = PAGE_H - MARGIN_Y;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: MARGIN_Y, bottom: MARGIN_Y, left: MARGIN_X, right: MARGIN_X },
    });

    // Embed REAL font files (LiberationSans — metric-compatible with
    // Helvetica, ships inside pdfjs-dist). Standard-14 fonts are NOT
    // embedded in the PDF, which makes their glyphs unextractable for
    // ATS text-layer verification. Embedded fonts always map.
    try {
      const fontDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts');
      console.warn('[PDF] fontDir:', fontDir);
      doc.registerFont('HelveticaEmbed', path.join(fontDir, 'LiberationSans-Regular.ttf'));
      doc.registerFont('HelveticaEmbed-Bold', path.join(fontDir, 'LiberationSans-Bold.ttf'));
      doc.registerFont('HelveticaEmbed-Oblique', path.join(fontDir, 'LiberationSans-Italic.ttf'));
    } catch (fontErr: any) {
      // Embedding is best-effort: fall back to standard fonts (extraction
      // may degrade) but never fail PDF generation over fonts.
      console.warn('[PDF] font embedding unavailable:', String(fontErr?.message || fontErr).slice(0, 120));
    }

    const buffers: Buffer[] = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', (err) => reject(err));

    const ensurePageSpace = (neededHeight: number) => {
      if (doc.y + neededHeight > pageBottom) {
        doc.addPage();
        doc.y = MARGIN_Y;
      }
    };

    // ── Header: name + contact ──
    const name = sanitizeText(cv.candidateName).toUpperCase() || 'CANDIDATE NAME';
    ensurePageSpace(60);
    const NAME_SIZE = 24;
    const NAME_SPACING = 3;
    doc.font('HelveticaEmbed-Bold').fontSize(NAME_SIZE);
    let nameWidth = 0;
    for (const ch of Array.from(name)) nameWidth += doc.widthOfString(ch) + NAME_SPACING;
    nameWidth -= NAME_SPACING;
    const nameX = leftMargin + Math.max(0, (contentWidth - nameWidth) / 2);
    const nameY = doc.y; // capture once — pdfkit advances doc.y on EVERY text() call
    pdfDebug('name', nameX, nameY, nameWidth, NAME_SIZE * 1.2, nameY + NAME_SIZE * 1.2);
    let cx = nameX;
    for (const ch of Array.from(name)) {
      doc.fillColor(NAVY).text(ch, cx, nameY, { lineBreak: false });
      cx += doc.widthOfString(ch) + NAME_SPACING;
    }
    // lineBreak:false leaves doc.y untouched — advance the full name line + 3px
    doc.y = nameY + NAME_SIZE * 1.2 + 3;

    // Role subtitle — 12px bold uppercase accent, 1.5px letter-spacing
    if (cv.targetRole) {
      const role = sanitizeText(cv.targetRole).toUpperCase();
      if (role) {
        ensurePageSpace(20);
        const ROLE_SIZE = 12;
        const ROLE_SPACING = 1.5;
        const roleY = doc.y;
        doc.font('HelveticaEmbed-Bold').fontSize(ROLE_SIZE);
        let roleW = 0;
        for (const ch of Array.from(role)) roleW += doc.widthOfString(ch) + ROLE_SPACING;
        roleW -= ROLE_SPACING;
        let rx = leftMargin + Math.max(0, (contentWidth - roleW) / 2);
        for (const ch of Array.from(role)) {
          doc.fillColor(ACCENT).text(ch, rx, roleY, { lineBreak: false });
          rx += doc.widthOfString(ch) + ROLE_SPACING;
        }
        // lineBreak:false leaves doc.y untouched — advance the role line + 3px
        doc.y = roleY + ROLE_SIZE * 1.2 + 3;
      }
    }

    const contactLinks = getContactLinks(cv);
    if (contactLinks.length > 0) {
      ensurePageSpace(20);
      const sep = '  |  ';
      const sepWidth = doc.widthOfString(sep);
      const itemsMeasured = contactLinks
        .map((item) => {
          const cleanLabel = sanitizeText(item.label);
          if (!cleanLabel) return null;
          const w = doc.widthOfString(cleanLabel);
          return { item, cleanLabel, w };
        })
        .filter((x): x is { item: typeof contactLinks[0]; cleanLabel: string; w: number } => x !== null);

      if (itemsMeasured.length > 0) {
        let totalWidth = itemsMeasured.reduce((sum, el) => sum + el.w, 0);
        totalWidth += (itemsMeasured.length - 1) * sepWidth;

        const currentY = doc.y;
        let currentX = leftMargin + Math.max(0, (contentWidth - totalWidth) / 2);

        itemsMeasured.forEach(({ item, cleanLabel, w }, idx) => {
          const normUrl = item.url ? normalizeUrl(item.url) : undefined;
          if (normUrl) {
            doc.fillColor(ACCENT).text(cleanLabel, currentX, currentY, { lineBreak: false });
            doc.link(currentX, currentY, w, 10, normUrl);
          } else {
            doc.fillColor('#374151').text(cleanLabel, currentX, currentY, { lineBreak: false });
          }
          currentX += w;

          if (idx < itemsMeasured.length - 1) {
            doc.fillColor(FAINT).text(sep, currentX, currentY, { lineBreak: false });
            currentX += sepWidth;
          }
        });

        doc.x = leftMargin;
        doc.y = currentY + 14;
      }
    }

    // ── Section header: 11px uppercase teal + solid teal rule ──
    const renderSectionHeader = (title: string) => {
      ensurePageSpace(40);
      doc.x = leftMargin;
      doc.moveDown(0.74); // 10px above (0.74 × ~13.5pt line)
      const headY = doc.y;
      const secTitle = title.toUpperCase();
      doc.font('HelveticaEmbed').fontSize(11); // normal weight
      let cx = leftMargin;
      for (const ch of Array.from(secTitle)) {
        doc.fillColor(ACCENT).text(ch, cx, headY, { lineBreak: false });
        cx += doc.widthOfString(ch) + 1.5;
      }
      doc.y = headY + 11 * 1.2; // char loop didn't advance doc.y — move past the heading line
      const ruleY = doc.y + 2; // 2px padding below heading text
      pdfDebug('section-heading', leftMargin, headY, contentWidth, doc.y - headY, ruleY + 6);
      doc.moveTo(leftMargin, ruleY).lineTo(rightMargin, ruleY).lineWidth(1.2).strokeColor(ACCENT).stroke();
      doc.y = ruleY + 6; // 6px below the rule
      doc.x = leftMargin;
    };

    // ── Bullet: teal • with 11px text indent, justified ──
    const renderBullet = (text: string, linkUrl?: string) => {
      if (!text) return;
      const clean = sanitizeText(String(text).replace(/^[*•\-]\s*/, '').trim());
      if (!clean) return;

      // Bullets are atomic (mirrors the preview's block pagination): a bullet
      // that does not fit on the current page moves whole to the next.
      const bulletH = doc.heightOfString(clean, { width: contentWidth - 11, lineGap: LINE_GAP });
      ensurePageSpace((isFinite(bulletH) && bulletH > 0 ? bulletH : 12) + 2);
      const bulletX = leftMargin;
      const textX = leftMargin + 11;
      const tWidth = contentWidth - 11;
      const currentY = doc.y;

      doc.font('HelveticaEmbed').fontSize(9.5).fillColor(ACCENT).text('\u2022', bulletX, currentY, { lineBreak: false });

      const normUrl = linkUrl ? normalizeUrl(linkUrl) : undefined;
      doc.font('HelveticaEmbed').fontSize(9.5).fillColor(BODY);
      if (normUrl) {
        doc.fillColor(ACCENT).text(clean, textX, currentY, { width: tWidth, lineGap: LINE_GAP, align: 'justify' });
        const rawH = doc.heightOfString(clean, { width: tWidth });
        const h = isFinite(rawH) && rawH > 0 ? rawH : 12;
        doc.link(textX, currentY, tWidth, h, normUrl);
      } else {
        doc.fillColor(BODY).text(clean, textX, currentY, { width: tWidth, lineGap: LINE_GAP, align: 'justify' });
      }

      doc.x = leftMargin;
      doc.moveDown(0.18); // 2.5px between bullets
    };

    // ── Summary ──
    if (cv.professionalSummary) {
      const cleanSummary = sanitizeText(cv.professionalSummary);
      if (cleanSummary) {
        renderSectionHeader('Summary');
        ensurePageSpace(20);
        doc.font('HelveticaEmbed').fontSize(9.5).fillColor(BODY).text(cleanSummary, leftMargin, doc.y, {
          width: contentWidth,
          lineGap: LINE_GAP,
          align: 'justify',
        });
        doc.x = leftMargin;
        doc.moveDown(0.2);
      }
    }

    // ── Skills: 2-column grid ──
    const skillCats = Array.isArray(cv.technicalSkills)
      ? cv.technicalSkills
          .map((cat) => ({
            name: sanitizeText(cat.category),
            list: Array.isArray(cat.skills) ? cat.skills.map((s) => sanitizeText(s)).filter(Boolean).join(', ') : '',
          }))
          .filter((c) => c.name || c.list)
      : [];
    const useCompetencies = skillCats.length === 0 && Array.isArray(cv.coreCompetencies) && cv.coreCompetencies.length > 0;

    if (skillCats.length > 0 || useCompetencies) {
      renderSectionHeader('Skills');

      if (useCompetencies) {
        ensurePageSpace(15);
        doc.font('HelveticaEmbed').fontSize(9.5).fillColor(BODY).text(
          cv.coreCompetencies.map((c) => sanitizeText(c)).filter(Boolean).join(', '),
          leftMargin, doc.y, { width: contentWidth, lineGap: LINE_GAP }
        );
        doc.x = leftMargin;
        doc.moveDown(0.2);
      } else {
        // Row-wise pairing — identical to the browser preview's CSS grid
        // (categories flow left→right, row by row; each row's height is the
        // taller of its two cells; a row never splits across pages).
        const colGap = geo.skillsColumnGap; // 18 pt (shared)
        const colW = cvSkillsColumnWidth('atanu'); // (contentWidth - colGap) / 2, shared formula
        const leftX = leftMargin;
        const rightX = leftMargin + colW + colGap;
        const cellText = (cat: { name: string; list: string }) => (cat.name ? `${cat.name}: ${cat.list}` : cat.list);
        const cellHeight = (cat: { name: string; list: string }) => Math.max(0, doc.heightOfString(cellText(cat), { width: colW, lineGap: LINE_GAP }));
        const rowGap = 2.5; // mirrors the preview's per-cell marginBottom (pt(2.5))

        for (let i = 0; i < skillCats.length; i += 2) {
          const left = skillCats[i];
          const right = skillCats[i + 1];
          const rowH = Math.max(left ? cellHeight(left) : 0, right ? cellHeight(right) : 0) + rowGap;
          ensurePageSpace(rowH + 4);
          const rowY = doc.y;
          if (left) {
            doc.font('HelveticaEmbed-Bold').fontSize(9.5).fillColor(NAVY);
            doc.text(left.name ? left.name + ': ' : '', leftX, rowY, { continued: true, width: colW });
            doc.font('HelveticaEmbed').fillColor('#374151').text(left.list, { width: colW, lineGap: LINE_GAP });
          }
          if (right) {
            doc.font('HelveticaEmbed-Bold').fontSize(9.5).fillColor(NAVY);
            doc.text(right.name ? right.name + ': ' : '', rightX, rowY, { continued: true, width: colW });
            doc.font('HelveticaEmbed').fillColor('#374151').text(right.list, { width: colW, lineGap: LINE_GAP });
          }
          doc.y = rowY + rowH;
          doc.x = leftMargin;
        }

        doc.moveDown(0.2);
        doc.moveDown(0.2);
      }
    }

    // ── Work Experience ──
    if (cv.workExperience && cv.workExperience.length > 0) {
      renderSectionHeader('Work Experience');

      for (const exp of cv.workExperience) {
        if (!exp) continue;
        ensurePageSpace(45);

        const title = sanitizeText(exp.title);
        const company = sanitizeText(exp.company);
        const period = sanitizeText(exp.dates);
        const loc = sanitizeText(exp.location);
        const entryY = doc.y;

        // Line 1: role (navy bold) — company (teal bold), period right-aligned
        const leftText = title + (company ? '  \u2014  ' + company : '');
        const leftW = contentWidth - 150;
        doc.font('HelveticaEmbed-Bold').fontSize(10.5).fillColor(NAVY);
        const leftH = doc.heightOfString(leftText, { width: leftW });
        doc.text(title, leftMargin, entryY, { continued: true });
        doc.fillColor(ACCENT).text(company ? '  \u2014  ' + company : '', { width: leftW });
        doc.x = leftMargin;

        if (period) {
          doc.font('HelveticaEmbed').fontSize(9).fillColor(MUTED);
          doc.text(period, leftMargin + contentWidth - doc.widthOfString(period), entryY + Math.max(0, leftH - 12), { width: doc.widthOfString(period) });
        }
        doc.y = entryY + Math.max(leftH, 12);

        if (loc) {
          ensurePageSpace(12);
          doc.font('HelveticaEmbed').fontSize(9).fillColor(MUTED).text(loc, leftMargin, doc.y, { width: contentWidth });
        }
        doc.x = leftMargin;
        doc.moveDown(0.1);

        if (Array.isArray(exp.highlights)) {
          for (const hl of exp.highlights) renderBullet(hl);
        }
        doc.x = leftMargin;
        doc.moveDown(0.5); // 8px between jobs
      }
    }

    // ── Projects (title bold navy + [year] + description) ──
    if (cv.projects && cv.projects.length > 0) {
      const projYears: number[] = [];
      for (const pp of cv.projects) {
        const ym = /(19|20)\d{2}/.exec(sanitizeText(pp.dates));
        if (ym) projYears.push(parseInt(ym[0], 10));
      }
      const range = projYears.length > 0 ? ` (${Math.min(...projYears)} \u2013 ${Math.max(...projYears)})` : '';
      renderSectionHeader('Projects' + range);

      for (const proj of cv.projects) {
        if (!proj) continue;
        ensurePageSpace(35);

        const pName = sanitizeText(proj.name);
        const pDates = sanitizeText(proj.dates);
        const normLink = proj.link ? normalizeUrl(proj.link) : undefined;
        const projY = doc.y;

        const pLeftW = contentWidth - 130;
        doc.font('HelveticaEmbed-Bold').fontSize(9.5).fillColor(NAVY);
        const pH = doc.heightOfString(pName, { width: pLeftW });
        doc.text(pName, leftMargin, projY, { width: pLeftW });
        if (pDates) {
          const tag = '  [' + pDates + ']';
          doc.font('HelveticaEmbed').fontSize(9).fillColor(MUTED);
          doc.text(tag, leftMargin + contentWidth - doc.widthOfString(tag), projY + Math.max(0, pH - 12), { width: doc.widthOfString(tag) });
        }
        doc.y = projY + Math.max(pH, 12);
        doc.x = leftMargin;
        doc.moveDown(0.05);

        if (proj.description) {
          const desc = sanitizeText(proj.description);
          if (desc) {
            ensurePageSpace(15);
            doc.font('HelveticaEmbed').fontSize(9.5).fillColor(BODY).text(desc, leftMargin, doc.y, {
              width: contentWidth,
              lineGap: LINE_GAP,
            });
            doc.x = leftMargin;
            doc.moveDown(0.05);
          }
        }
        if (normLink) {
          ensurePageSpace(12);
          const ly = doc.y;
          const disp = displayUrl(proj.link);
          doc.font('HelveticaEmbed').fontSize(9.5).fillColor(ACCENT).text(disp, leftMargin, ly, { width: contentWidth });
          doc.link(leftMargin, ly, Math.min(doc.widthOfString(disp), contentWidth), Math.max(doc.heightOfString(disp, { width: contentWidth }), 10), normLink);
          doc.x = leftMargin;
        }
        doc.moveDown(0.3); // 4px between projects
      }
    }

    // ── Education (single line: bold institution — degree + period) ──
    if (cv.education && cv.education.length > 0) {
      renderSectionHeader('Education');
      for (const edu of cv.education) {
        if (!edu) continue;
        ensurePageSpace(15);
        const inst = sanitizeText(edu.institution);
        const degree = sanitizeText(edu.degree);
        const eDates = sanitizeText(edu.dates);
        const eduY = doc.y;

        doc.font('HelveticaEmbed-Bold').fontSize(9.5).fillColor(NAVY);
        const eduText = inst + (degree ? '  \u2014  ' + degree : '') + (eDates ? '  \u00A0\u00A0' + eDates : '');
        const eduH = doc.heightOfString(eduText, { width: contentWidth });
        doc.text(inst, leftMargin, eduY, { continued: true });
        doc.font('HelveticaEmbed').fillColor(BODY).text((degree ? '  \u2014  ' + degree : '') + (eDates ? '  \u00A0\u00A0' + eDates : ''), { width: contentWidth });
        doc.y = eduY + Math.max(eduH, 12);
        doc.x = leftMargin;
        doc.moveDown(0.25);
      }
    }

    // ── Certifications (bold issuer — name (year)) ──
    if (cv.certifications && cv.certifications.length > 0) {
      renderSectionHeader('Certifications');
      for (const cert of cv.certifications) {
        if (!cert) continue;
        ensurePageSpace(14);

        let issuer = '';
        let name = '';
        let date = '';
        if (typeof cert === 'string') {
          name = sanitizeText(cert);
        } else {
          issuer = sanitizeText(cert.issuer);
          name = sanitizeText(cert.name);
          date = sanitizeText(cert.date);
        }
        if (!name) continue;

        const certY = doc.y;
        doc.font('HelveticaEmbed-Bold').fontSize(9.5).fillColor(NAVY);
        const certText = (issuer ? issuer + '  \u2014  ' : '') + name + (date ? ' (' + date + ')' : '');
        const certH = doc.heightOfString(certText, { width: contentWidth });
        doc.text(issuer, leftMargin, certY, { continued: true });
        doc.font('HelveticaEmbed').fillColor(BODY)
          .text((issuer ? '  \u2014  ' : '') + name + (date ? ' (' + date + ')' : ''), { width: contentWidth });
        doc.y = certY + Math.max(certH, 12);
        doc.x = leftMargin;
        doc.moveDown(0.25);
      }
    }

    doc.end();
  });
}

/**
 * Atanu Pro — premium navy/blue layout (mirrors buildAtanuProBlocks):
 * navy name + gray title + contact with a 2px accent rule under the header,
 * uppercase navy section headings with a 2px accent bottom border, bullets
 * with a 0.25in hanging indent, italic meta lines, 2-column skills grid,
 * project links only when a public URL exists. US Letter, 0.625in sides,
 * 0.5in top/bottom — all geometry from the shared cvTemplateConfig.
 */
function generateAtanuProPdf(cv: TailoredCv): Promise<Buffer> {
  const geo = CV_TEMPLATE_GEOMETRY['atanu-pro'];
  const NAVY = '#1F2937';
  const ACCENT = '#2563EB';
  const GRAY = '#4B5563';
  const FAINT = '#9CA3AF';
  const MARGIN_X = geo.marginLeft;  // 45 pt (0.625in, shared)
  const MARGIN_Y = geo.marginTop;   // 36 pt (0.5in, shared)
  const LINE_GAP = geo.pdfLineGap;  // 1.2 pt (shared)
  const RULE_H = geo.ruleWidth;     // 2 pt accent border
  const HANGING = 18;               // 0.25in hanging indent
  const PAGE_W = 612;
  const PAGE_H = 792;
  const leftMargin = MARGIN_X;
  const rightMargin = PAGE_W - MARGIN_X;
  const contentWidth = rightMargin - leftMargin;
  const pageBottom = PAGE_H - MARGIN_Y;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN_Y, bottom: MARGIN_Y, left: MARGIN_X, right: MARGIN_X } });
    registerEmbeddedFonts(doc);
    const buffers: Buffer[] = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', (err) => reject(err));

    const ensurePageSpace = (neededHeight: number) => {
      if (doc.y + neededHeight > pageBottom) {
        doc.addPage();
        doc.y = MARGIN_Y;
      }
    };

    // ── Section heading: uppercase navy + 2px accent bottom border ──
    const renderSectionHeading = (title: string) => {
      ensurePageSpace(30);
      const y0 = doc.y;
      doc.font('HelveticaEmbed-Bold').fontSize(geo.headingSize).fillColor(NAVY).text(title.toUpperCase(), leftMargin, y0, { width: contentWidth });
      const ruleY = doc.y + 2;
      doc.fillColor(ACCENT).rect(leftMargin, ruleY, contentWidth, RULE_H).fill();
      doc.y = ruleY + RULE_H + 4;
      doc.x = leftMargin;
    };

    // ── Bullet: accent • with 0.25in hanging indent, atomic ──
    const renderBullet = (text: string) => {
      const clean = sanitizeText(String(text || '').replace(/^[*•\-]\s*/, '').trim());
      if (!clean) return;
      const tWidth = contentWidth - HANGING;
      const bulletH = doc.heightOfString(clean, { width: tWidth, lineGap: LINE_GAP });
      ensurePageSpace((isFinite(bulletH) && bulletH > 0 ? bulletH : 12) + 2);
      const y0 = doc.y;
      doc.font('HelveticaEmbed').fontSize(geo.bulletSize).fillColor(ACCENT).text('\u2022', leftMargin, y0, { lineBreak: false });
      doc.fillColor(NAVY).text(clean, leftMargin + HANGING, y0, { width: tWidth, lineGap: LINE_GAP, align: 'justify' });
      doc.x = leftMargin;
      doc.moveDown(0.18);
    };

    // ── Header: name + title + contact + accent rule ──
    const name = sanitizeText(cv.candidateName).toUpperCase() || 'CANDIDATE NAME';
    ensurePageSpace(60);
    doc.font('HelveticaEmbed-Bold').fontSize(geo.nameSize).fillColor(NAVY).text(name, leftMargin, doc.y, { width: contentWidth });
    if (cv.targetRole) {
      doc.font('HelveticaEmbed-Bold').fontSize(geo.roleSize).fillColor(GRAY).text(sanitizeText(cv.targetRole), leftMargin, doc.y, { width: contentWidth });
    }
    const contacts = getContactLinks(cv);
    if (contacts.length > 0) {
      ensurePageSpace(14);
      doc.font('HelveticaEmbed').fontSize(9).fillColor(GRAY);
      contacts.forEach((c, i) => {
        if (i > 0) doc.fillColor(FAINT).text(' | ', leftMargin, doc.y, { continued: true, lineBreak: false });
        doc.fillColor(c.url ? ACCENT : GRAY);
        const tx = doc.x;
        const ty = doc.y;
        doc.text(c.label, tx, ty, { continued: true, lineBreak: false });
        if (c.url) {
          const lw = doc.widthOfString(c.label);
          const lh = doc.heightOfString(c.label, { width: lw });
          doc.link(tx, ty, lw, Math.max(lh, 10), normalizeUrl(c.url));
        }
      });
      doc.text('', { lineBreak: true });
      doc.x = leftMargin;
    }
    doc.fillColor(ACCENT).rect(leftMargin, doc.y + 6, contentWidth, RULE_H).fill();
    doc.y = doc.y + 6 + RULE_H + 8;
    doc.x = leftMargin;

    // ── Summary ──
    if (cv.professionalSummary) {
      const s = sanitizeText(cv.professionalSummary);
      if (s) {
        renderSectionHeading('Summary');
        ensurePageSpace(18);
        doc.font('HelveticaEmbed').fontSize(geo.bodySize).fillColor(NAVY).text(s, leftMargin, doc.y, { width: contentWidth, align: 'justify', lineGap: LINE_GAP });
        doc.x = leftMargin;
        doc.moveDown(0.2);
      }
    }

    // ── Skills — 2-column row-wise grid (shared column width) ──
    const skillCats = Array.isArray(cv.technicalSkills)
      ? cv.technicalSkills
          .map((cat) => ({ name: sanitizeText(cat.category), list: Array.isArray(cat.skills) ? cat.skills.map((s) => sanitizeText(s)).filter(Boolean).join(', ') : '' }))
          .filter((c) => c.name || c.list)
      : [];
    const useCompetencies = skillCats.length === 0 && Array.isArray(cv.coreCompetencies) && cv.coreCompetencies.length > 0;
    if (skillCats.length > 0 || useCompetencies) {
      renderSectionHeading('Skills');
      if (useCompetencies) {
        ensurePageSpace(15);
        doc.font('HelveticaEmbed').fontSize(geo.bodySize).fillColor(NAVY).text(
          cv.coreCompetencies.map((c) => sanitizeText(c)).filter(Boolean).join(', '),
          leftMargin, doc.y, { width: contentWidth, lineGap: LINE_GAP }
        );
        doc.x = leftMargin;
        doc.moveDown(0.2);
      } else {
        const colGap = geo.skillsColumnGap; // 18 pt (shared)
        const colW = cvSkillsColumnWidth('atanu-pro'); // (contentWidth - colGap) / 2
        const leftX = leftMargin;
        const rightX = leftMargin + colW + colGap;
        const cellText = (cat: { name: string; list: string }) => (cat.name ? `${cat.name}: ${cat.list}` : cat.list);
        const cellHeight = (cat: { name: string; list: string }) => Math.max(0, doc.heightOfString(cellText(cat), { width: colW, lineGap: LINE_GAP }));
        const rowGap = 2.5;

        for (let i = 0; i < skillCats.length; i += 2) {
          const left = skillCats[i];
          const right = skillCats[i + 1];
          const rowH = Math.max(left ? cellHeight(left) : 0, right ? cellHeight(right) : 0) + rowGap;
          ensurePageSpace(rowH + 4);
          const rowY = doc.y;
          if (left) {
            doc.font('HelveticaEmbed-Bold').fontSize(geo.skillCategorySize).fillColor(NAVY);
            doc.text(left.name ? left.name + ': ' : '', leftX, rowY, { continued: true, width: colW });
            doc.font('HelveticaEmbed').fillColor(GRAY).text(left.list, { width: colW, lineGap: LINE_GAP });
          }
          if (right) {
            doc.font('HelveticaEmbed-Bold').fontSize(geo.skillCategorySize).fillColor(NAVY);
            doc.text(right.name ? right.name + ': ' : '', rightX, rowY, { continued: true, width: colW });
            doc.font('HelveticaEmbed').fillColor(GRAY).text(right.list, { width: colW, lineGap: LINE_GAP });
          }
          doc.y = rowY + rowH;
          doc.x = leftMargin;
        }
        doc.moveDown(0.2);
      }
    }

    // ── Experience ──
    if (cv.workExperience && cv.workExperience.length > 0) {
      renderSectionHeading('Experience');
      for (const exp of cv.workExperience) {
        if (!exp) continue;
        ensurePageSpace(24);
        const title = sanitizeText(exp.title);
        const company = sanitizeText(exp.company);
        const period = sanitizeText(exp.dates);
        const loc = sanitizeText(exp.location);
        const y0 = doc.y;
        const leftText = title + (company ? '  \u2014  ' + company : '');
        const leftW = contentWidth - 140;
        doc.font('HelveticaEmbed-Bold').fontSize(geo.expTitleSize).fillColor(NAVY);
        const leftH = doc.heightOfString(leftText, { width: leftW });
        doc.text(title, leftMargin, y0, { continued: true });
        doc.font('HelveticaEmbed').fillColor(GRAY).text(company ? '  \u2014  ' + company : '', { width: leftW });
        doc.x = leftMargin;
        const meta = [period, loc].filter(Boolean).join('  |  ');
        if (meta) {
          doc.font('HelveticaEmbed-Oblique').fontSize(8.5).fillColor(GRAY).text(meta, leftMargin + leftW, y0 + Math.max(0, leftH - 12), { width: 140 - 6, align: 'right' });
          doc.x = leftMargin;
        }
        doc.y = y0 + Math.max(leftH, 12);
        for (const hl of exp.highlights || []) {
          renderBullet(hl);
        }
        doc.moveDown(0.1);
      }
    }

    // ── Projects — link only when a public URL exists ──
    if (cv.projects && cv.projects.length > 0) {
      renderSectionHeading('Projects');
      for (const p of cv.projects) {
        if (!p) continue;
        ensurePageSpace(20);
        const pName = sanitizeText(p.name);
        const pDates = sanitizeText(p.dates);
        const pDesc = sanitizeText(p.description);
        const y0 = doc.y;
        doc.font('HelveticaEmbed-Bold').fontSize(geo.expTitleSize).fillColor(NAVY).text(pName, leftMargin, y0, { continued: true });
        doc.x = leftMargin;
        if (pDates) {
          doc.font('HelveticaEmbed-Oblique').fontSize(8.5).fillColor(GRAY).text('  [' + pDates + ']', { continued: true });
          doc.x = leftMargin;
        }
        doc.text('', { lineBreak: true });
        if (pDesc) {
          ensurePageSpace(12);
          doc.font('HelveticaEmbed').fontSize(geo.bodySize).fillColor(NAVY).text(pDesc, leftMargin, doc.y, { width: contentWidth, lineGap: LINE_GAP, align: 'justify' });
          doc.x = leftMargin;
        }
        if (p.link) {
          const link = normalizeUrl(p.link);
          ensurePageSpace(12);
          const lx = leftMargin;
          const ly = doc.y;
          doc.font('HelveticaEmbed').fontSize(geo.bodySize).fillColor(ACCENT).text(sanitizeText(displayUrl(p.link)), lx, ly, { width: contentWidth });
          const disp = sanitizeText(displayUrl(p.link));
          const lw = doc.widthOfString(disp);
          const lh = doc.heightOfString(disp, { width: contentWidth });
          doc.link(lx, ly, Math.min(lw, contentWidth), Math.max(lh, 10), link);
          doc.x = leftMargin;
        }
        doc.moveDown(0.15);
      }
    }

    // ── Education ──
    if (cv.education && cv.education.length > 0) {
      renderSectionHeading('Education');
      for (const e of cv.education) {
        if (!e) continue;
        ensurePageSpace(14);
        const inst = sanitizeText(e.institution);
        const deg = sanitizeText(e.degree);
        const dates = sanitizeText(e.dates);
        doc.font('HelveticaEmbed-Bold').fontSize(geo.bodySize).fillColor(NAVY).text(inst, leftMargin, doc.y, { continued: true });
        doc.font('HelveticaEmbed').fillColor(NAVY).text(deg ? '  \u2014  ' + deg : '', { continued: true });
        doc.font('HelveticaEmbed-Oblique').fillColor(GRAY).text(dates ? '   ' + dates : '', { continued: true });
        doc.text('', { lineBreak: true });
        doc.x = leftMargin;
        doc.moveDown(0.05);
      }
    }

    // ── Certifications ──
    if (cv.certifications && cv.certifications.length > 0) {
      renderSectionHeading('Certifications');
      for (const cert of cv.certifications) {
        let nameT = '';
        let issuer = '';
        if (typeof cert === 'string') nameT = cert;
        else { nameT = cert.name || ''; issuer = cert.issuer || ''; }
        ensurePageSpace(12);
        doc.font('HelveticaEmbed-Bold').fontSize(geo.bodySize).fillColor(NAVY).text(issuer ? issuer + '  \u2014  ' : '', leftMargin, doc.y, { continued: true });
        doc.font('HelveticaEmbed').fillColor(NAVY).text(nameT, { width: contentWidth });
        doc.x = leftMargin;
        doc.moveDown(0.05);
      }
    }

    doc.end();
  });
}

/**
 * Harvard — official Harvard College bullet-point resume template:
 * Calibri-style sans, centered bold name + centered contact (• separators),
 * CENTERED bold uppercase section headings (no rules), entries with org
 * bold left / city right and title left / dates right, • bullets.
 * US Letter, margins 0.6in top/bottom, 0.7in sides.
 */
function generateHarvardPdf(cv: TailoredCv): Promise<Buffer> {
  const geo = CV_TEMPLATE_GEOMETRY.harvard;
  const INK = '#111111';
  const MARGIN_X = geo.marginLeft;  // 50.4 pt (shared)
  const MARGIN_Y = geo.marginTop;   // 43.2 pt (shared)
  const LINE_GAP = geo.pdfLineGap;  // 1 pt (shared)
  const PAGE_W = 612;
  const PAGE_H = 792;
  const leftMargin = MARGIN_X;
  const rightMargin = PAGE_W - MARGIN_X;
  const contentWidth = rightMargin - leftMargin;
  const pageBottom = PAGE_H - MARGIN_Y;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN_Y, bottom: MARGIN_Y, left: MARGIN_X, right: MARGIN_X } });
    registerEmbeddedFonts(doc);
    const buffers: Buffer[] = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', (err) => reject(err));

    const ensurePageSpace = (h: number) => {
      if (doc.y + h > pageBottom) { doc.addPage(); doc.y = MARGIN_Y; }
    };

    // Centered name (bold, 15pt, uppercase)
    const name = sanitizeText(cv.candidateName).toUpperCase() || 'CANDIDATE NAME';
    ensurePageSpace(40);
    doc.font('HelveticaEmbed-Bold').fontSize(15).fillColor(INK).text(name, leftMargin, doc.y, { align: 'center', width: contentWidth });
    doc.moveDown(0.2);

    // Centered contact line with bullet separators
    const contactLinks = getContactLinks(cv);
    if (contactLinks.length > 0) {
      ensurePageSpace(20);
      const sep = '  \u2022  ';
      const sepWidth = doc.widthOfString(sep);
      const itemsMeasured = contactLinks
        .map((item) => { const label = sanitizeText(item.label); if (!label) return null; return { item, label, w: doc.widthOfString(label) }; })
        .filter((x): x is { item: typeof contactLinks[0]; label: string; w: number } => x !== null);
      if (itemsMeasured.length > 0) {
        let totalWidth = itemsMeasured.reduce((sum, el) => sum + el.w, 0) + (itemsMeasured.length - 1) * sepWidth;
        const currentY = doc.y;
        let currentX = leftMargin + Math.max(0, (contentWidth - totalWidth) / 2);
        itemsMeasured.forEach(({ item, label, w }, idx) => {
          const normUrl = item.url ? normalizeUrl(item.url) : undefined;
          doc.font('HelveticaEmbed').fontSize(10).fillColor(INK);
          doc.text(label, currentX, currentY, { lineBreak: false });
          if (normUrl) doc.link(currentX, currentY, w, 10, normUrl);
          currentX += w;
          if (idx < itemsMeasured.length - 1) {
            doc.fillColor('#555555').text(sep, currentX, currentY, { lineBreak: false });
            currentX += sepWidth;
          }
        });
        doc.x = leftMargin;
        doc.y = currentY + 13;
      }
    }

    // Centered bold uppercase section heading (no rule)
    const section = (title: string) => {
      ensurePageSpace(30);
      doc.moveDown(0.35);
      const y0 = doc.y;
      doc.font('HelveticaEmbed-Bold').fontSize(11).fillColor(INK)
        .text(title.toUpperCase(), leftMargin, y0, { align: 'center', width: contentWidth });
      doc.moveDown(0.15);
      doc.x = leftMargin;
    };

    // Bullet: • at 0, text at 13px indent, justified
    const bullet = (text: string) => {
      if (!text) return;
      const clean = sanitizeText(String(text).replace(/^[*•\-]\s*/, '').trim());
      if (!clean) return;
      // Atomic bullets — a bullet that does not fit moves whole to the next
      // page (mirrors the preview's block pagination).
      const bulletH = doc.heightOfString(clean, { width: contentWidth - 13, lineGap: LINE_GAP });
      ensurePageSpace((isFinite(bulletH) && bulletH > 0 ? bulletH : 12) + 2);
      const y0 = doc.y;
      doc.font('HelveticaEmbed').fontSize(10.5).fillColor(INK).text('\u2022', leftMargin, y0, { lineBreak: false });
      doc.text(clean, leftMargin + 13, y0, { width: contentWidth - 13, align: 'justify', lineGap: LINE_GAP });
      doc.x = leftMargin;
      doc.moveDown(0.18);
    };

    // Summary
    if (cv.professionalSummary) {
      const s = sanitizeText(cv.professionalSummary);
      if (s) {
        section('Summary');
        ensurePageSpace(18);
        doc.font('HelveticaEmbed').fontSize(10.5).fillColor(INK).text(s, leftMargin, doc.y, { width: contentWidth, align: 'justify', lineGap: LINE_GAP });
        doc.x = leftMargin;
        doc.moveDown(0.2);
      }
    }

    // Education
    if (cv.education && cv.education.length > 0) {
      section('Education');
      for (const edu of cv.education) {
        if (!edu) continue;
        ensurePageSpace(30);
        const inst = sanitizeText(edu.institution);
        const city = '';
        const degree = sanitizeText(edu.degree);
        const dates = sanitizeText(edu.dates);
        const y0 = doc.y;
        const h0 = entryHeaderLine(doc, { left: inst, right: city, x: leftMargin, rightEdge: rightMargin });
        doc.y = y0 + h0 + 1;
        const y1 = doc.y;
        const h1 = entryHeaderLine(doc, { left: degree, right: dates, x: leftMargin, rightEdge: rightMargin });
        doc.y = y1 + h1;
        doc.x = leftMargin;
        doc.moveDown(0.2);
      }
    }

    // Experience
    if (cv.workExperience && cv.workExperience.length > 0) {
      section('Experience');
      for (const exp of cv.workExperience) {
        if (!exp) continue;
        ensurePageSpace(30);
        const org = sanitizeText(exp.company);
        const city = sanitizeText(exp.location);
        const title = sanitizeText(exp.title);
        const period = sanitizeText(exp.dates);
        const y0 = doc.y;
        const h0 = entryHeaderLine(doc, { left: org, right: city, x: leftMargin, rightEdge: rightMargin });
        doc.y = y0 + h0 + 1;
        const y1 = doc.y;
        const h1 = entryHeaderLine(doc, { left: title, right: period, x: leftMargin, rightEdge: rightMargin });
        doc.y = y1 + h1;
        doc.x = leftMargin;
        if (Array.isArray(exp.highlights)) for (const hl of exp.highlights) bullet(hl);
        doc.moveDown(0.2);
      }
    }

    // Projects
    if (cv.projects && cv.projects.length > 0) {
      section('Projects');
      for (const proj of cv.projects) {
        if (!proj) continue;
        ensurePageSpace(30);
        const pName = sanitizeText(proj.name);
        const pDates = sanitizeText(proj.dates);
        const y0 = doc.y;
        const h0 = entryHeaderLine(doc, { left: pName, right: pDates ? '[' + pDates + ']' : '', x: leftMargin, rightEdge: rightMargin });
        doc.y = y0 + h0;
        doc.x = leftMargin;
        if (proj.description) bullet(sanitizeText(proj.description));
        if (proj.link) {
          ensurePageSpace(12);
          const link = normalizeUrl(proj.link);
          if (link) {
            const ly = doc.y;
            const disp = displayUrl(proj.link);
            doc.font('HelveticaEmbed').fontSize(10.5).fillColor(INK).text(disp, leftMargin, ly, { width: contentWidth });
            doc.link(leftMargin, ly, Math.min(doc.widthOfString(disp), contentWidth), Math.max(doc.heightOfString(disp, { width: contentWidth }), 10), link);
            doc.x = leftMargin;
            doc.moveDown(0.1);
          }
        }
        doc.moveDown(0.15);
      }
    }

    // Skills & Interests
    const skillCats = Array.isArray(cv.technicalSkills)
      ? cv.technicalSkills
          .map((cat) => ({ name: sanitizeText(cat.category), list: Array.isArray(cat.skills) ? cat.skills.map((s) => sanitizeText(s)).filter(Boolean).join(', ') : '' }))
          .filter((c) => c.name || c.list)
      : [];
    if (skillCats.length > 0) {
      section('Skills & Interests');
      for (const cat of skillCats) {
        ensurePageSpace(14);
        const y0 = doc.y;
        doc.font('HelveticaEmbed-Bold').fontSize(10.5).fillColor(INK).text(cat.name + ': ', leftMargin, y0, { continued: true });
        doc.font('HelveticaEmbed').fillColor(INK).text(cat.list, { width: contentWidth - 1, lineGap: LINE_GAP });
        doc.x = leftMargin;
        doc.moveDown(0.15);
      }
    }

    // Certifications
    if (cv.certifications && cv.certifications.length > 0) {
      section('Certifications');
      for (const cert of cv.certifications) {
        if (!cert) continue;
        let nameT = ''; let issuer = '';
        if (typeof cert === 'string') nameT = sanitizeText(cert);
        else { nameT = sanitizeText(cert.name); issuer = sanitizeText(cert.issuer); }
        if (!nameT) continue;
        ensurePageSpace(14);
        const y0 = doc.y;
        if (issuer) doc.font('HelveticaEmbed-Bold').fontSize(10.5).fillColor(INK).text(issuer, leftMargin, y0, { continued: true });
        doc.font('HelveticaEmbed').fillColor(INK).text((issuer ? '  \u2014  ' : '') + nameT, { width: contentWidth });
        doc.x = leftMargin;
        doc.moveDown(0.15);
      }
    }

    doc.end();
  });
}

/**
 * Jake — Jake Ryan one-page developer resume: black ink, uppercase name,
 * '—' bullets, black rules under headings, left-aligned, tight 9px type.
 * US Letter, margins 0.45in top/bottom, 0.5in sides.
 */
function generateJakePdf(cv: TailoredCv): Promise<Buffer> {
  const geo = CV_TEMPLATE_GEOMETRY.jake;
  const INK = '#1a1a1a';
  const MUTED = '#555555';
  const FAINT = '#777777';
  const MARGIN_X = geo.marginLeft;  // 36 pt (shared)
  const MARGIN_Y = geo.marginTop;   // 32.4 pt (shared)
  const LINE_GAP = geo.pdfLineGap;  // 1 pt (shared)
  const PAGE_W = 612;
  const PAGE_H = 792;
  const leftMargin = MARGIN_X;
  const rightMargin = PAGE_W - MARGIN_X;
  const contentWidth = rightMargin - leftMargin;
  const pageBottom = PAGE_H - MARGIN_Y;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN_Y, bottom: MARGIN_Y, left: MARGIN_X, right: MARGIN_X } });
    registerEmbeddedFonts(doc);
    const buffers: Buffer[] = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', (err) => reject(err));

    const ensurePageSpace = (h: number) => {
      if (doc.y + h > pageBottom) { doc.addPage(); doc.y = MARGIN_Y; }
    };

    // Header: uppercase name left, role, contact
    const name = sanitizeText(cv.candidateName).toUpperCase() || 'CANDIDATE NAME';
    ensurePageSpace(60);
    doc.font('HelveticaEmbed-Bold').fontSize(24).fillColor('#111111').text(name, leftMargin, doc.y, { width: contentWidth });
    doc.moveDown(0.15);
    if (cv.targetRole) {
      const role = sanitizeText(cv.targetRole);
      if (role) {
        ensurePageSpace(14);
        doc.font('HelveticaEmbed-Bold').fontSize(11.5).fillColor(MUTED).text(role, leftMargin, doc.y, { width: contentWidth });
        doc.moveDown(0.15);
      }
    }
    const contactLinks = getContactLinks(cv);
    if (contactLinks.length > 0) {
      ensurePageSpace(14);
      const sep = '   |   ';
      const y0 = doc.y;
      let cx = leftMargin;
      contactLinks.forEach((item, idx) => {
        const label = sanitizeText(item.label);
        if (!label) return;
        const w = doc.widthOfString(label);
        const normUrl = item.url ? normalizeUrl(item.url) : undefined;
        doc.font('HelveticaEmbed').fontSize(9.5).fillColor('#444444');
        doc.text(label, cx, y0, { lineBreak: false });
        if (normUrl) doc.link(cx, y0, w, 10, normUrl);
        cx += w;
        if (idx < contactLinks.length - 1) {
          doc.fillColor('#AAAAAA').text(sep, cx, y0, { lineBreak: false });
          cx += doc.widthOfString(sep);
        }
      });
      doc.y = y0 + 12;
      doc.x = leftMargin;
    }
    doc.moveDown(0.25);

    // Section heading: black bold uppercase + 1px black rule
    const section = (title: string) => {
      ensurePageSpace(30);
      doc.moveDown(0.3);
      const y0 = doc.y;
      doc.font('HelveticaEmbed-Bold').fontSize(11).fillColor('#111111').text(title.toUpperCase(), leftMargin, y0, { width: contentWidth });
      const ruleY = doc.y + 2;
      doc.moveTo(leftMargin, ruleY).lineTo(rightMargin, ruleY).lineWidth(1).strokeColor('#111111').stroke();
      doc.y = ruleY + 5;
      doc.x = leftMargin;
    };

    const bullet = (text: string) => {
      if (!text) return;
      const clean = sanitizeText(String(text).replace(/^[*•\-]\s*/, '').trim());
      if (!clean) return;
      // Atomic bullets — mirror the preview's block pagination.
      const bulletH = doc.heightOfString(clean, { width: contentWidth - 12, lineGap: LINE_GAP });
      ensurePageSpace((isFinite(bulletH) && bulletH > 0 ? bulletH : 12) + 2);
      const y0 = doc.y;
      doc.font('HelveticaEmbed').fontSize(9).fillColor(INK).text('\u2014', leftMargin, y0, { lineBreak: false });
      doc.text(clean, leftMargin + 12, y0, { width: contentWidth - 12, align: 'justify', lineGap: LINE_GAP });
      doc.x = leftMargin;
      doc.moveDown(0.12);
    };

    if (cv.professionalSummary) {
      const s = sanitizeText(cv.professionalSummary);
      if (s) {
        section('Summary');
        ensurePageSpace(16);
        doc.font('HelveticaEmbed').fontSize(9).fillColor(INK).text(s, leftMargin, doc.y, { width: contentWidth, align: 'justify', lineGap: 1 });
        doc.x = leftMargin;
        doc.moveDown(0.15);
      }
    }

    const skillCats = Array.isArray(cv.technicalSkills)
      ? cv.technicalSkills
          .map((cat) => ({ name: sanitizeText(cat.category), list: Array.isArray(cat.skills) ? cat.skills.map((s) => sanitizeText(s)).filter(Boolean).join(', ') : '' }))
          .filter((c) => c.name || c.list)
      : [];
    if (skillCats.length > 0) {
      section('Skills');
      // Row-wise pairing — identical to the browser preview's CSS grid
      // (categories flow left→right, row by row; a row never splits).
      const colGap = geo.skillsColumnGap; // 20 pt (shared)
      const colW = cvSkillsColumnWidth('jake'); // (contentWidth - colGap) / 2
      const leftX = leftMargin;
      const rightX = leftMargin + colW + colGap;
      const cellText = (cat: { name: string; list: string }) => `${cat.name}: ${cat.list}`;
      const cellHeight = (cat: { name: string; list: string }) => Math.max(0, doc.heightOfString(cellText(cat), { width: colW, lineGap: LINE_GAP }));
      const rowGap = 2.5; // mirrors the preview's per-cell marginBottom (pt(2.5))

      for (let i = 0; i < skillCats.length; i += 2) {
        const left = skillCats[i];
        const right = skillCats[i + 1];
        const rowH = Math.max(left ? cellHeight(left) : 0, right ? cellHeight(right) : 0) + rowGap;
        ensurePageSpace(rowH + 3);
        const rowY = doc.y;
        if (left) {
          doc.font('HelveticaEmbed-Bold').fontSize(9).fillColor('#111111');
          doc.text(left.name + ': ', leftX, rowY, { continued: true, width: colW });
          doc.font('HelveticaEmbed').fillColor(INK).text(left.list, { width: colW, lineGap: LINE_GAP });
        }
        if (right) {
          doc.font('HelveticaEmbed-Bold').fontSize(9).fillColor('#111111');
          doc.text(right.name + ': ', rightX, rowY, { continued: true, width: colW });
          doc.font('HelveticaEmbed').fillColor(INK).text(right.list, { width: colW, lineGap: LINE_GAP });
        }
        doc.y = rowY + rowH;
        doc.x = leftMargin;
      }
      doc.moveDown(0.15);
    }

    if (cv.workExperience && cv.workExperience.length > 0) {
      section('Experience');
      for (const exp of cv.workExperience) {
        if (!exp) continue;
        ensurePageSpace(24);
        const title = sanitizeText(exp.title);
        const company = sanitizeText(exp.company);
        const period = sanitizeText(exp.dates);
        const loc = sanitizeText(exp.location);
        const y0 = doc.y;
        const leftText = title + (company ? '  \u2014  ' + company : '');
        const leftW = contentWidth - 140;
        doc.font('HelveticaEmbed-Bold').fontSize(9.5).fillColor('#111111');
        const leftH = doc.heightOfString(leftText, { width: leftW });
        doc.text(title, leftMargin, y0, { continued: true });
        doc.font('HelveticaEmbed').fillColor(MUTED).text(company ? '  \u2014  ' + company : '', { width: leftW });
        doc.x = leftMargin;
        if (period) {
          doc.font('HelveticaEmbed').fontSize(8.5).fillColor(FAINT);
          doc.text(period, leftMargin + contentWidth - doc.widthOfString(period), y0 + Math.max(0, leftH - 12), { width: doc.widthOfString(period) });
        }
        doc.y = y0 + Math.max(leftH, 12);
        if (loc) {
          ensurePageSpace(11);
          doc.font('HelveticaEmbed').fontSize(9).fillColor(FAINT).text(loc, leftMargin, doc.y, { width: contentWidth });
          doc.moveDown(0.1);
        }
        doc.x = leftMargin;
        if (Array.isArray(exp.highlights)) for (const hl of exp.highlights) bullet(hl);
        doc.moveDown(0.25);
      }
    }

    if (cv.projects && cv.projects.length > 0) {
      section('Projects');
      for (const proj of cv.projects) {
        if (!proj) continue;
        ensurePageSpace(18);
        const pName = sanitizeText(proj.name);
        const pDates = sanitizeText(proj.dates);
        const y0 = doc.y;
        const pLeftW = contentWidth - 130;
        doc.font('HelveticaEmbed-Bold').fontSize(9.5).fillColor('#111111');
        const pH = doc.heightOfString(pName, { width: pLeftW });
        doc.text(pName, leftMargin, y0, { width: pLeftW });
        if (pDates) {
          const tag = '  [' + pDates + ']';
          doc.font('HelveticaEmbed').fontSize(8.5).fillColor(FAINT);
          doc.text(tag, leftMargin + contentWidth - doc.widthOfString(tag), y0 + Math.max(0, pH - 12), { width: doc.widthOfString(tag) });
        }
        doc.y = y0 + Math.max(pH, 12);
        doc.x = leftMargin;
        doc.moveDown(0.05);
        if (proj.description) {
          const d = sanitizeText(proj.description);
          if (d) {
            ensurePageSpace(13);
            doc.font('HelveticaEmbed').fontSize(9).fillColor(INK).text(d, leftMargin, doc.y, { width: contentWidth, lineGap: 1 });
            doc.x = leftMargin;
            doc.moveDown(0.05);
          }
        }
        if (proj.link) {
          const link = normalizeUrl(proj.link);
          if (link) {
            ensurePageSpace(11);
            const ly = doc.y;
            const disp = displayUrl(proj.link);
            doc.font('HelveticaEmbed').fontSize(9).fillColor('#111111').text(disp, leftMargin, ly, { width: contentWidth });
            doc.link(leftMargin, ly, Math.min(doc.widthOfString(disp), contentWidth), Math.max(doc.heightOfString(disp, { width: contentWidth }), 10), link);
            doc.x = leftMargin;
          }
        }
        doc.moveDown(0.15);
      }
    }

    if (cv.education && cv.education.length > 0) {
      section('Education');
      for (const edu of cv.education) {
        if (!edu) continue;
        ensurePageSpace(14);
        const inst = sanitizeText(edu.institution);
        const degree = sanitizeText(edu.degree);
        const dates = sanitizeText(edu.dates);
        const y0 = doc.y;
        doc.font('HelveticaEmbed-Bold').fontSize(9.5).fillColor('#111111').text(inst, leftMargin, y0, { continued: true });
        doc.font('HelveticaEmbed').fillColor(INK)
          .text((degree ? '  \u2014  ' + degree : '') + (dates ? '  \u00A0\u00A0' + dates : ''));
        doc.x = leftMargin;
        doc.moveDown(0.2);
      }
    }

    if (cv.certifications && cv.certifications.length > 0) {
      section('Certifications');
      for (const cert of cv.certifications) {
        if (!cert) continue;
        let nameT = ''; let issuer = '';
        if (typeof cert === 'string') nameT = sanitizeText(cert);
        else { nameT = sanitizeText(cert.name); issuer = sanitizeText(cert.issuer); }
        if (!nameT) continue;
        ensurePageSpace(13);
        const y0 = doc.y;
        if (issuer) doc.font('HelveticaEmbed-Bold').fontSize(9.5).fillColor('#111111').text(issuer, leftMargin, y0, { continued: true });
        doc.font('HelveticaEmbed').fillColor(INK).text((issuer ? '  \u2014  ' : '') + nameT, { width: contentWidth });
        doc.x = leftMargin;
        doc.moveDown(0.15);
      }
    }

    doc.end();
  });
}


export function generatePlainTextCv(cv: TailoredCv): string {
  const lines: string[] = [];

  lines.push(`${cv.candidateName.toUpperCase()}`);
  if (cv.targetRole) lines.push(`Target Role: ${cv.targetRole}`);

  const contactLinks = getContactLinks(cv);
  if (contactLinks.length > 0) {
    lines.push(contactLinks.map((c) => (c.url ? `${c.label} (${c.url})` : c.label)).join('   |   '));
  }
  lines.push('='.repeat(60));
  lines.push('');

  if (cv.professionalSummary) {
    lines.push('PROFESSIONAL SUMMARY');
    lines.push('-'.repeat(30));
    lines.push(cv.professionalSummary);
    lines.push('');
  }

  const hasTechnicalSkills = cv.technicalSkills && cv.technicalSkills.length > 0;
  const hasCoreCompetencies = cv.coreCompetencies && cv.coreCompetencies.length > 0;

  if (hasTechnicalSkills || hasCoreCompetencies) {
    lines.push('TECHNICAL SKILLS & COMPETENCIES');
    lines.push('-'.repeat(30));
    if (hasTechnicalSkills) {
      for (const cat of cv.technicalSkills) {
        lines.push(`${cat.category}: ${cat.skills.join(', ')}`);
      }
    } else if (hasCoreCompetencies) {
      lines.push(cv.coreCompetencies.join(', '));
    }
    lines.push('');
  }

  if (cv.workExperience && cv.workExperience.length > 0) {
    lines.push('PROFESSIONAL EXPERIENCE');
    lines.push('-'.repeat(30));
    for (const exp of cv.workExperience) {
      lines.push(`${exp.title}   |   ${exp.company}`);
      if (exp.dates || exp.location) {
        lines.push([exp.dates, exp.location].filter(Boolean).join('   |   '));
      }
      for (const hl of exp.highlights) {
        lines.push(`  • ${hl.replace(/^[*•\-]\s*/, '')}`);
      }
      lines.push('');
    }
  }

  if (cv.projects && cv.projects.length > 0) {
    lines.push('FEATURED PROJECTS');
    lines.push('-'.repeat(30));
    for (const proj of cv.projects) {
      const projMeta = [proj.dates, (proj.technologies || []).join(', '), proj.link].filter(Boolean).join('   |   ');
      lines.push(`${proj.name}${projMeta ? '   |   ' + projMeta : ''}`);
      if (proj.description) {
        lines.push(`  • ${proj.description.replace(/^[*•\-]\s*/, '')}`);
      }
      lines.push('');
    }
  }

  if (cv.education && cv.education.length > 0) {
    lines.push('EDUCATION');
    lines.push('-'.repeat(30));
    for (const edu of cv.education) {
      lines.push(`${edu.degree}   |   ${edu.institution}`);
      if (edu.dates) lines.push(edu.dates);
      lines.push('');
    }
  }

  if (cv.certifications && cv.certifications.length > 0) {
    lines.push('CERTIFICATIONS & CREDENTIALS');
    lines.push('-'.repeat(30));
    for (const cert of cv.certifications) {
      if (typeof cert === 'string') {
        lines.push(`  • ${cert}`);
      } else if (cert && typeof cert === 'object') {
        const parts = [cert.name, cert.issuer, cert.date, cert.link].filter(Boolean);
        lines.push(`  • ${parts.join('   |   ')}`);
      }
    }
  }

  return lines.join('\n');
}

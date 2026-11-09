// Vendored from the begifted-design skill 4.0.0 (emails/company-render.ts). Two differences: the import path, and the eyebrow
// is sentence case without tracking (the skill taste lint fails the uppercase micro-label). Sync both copies.
import { escapeEmailHtml } from "@/lib/teacher-emails/render";

export interface CompanyEmailContent { subject: string; html: string; text: string }
export interface EmailAction { label: string; url: string }
export interface EmailDetail { label: string; value: string }
export interface CompanySection { heading: string; paragraphs?: string[]; bullets?: string[]; action?: EmailAction }
export interface EmailPhoto {
  url: string; alt: string; title: string; creator: string; sourceUrl: string;
  license: string; licenseUrl: string; modification: string;
}
export interface EmailResource { title: string; description: string; url: string }
export interface CompanyFooter { note: string; address?: string; unsubscribe?: EmailAction; preferences?: EmailAction }
export type CompanyBlock =
  | { kind: 'copy'; heading?: string; paragraphs: string[]; bullets?: string[] }
  | { kind: 'details'; heading?: string; entries: EmailDetail[] }
  | { kind: 'steps'; entries: CompanySection[] }
  | { kind: 'resources'; entries: EmailResource[] }
  | { kind: 'receipt'; entries: EmailDetail[]; total: EmailDetail }
  | { kind: 'action'; action: EmailAction }
  | { kind: 'photo'; photo: EmailPhoto };
export interface CompanyDocument {
  subject: string; preheader: string; title: string; subtitle?: string;
  category: string; edition?: string; tone: 'white' | 'navy' | 'orange';
  logoUrl: string; blocks: CompanyBlock[]; footer: CompanyFooter;
}
const e = escapeEmailHtml;
const FONT = 'Arial,Helvetica,sans-serif';
const NAVY = '#141414', BLUE = '#141414', ORANGE = '#FF7518', MUTED = '#6B6B6B'; // 4.0.0 website palette: ink, paper, one orange
const PAD = 'padding:24px 32px;overflow-wrap:anywhere;word-break:break-word;';

export function companyEmailUrl(value: string, asset = false): string {
  const url = new URL(value);
  if (asset ? url.protocol !== 'https:' : !['https:', 'http:'].includes(url.protocol)) {
    throw new Error(asset ? 'Email image assets must use HTTPS' : 'Email links must use HTTP or HTTPS');
  }
  if (url.username || url.password) throw new Error('Email URLs must not include credentials');
  return url.toString();
}
function link(action: EmailAction): string {
  return `<a href="${e(companyEmailUrl(action.url))}" style="color:${BLUE};text-decoration:underline;overflow-wrap:anywhere;">${e(action.label)}</a>`;
}
function actionHtml(action: EmailAction): string {
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="max-width:100%;"><tr><td bgcolor="${BLUE}" style="background:${BLUE};border-radius:999px;text-align:center;"><a href="${e(companyEmailUrl(action.url))}" style="display:inline-block;padding:14px 22px;font-family:${FONT};font-size:16px;font-weight:700;line-height:1.4;color:#FFFFFF;text-decoration:none;overflow-wrap:anywhere;">${e(action.label)}</a></td></tr></table>`;
}
function heading(value?: string): string { return value ? `<h2 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:${NAVY};">${e(value)}</h2>` : ''; }
function copy(paragraphs: string[]): string { return paragraphs.map(p=>`<p style="margin:0 0 12px;">${e(p)}</p>`).join(''); }
function details(entries: EmailDetail[]): string {
  return `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="table-layout:fixed;">${entries.map(d=>`<tr><td valign="top" width="36%" style="padding:10px 16px 10px 0;border-bottom:1px solid #E8E3DA;color:${MUTED};font-size:14px;overflow-wrap:anywhere;word-break:break-word;">${e(d.label)}</td><td valign="top" style="padding:10px 0;border-bottom:1px solid #E8E3DA;font-weight:700;overflow-wrap:anywhere;word-break:break-word;">${e(d.value)}</td></tr>`).join('')}</table>`;
}
function photoCredit(photo: EmailPhoto): string {
  return `${photo.title} · ${photo.creator} · ${photo.license} · ${photo.modification}`;
}
function blockHtml(block: CompanyBlock): string {
  let content: string;
  switch(block.kind) {
    case 'copy': content = heading(block.heading) + copy(block.paragraphs) + (block.bullets?.length ? `<ul style="margin:0;padding-left:22px;">${block.bullets.map(b=>`<li style="margin-bottom:8px;">${e(b)}</li>`).join('')}</ul>` : ''); break;
    case 'details': content = heading(block.heading) + details(block.entries); break;
    case 'action': content = actionHtml(block.action); break;
    case 'steps': content = `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="table-layout:fixed;">${block.entries.map((s,i)=>`<tr><td width="42" valign="top" style="padding:16px 12px 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:24px;color:#B84A00;">${i+1}</td><td valign="top" style="padding:16px 0;border-top:1px solid #E8E3DA;overflow-wrap:anywhere;word-break:break-word;">${heading(s.heading)}${copy(s.paragraphs||[])}${s.bullets?.length ? `<ul style="padding-left:22px;">${s.bullets.map(b=>`<li>${e(b)}</li>`).join('')}</ul>` : ''}${s.action ? link(s.action) : ''}</td></tr>`).join('')}</table>`; break;
    case 'resources': content = `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="table-layout:fixed;">${block.entries.map((r,i)=>`<tr><td valign="top" style="padding:18px 0;border-top:1px solid #E8E3DA;overflow-wrap:anywhere;word-break:break-word;">${heading(r.title)}${copy([r.description])}${link({label:'Open resource',url:r.url})}</td></tr>`).join('')}</table>`; break;
    case 'receipt': content = heading('Confirmation details') + details(block.entries) + `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="margin-top:20px;table-layout:fixed;"><tr><td style="padding:16px;background:#FAF8F4;font-weight:700;overflow-wrap:anywhere;">${e(block.total.label)}</td><td style="padding:16px;background:#FAF8F4;font-weight:700;overflow-wrap:anywhere;">${e(block.total.value)}</td></tr></table>`; break;
    case 'photo': { const p=block.photo; content=`<img src="${e(companyEmailUrl(p.url,true))}" alt="${e(p.alt)}" width="576" style="display:block;width:100%;max-width:576px;height:auto;border:0;"/><p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:${MUTED};">${e(p.title)} · ${e(p.creator)} · ${link({label:p.license,url:p.licenseUrl})}<br/>${link({label:'Photo source',url:p.sourceUrl})} · ${e(p.modification)}</p>`; break; }
  }
  return `<tr><td class="email-pad" style="${PAD}border-top:1px solid #E8E3DA;">${content}</td></tr>`;
}
function blockText(block: CompanyBlock): string {
  switch(block.kind) {
    case 'copy': return [block.heading,...block.paragraphs,...(block.bullets||[]).map(b=>`• ${b}`)].filter(Boolean).join('\n\n');
    case 'details': return [block.heading,...block.entries.map(d=>`${d.label}: ${d.value}`)].filter(Boolean).join('\n');
    case 'action': return `${block.action.label}: ${companyEmailUrl(block.action.url)}`;
    case 'steps': return block.entries.map((s,i)=>[`${i+1}. ${s.heading}`,...(s.paragraphs||[]),...(s.bullets||[]).map(b=>`• ${b}`),s.action ? `${s.action.label}: ${companyEmailUrl(s.action.url)}` : ''].filter(Boolean).join('\n')).join('\n\n');
    case 'resources': return block.entries.map((r,i)=>`${r.title}\n${r.description}\nOpen resource: ${companyEmailUrl(r.url)}`).join('\n\n');
    case 'receipt': return ['Confirmation details',...block.entries.map(d=>`${d.label}: ${d.value}`),`${block.total.label}: ${block.total.value}`].join('\n');
    case 'photo': return `${photoCredit(block.photo)}\nPhoto source: ${companyEmailUrl(block.photo.sourceUrl)}\nLicence: ${companyEmailUrl(block.photo.licenseUrl)}`;
  }
}
export function renderCompanyEmail(doc: CompanyDocument): CompanyEmailContent {
  const background = doc.tone === 'navy' ? NAVY : doc.tone === 'orange' ? ORANGE : '#FFFFFF';
  const ink = doc.tone === 'navy' ? '#FFFFFF' : NAVY;
  const muted = doc.tone === 'navy' ? '#E8E3DA' : doc.tone === 'orange' ? NAVY : MUTED;
  const footerActions = [doc.footer.preferences,doc.footer.unsubscribe].filter((a): a is EmailAction=>!!a);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="light"/><meta name="supported-color-schemes" content="light"/><title>${e(doc.subject)}</title><style>@media(max-width:480px){.email-pad{padding:20px 18px!important}.email-title{font-size:28px!important}}</style></head><body style="margin:0;padding:0;background:#FAF8F4;color:${NAVY};font-family:${FONT};font-size:16px;line-height:1.6;"><div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${e(doc.preheader)}</div><table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#FAF8F4"><tr><td align="center" style="padding:24px 0;"><!--[if mso]><table role="presentation" width="640" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF" style="width:100%;max-width:640px;background:#FFFFFF;table-layout:fixed;"><tr><td class="email-pad" style="${PAD}"><img src="${e(companyEmailUrl(doc.logoUrl,true))}" alt="BeGifted" width="164" style="display:block;width:164px;max-width:100%;height:auto;border:0;"/></td></tr><tr><td class="email-pad" bgcolor="${background}" style="${PAD}background:${background};color:${ink};"><p style="margin:0 0 12px;font-size:13px;font-weight:500;color:${muted};">${e(doc.category)}${doc.edition ? ` · ${e(doc.edition)}` : ''}</p><h1 class="email-title" style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:38px;line-height:1.1;font-weight:400;color:${ink};">${e(doc.title)}</h1>${doc.subtitle ? `<p style="margin:0;color:${muted};">${e(doc.subtitle)}</p>` : ''}</td></tr>${doc.blocks.map(blockHtml).join('')}<tr><td class="email-pad" style="${PAD}border-top:1px solid #E8E3DA;font-size:13px;color:${MUTED};"><p style="margin:0 0 8px;font-weight:700;color:${NAVY};">BeGifted Education</p>${copy([doc.footer.note,...(doc.footer.address ? [doc.footer.address] : [])])}${footerActions.map(link).join(' · ')}</td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
  const text = [doc.subject,doc.preheader,[doc.category,doc.edition].filter(Boolean).join(' · '),doc.title,doc.subtitle,...doc.blocks.map(blockText),'BeGifted Education',doc.footer.note,doc.footer.address,...footerActions.map(a=>`${a.label}: ${companyEmailUrl(a.url)}`)].filter(Boolean).join('\n\n');
  return { subject: doc.subject, html, text };
}

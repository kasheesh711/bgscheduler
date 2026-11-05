// Generated from emails/company-render.ts. Run npm run emails:build after editing the typed source.
import { escapeEmailHtml } from "./render.mjs";
const e = escapeEmailHtml;
const FONT = 'Arial,Helvetica,sans-serif';
const NAVY = '#16203A', BLUE = '#126DCE', ORANGE = '#FF7518', MUTED = '#5A6678';
const PAD = 'padding:24px 32px;overflow-wrap:anywhere;word-break:break-word;';
export function companyEmailUrl(value, asset = false) {
    const url = new URL(value);
    if (asset ? url.protocol !== 'https:' : !['https:', 'http:'].includes(url.protocol)) {
        throw new Error(asset ? 'Email image assets must use HTTPS' : 'Email links must use HTTP or HTTPS');
    }
    if (url.username || url.password)
        throw new Error('Email URLs must not include credentials');
    return url.toString();
}
function link(action) {
    return `<a href="${e(companyEmailUrl(action.url))}" style="color:${BLUE};text-decoration:underline;overflow-wrap:anywhere;">${e(action.label)}</a>`;
}
function actionHtml(action) {
    return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="max-width:100%;"><tr><td bgcolor="${BLUE}" style="background:${BLUE};border-radius:4px;text-align:center;"><a href="${e(companyEmailUrl(action.url))}" style="display:inline-block;padding:14px 22px;font-family:${FONT};font-size:16px;font-weight:700;line-height:1.4;color:#FFFFFF;text-decoration:none;overflow-wrap:anywhere;">${e(action.label)}</a></td></tr></table>`;
}
function heading(value) { return value ? `<h2 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:${NAVY};">${e(value)}</h2>` : ''; }
function copy(paragraphs) { return paragraphs.map(p => `<p style="margin:0 0 12px;">${e(p)}</p>`).join(''); }
function details(entries) {
    return `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="table-layout:fixed;">${entries.map(d => `<tr><td valign="top" width="36%" style="padding:10px 16px 10px 0;border-bottom:1px solid #DFE5EC;color:${MUTED};font-size:14px;overflow-wrap:anywhere;word-break:break-word;">${e(d.label)}</td><td valign="top" style="padding:10px 0;border-bottom:1px solid #DFE5EC;font-weight:700;overflow-wrap:anywhere;word-break:break-word;">${e(d.value)}</td></tr>`).join('')}</table>`;
}
function photoCredit(photo) {
    return `${photo.title} · ${photo.creator} · ${photo.license} · ${photo.modification}`;
}
function blockHtml(block) {
    let content;
    switch (block.kind) {
        case 'copy':
            content = heading(block.heading) + copy(block.paragraphs) + (block.bullets?.length ? `<ul style="margin:0;padding-left:22px;">${block.bullets.map(b => `<li style="margin-bottom:8px;">${e(b)}</li>`).join('')}</ul>` : '');
            break;
        case 'details':
            content = heading(block.heading) + details(block.entries);
            break;
        case 'action':
            content = actionHtml(block.action);
            break;
        case 'steps':
            content = `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="table-layout:fixed;">${block.entries.map((s, i) => `<tr><td width="42" valign="top" style="padding:16px 12px 16px 0;font-size:22px;font-weight:700;color:${BLUE};">${String(i + 1).padStart(2, '0')}</td><td valign="top" style="padding:16px 0;border-top:1px solid #DFE5EC;overflow-wrap:anywhere;word-break:break-word;">${heading(s.heading)}${copy(s.paragraphs || [])}${s.bullets?.length ? `<ul style="padding-left:22px;">${s.bullets.map(b => `<li>${e(b)}</li>`).join('')}</ul>` : ''}${s.action ? link(s.action) : ''}</td></tr>`).join('')}</table>`;
            break;
        case 'resources':
            content = `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="table-layout:fixed;">${block.entries.map((r, i) => `<tr><td valign="top" width="42" style="padding:18px 12px 18px 0;font-weight:700;color:${BLUE};">${String(i + 1).padStart(2, '0')}</td><td valign="top" style="padding:18px 0;border-top:1px solid #DFE5EC;overflow-wrap:anywhere;word-break:break-word;">${heading(r.title)}${copy([r.description])}${link({ label: 'Open resource', url: r.url })}</td></tr>`).join('')}</table>`;
            break;
        case 'receipt':
            content = heading('Confirmation details') + details(block.entries) + `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="margin-top:20px;table-layout:fixed;"><tr><td style="padding:16px;background:#EDF1F6;font-weight:700;overflow-wrap:anywhere;">${e(block.total.label)}</td><td style="padding:16px;background:#EDF1F6;font-weight:700;overflow-wrap:anywhere;">${e(block.total.value)}</td></tr></table>`;
            break;
        case 'photo': {
            const p = block.photo;
            content = `<img src="${e(companyEmailUrl(p.url, true))}" alt="${e(p.alt)}" width="576" style="display:block;width:100%;max-width:576px;height:auto;border:0;"/><p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:${MUTED};">${e(p.title)} · ${e(p.creator)} · ${link({ label: p.license, url: p.licenseUrl })}<br/>${link({ label: 'Photo source', url: p.sourceUrl })} · ${e(p.modification)}</p>`;
            break;
        }
    }
    return `<tr><td class="email-pad" style="${PAD}border-top:1px solid #DFE5EC;">${content}</td></tr>`;
}
function blockText(block) {
    switch (block.kind) {
        case 'copy': return [block.heading, ...block.paragraphs, ...(block.bullets || []).map(b => `• ${b}`)].filter(Boolean).join('\n\n');
        case 'details': return [block.heading, ...block.entries.map(d => `${d.label}: ${d.value}`)].filter(Boolean).join('\n');
        case 'action': return `${block.action.label}: ${companyEmailUrl(block.action.url)}`;
        case 'steps': return block.entries.map((s, i) => [`${String(i + 1).padStart(2, '0')} · ${s.heading}`, ...(s.paragraphs || []), ...(s.bullets || []).map(b => `• ${b}`), s.action ? `${s.action.label}: ${companyEmailUrl(s.action.url)}` : ''].filter(Boolean).join('\n')).join('\n\n');
        case 'resources': return block.entries.map((r, i) => `${String(i + 1).padStart(2, '0')} · ${r.title}\n${r.description}\nOpen resource: ${companyEmailUrl(r.url)}`).join('\n\n');
        case 'receipt': return ['Confirmation details', ...block.entries.map(d => `${d.label}: ${d.value}`), `${block.total.label}: ${block.total.value}`].join('\n');
        case 'photo': return `${photoCredit(block.photo)}\nPhoto source: ${companyEmailUrl(block.photo.sourceUrl)}\nLicence: ${companyEmailUrl(block.photo.licenseUrl)}`;
    }
}
export function renderCompanyEmail(doc) {
    const background = doc.tone === 'navy' ? NAVY : doc.tone === 'orange' ? ORANGE : '#FFFFFF';
    const ink = doc.tone === 'navy' ? '#FFFFFF' : NAVY;
    const muted = doc.tone === 'navy' ? '#DFE5EC' : doc.tone === 'orange' ? NAVY : MUTED;
    const footerActions = [doc.footer.preferences, doc.footer.unsubscribe].filter((a) => !!a);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="light"/><meta name="supported-color-schemes" content="light"/><title>${e(doc.subject)}</title><style>@media(max-width:480px){.email-pad{padding:20px 18px!important}.email-title{font-size:28px!important}}</style></head><body style="margin:0;padding:0;background:#EDF1F6;color:${NAVY};font-family:${FONT};font-size:16px;line-height:1.6;"><div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${e(doc.preheader)}</div><table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#EDF1F6"><tr><td align="center" style="padding:24px 0;"><!--[if mso]><table role="presentation" width="640" cellpadding="0" cellspacing="0"><tr><td><![endif]--><table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF" style="width:100%;max-width:640px;background:#FFFFFF;table-layout:fixed;border-top:5px solid ${ORANGE};"><tr><td class="email-pad" style="${PAD}"><img src="${e(companyEmailUrl(doc.logoUrl, true))}" alt="BeGifted" width="164" style="display:block;width:164px;max-width:100%;height:auto;border:0;"/></td></tr><tr><td class="email-pad" bgcolor="${background}" style="${PAD}background:${background};color:${ink};"><p style="margin:0 0 12px;font-size:13px;letter-spacing:1px;font-weight:700;color:${ink};">${e(doc.category)}${doc.edition ? ` · ${e(doc.edition)}` : ''}</p><h1 class="email-title" style="margin:0 0 16px;font-size:36px;line-height:1.15;font-weight:700;color:${ink};">${e(doc.title)}</h1>${doc.subtitle ? `<p style="margin:0;color:${muted};">${e(doc.subtitle)}</p>` : ''}</td></tr>${doc.blocks.map(blockHtml).join('')}<tr><td class="email-pad" style="${PAD}border-top:2px solid ${NAVY};font-size:13px;color:${MUTED};"><p style="margin:0 0 8px;font-weight:700;color:${NAVY};">BeGifted Education</p>${copy([doc.footer.note, ...(doc.footer.address ? [doc.footer.address] : [])])}${footerActions.map(link).join(' · ')}</td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
    const text = [doc.subject, doc.preheader, [doc.category, doc.edition].filter(Boolean).join(' · '), doc.title, doc.subtitle, ...doc.blocks.map(blockText), 'BeGifted Education', doc.footer.note, doc.footer.address, ...footerActions.map(a => `${a.label}: ${companyEmailUrl(a.url)}`)].filter(Boolean).join('\n\n');
    return { subject: doc.subject, html, text };
}

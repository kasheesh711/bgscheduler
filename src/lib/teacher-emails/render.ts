export interface TeacherEmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface EmailSection {
  kicker?: string;
  heading: string;
  paragraphs?: string[];
  details?: Array<{ label: string; value: string }>;
  bullets?: string[];
  action?: { label: string; url: string };
}

interface TeacherEmailDocument {
  subject: string;
  preheader: string;
  category: string;
  title: string;
  subtitle?: string;
  greeting: string;
  paragraphs: string[];
  sections: EmailSection[];
  logoUrl: string;
  footerNote?: string;
}

export function escapeEmailHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// URLs are prepared by the caller. Reject executable/relative URLs even when
// escaped: HTML escaping by itself does not make a link safe.
function emailUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Email links must use HTTP or HTTPS");
  }
  return escapeEmailHtml(url.toString());
}

const BODY_FONT = "Sarabun,Arial,Helvetica,sans-serif";
const LABEL_FONT = "Inter,Arial,Helvetica,sans-serif";
const HEAD_FONT = "'Space Grotesk',Arial,Helvetica,sans-serif";
const FOOTER = "BeGifted Education · Teacher updates";

function paragraph(value: string): string {
  return `<p style="margin:0 0 12px;">${escapeEmailHtml(value)}</p>`;
}

function sectionHtml(section: EmailSection): string {
  const action = section.action;
  return `<tr><td class="email-pad" style="padding:24px 32px;border-top:1px solid #DFE5EC;overflow-wrap:anywhere;word-break:break-word;">
    ${section.kicker ? `<p style="margin:0 0 8px;font-family:${LABEL_FONT};font-size:14px;font-weight:700;color:#C24E00;">${escapeEmailHtml(section.kicker)}</p>` : ""}
    <h2 style="margin:0 0 12px;font-family:${HEAD_FONT};font-size:22px;line-height:1.3;color:#16203A;">${escapeEmailHtml(section.heading)}</h2>
    ${(section.paragraphs ?? []).map(paragraph).join("")}
    ${section.details?.length ? `<table role="presentation" width="100%" style="width:100%;border-collapse:collapse;table-layout:fixed;">${section.details.map(detail => `<tr><td style="padding:5px 0;font-family:${BODY_FONT};font-size:16px;line-height:1.6;color:#16203A;overflow-wrap:anywhere;word-break:break-word;"><span style="font-family:${LABEL_FONT};font-size:12px;font-weight:600;color:#5A6678;">${escapeEmailHtml(detail.label)}</span><br>${escapeEmailHtml(detail.value)}</td></tr>`).join("")}</table>` : ""}
    ${section.bullets?.length ? `<ul style="margin:8px 0 0;padding-left:22px;">${section.bullets.map(item => `<li style="padding:0 0 6px;">${escapeEmailHtml(item)}</li>`).join("")}</ul>` : ""}
    ${action ? `<table role="presentation" style="border-collapse:collapse;margin-top:18px;"><tr><td bgcolor="#126DCE" style="background:#126DCE;border-radius:4px;text-align:center;mso-padding-alt:14px 20px;"><a href="${emailUrl(action.url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 20px;font-family:${LABEL_FONT};font-size:15px;line-height:20px;font-weight:700;color:#FFFFFF;text-decoration:none;">${escapeEmailHtml(action.label)}</a></td></tr></table>` : ""}
  </td></tr>`;
}

/** One content model produces both versions; no DB, clock, or delivery imports. */
export function renderTeacherEmail(document: TeacherEmailDocument): TeacherEmailContent {
  const text = [
    `BeGifted · ${document.title}`,
    ...(document.subtitle ? [document.subtitle] : []),
    "", document.greeting, "", ...document.paragraphs, "",
    ...document.sections.flatMap(section => [
      ...(section.kicker ? [section.kicker] : []), section.heading,
      ...(section.paragraphs ?? []),
      ...(section.details ?? []).map(detail => `${detail.label}: ${detail.value}`),
      ...(section.bullets ?? []).map(item => `- ${item}`),
      ...(section.action ? [`${section.action.label}: ${section.action.url}`] : []), "",
    ]),
    ...(document.footerNote ? [document.footerNote, ""] : []), FOOTER,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeEmailHtml(document.subject)}</title>
<style>@media screen and (max-width:480px){.email-pad{padding-left:20px!important;padding-right:20px!important}.email-outer{padding:12px 0!important}.email-title{font-size:28px!important}}</style></head>
<body style="margin:0;padding:0;background:#F6F8FB;color:#16203A;font-family:${BODY_FONT};font-size:16px;line-height:1.6;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeEmailHtml(document.preheader)}</div>
<table role="presentation" width="100%" bgcolor="#F6F8FB" style="width:100%;border-collapse:collapse;"><tr><td class="email-outer" align="center" style="padding:28px 12px;">
<!--[if mso]><table role="presentation" width="640"><tr><td><![endif]-->
<table role="presentation" width="100%" bgcolor="#FFFFFF" style="width:100%;max-width:640px;border-collapse:collapse;table-layout:fixed;background:#FFFFFF;color:#16203A;">
<tr><td class="email-pad" style="padding:24px 32px;border-top:5px solid #FF7518;"><img src="${emailUrl(document.logoUrl)}" alt="BeGifted" width="168" style="display:block;width:168px;max-width:100%;height:auto;border:0;color:#16203A;font-family:${LABEL_FONT};font-size:24px;font-weight:700;"></td></tr>
<tr><td class="email-pad" bgcolor="#16203A" style="padding:28px 32px;background:#16203A;color:#FFFFFF;overflow-wrap:anywhere;word-break:break-word;">
<p style="margin:0 0 12px;font-family:${LABEL_FONT};font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#FF7518;">${escapeEmailHtml(document.category)}</p>
<h1 class="email-title" style="margin:0;font-family:${HEAD_FONT};font-size:34px;line-height:1.15;font-weight:700;color:#FFFFFF;">${escapeEmailHtml(document.title)}</h1>
${document.subtitle ? `<p style="margin:14px 0 0;font-family:${LABEL_FONT};font-size:16px;line-height:1.5;color:#FFFFFF;">${escapeEmailHtml(document.subtitle)}</p>` : ""}</td></tr>
<tr><td class="email-pad" style="padding:24px 32px 12px;overflow-wrap:anywhere;word-break:break-word;">${paragraph(document.greeting)}${document.paragraphs.map(paragraph).join("")}</td></tr>
${document.sections.map(sectionHtml).join("")}
<tr><td class="email-pad" bgcolor="#F6F8FB" style="padding:24px 32px;border-top:1px solid #DFE5EC;background:#F6F8FB;font-family:${LABEL_FONT};font-size:12px;line-height:1.6;color:#5A6678;overflow-wrap:anywhere;word-break:break-word;">${document.footerNote ? paragraph(document.footerNote) : ""}<p style="margin:0;">${FOOTER}</p></td></tr>
</table><!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
  return { subject: document.subject.replace(/[\r\n]+/g, " "), html, text };
}

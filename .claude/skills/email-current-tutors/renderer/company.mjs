// Generated from emails/company.ts. Run npm run emails:build after editing the typed source.
import { renderCompanyEmail, companyEmailUrl } from "./company-render.mjs";
const definitions = {
    welcome: { category: 'WELCOME / YOUR NEXT STEPS', tone: 'white' },
    newsletter: { category: 'BEGIFTED / NEWSLETTER', tone: 'white' },
    programme: { category: 'PROGRAMMES / WHAT’S NEXT', tone: 'navy' },
    event: { category: 'EVENTS / YOU’RE INVITED', tone: 'navy' },
    'learning-update': { category: 'LEARNING / AN UPDATE', tone: 'white' },
    'resource-digest': { category: 'RESOURCES / WORTH YOUR TIME', tone: 'white' },
    're-engagement': { category: 'BEGIFTED / LET’S RECONNECT', tone: 'orange' },
    receipt: { category: 'CONFIRMATION / FOR YOUR RECORDS', tone: 'white' },
    security: { category: 'ACCOUNT / SECURE ACTION', tone: 'white' },
};
const campaignFamilies = new Set(['newsletter', 'programme', 'event', 'resource-digest', 're-engagement']);
function requireText(value, field) { if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} is required`); }
export function buildCompanyEmail(input) {
    if (!Object.hasOwn(definitions, input.template))
        throw new Error('Unknown company email template');
    for (const field of ['subject', 'preheader', 'title', 'logoUrl'])
        requireText(input[field], field);
    companyEmailUrl(input.logoUrl, true);
    const photo = input.photo;
    if (photo) {
        if (!campaignFamilies.has(input.template))
            throw new Error(`${input.template} is photo-free`);
        for (const field of ['url', 'alt', 'title', 'creator', 'sourceUrl', 'license', 'licenseUrl', 'modification'])
            requireText(photo[field], `Photo credit ${field}`);
        companyEmailUrl(photo.url, true);
        companyEmailUrl(photo.sourceUrl);
        companyEmailUrl(photo.licenseUrl);
    }
    const blocks = [];
    const addDetails = (heading, entries) => { if (entries?.length)
        blocks.push({ kind: 'details', heading, entries }); };
    const intro = [...(input.greeting ? [input.greeting] : []), ...(input.paragraphs || [])];
    if (intro.length)
        blocks.push({ kind: 'copy', paragraphs: intro });
    let edition;
    switch (input.template) {
        case 'welcome':
            if (input.steps?.length)
                blocks.push({ kind: 'steps', entries: input.steps });
            break;
        case 'newsletter':
            edition = input.issueLabel;
            break;
        case 'programme':
            addDetails('Programme at a glance', input.programmeDetails);
            break;
        case 'event':
            if (!Array.isArray(input.eventDetails) || !input.eventDetails.length)
                throw new Error('eventDetails is required');
            addDetails('Save the details', input.eventDetails);
            break;
        case 'learning-update':
            requireText(input.studentLabel, 'studentLabel');
            addDetails('Learning record', [{ label: 'Student', value: input.studentLabel }, ...(input.learningDetails || [])]);
            break;
        case 'resource-digest':
            if (!Array.isArray(input.resources))
                throw new Error('resources is required');
            if (input.resources.length)
                blocks.push({ kind: 'resources', entries: input.resources });
            break;
        case 're-engagement': break;
        case 'receipt':
            if (!Array.isArray(input.lineItems) || !input.total)
                throw new Error('lineItems and total are required');
            requireText(input.total.label, 'Total label');
            requireText(input.total.value, 'Total value');
            addDetails('Reference', input.confirmationDetails);
            blocks.push({ kind: 'receipt', entries: input.lineItems, total: input.total });
            break;
        case 'security':
            if (!input.action)
                throw new Error('Security action is required');
            if (input.securityNote)
                blocks.push({ kind: 'copy', heading: 'Security note', paragraphs: [input.securityNote] });
            break;
    }
    if (input.action)
        blocks.push({ kind: 'action', action: input.action });
    if (photo)
        blocks.push({ kind: 'photo', photo });
    for (const section of input.sections || []) {
        blocks.push({ kind: 'copy', heading: section.heading, paragraphs: section.paragraphs || [], bullets: section.bullets });
        if (section.action)
            blocks.push({ kind: 'action', action: section.action });
    }
    return renderCompanyEmail({ subject: input.subject, preheader: input.preheader, title: input.title, subtitle: input.subtitle, logoUrl: input.logoUrl, edition, ...definitions[input.template], blocks, footer: input.footer || { note: 'Please contact your BeGifted team if you need assistance.' } });
}

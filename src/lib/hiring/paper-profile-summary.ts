import { normalizeSubjects, type PreScreen, type Subject } from "./model";
import { profileDegree } from "./profile-degree";
import type { Assessment } from "./scoring";

const list = new Intl.ListFormat("en", { type: "conjunction" });
const degrees: Record<string, string> = {
  "Bachelor's": "a bachelor's degree",
  "Master's": "a master's degree",
  PhD: "a doctorate",
};
const curricula: Record<string, string> = {
  "IB (MYP/ DP)": "IB",
  "British (IGCSE/ GCSE/ A-level)": "the British curriculum",
  "American (US High School/ AP)": "the US curriculum",
};

// Older forms allow prose. Put only short labels inside the fixed sentences.
const fieldLabel = new RegExp("^[\\p{L}\\p{M}\\p{N} '&’/()-]+$", "u");
function shortLabel(value: string | undefined) {
  const label = value?.trim() ?? "";
  return label.length <= 60 && label.split(/\s+/).length <= 6 && fieldLabel.test(label) ? label : "";
}

export function paperProfileSummary(pre: PreScreen | null, assessment: Assessment | null, paperSubject: Subject) {
  const resumeDegree = profileDegree(assessment);
  const reportedDegree = pre?.degree?.split(/[,;]+/).map(value => value.trim()) ?? [];
  const level = ["PhD", "Master's", "Bachelor's"].find(value => reportedDegree.includes(value));
  const belowBachelor = !level && reportedDegree.includes("Below Bachelor's");
  const degree = level ?? resumeDegree?.degree;
  const field = shortLabel(level ? (reportedDegree.length === 1 ? pre?.field : undefined) : resumeDegree?.field);
  const education = belowBachelor ? "The candidate reports no bachelor's degree." : degree
    ? `The candidate ${level ? "reports" : "holds"} ${degrees[degree]}${field ? " in " + field : ""}.`
    : "The profile does not confirm a degree.";

  const reportedSubjects = normalizeSubjects(pre?.subjects ?? "");
  const subjects = reportedSubjects.length ? reportedSubjects : (assessment?.subjects ?? []).filter(item => item.relevant).map(item => item.subject);
  const subject = subjects.length
    ? `${reportedSubjects.length ? "Their teaching subjects include" : "Their résumé lists"} ${list.format([...new Set(subjects)].slice(0, 2))}.`
    : `The candidate took the ${paperSubject} paper.`;

  const choices = (pre?.curricula ?? "").split(/[,;\n]+/).map(value => value.trim())
    .flatMap(value => Object.hasOwn(curricula, value) ? [curricula[value]]
      : /^(?:Thai National Curriculum|IB(?: DP| MYP)?|IGCSE|GCSE|A[- ]Levels?|AP|SAT|ISEB)$/i.test(value) ? [value] : []);
  const curriculum = choices.length
    ? `Their curriculum choices include ${list.format([...new Set(choices)].slice(0, 2))}.`
    : assessment?.criteria.some(item => item.id === "curriculum" && item.result === "met")
      ? "The résumé shows curriculum experience." : "The profile does not confirm curriculum experience.";
  return [education, subject, curriculum].join(" ");
}

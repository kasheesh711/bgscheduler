export type ClassroomRoomCategory = "standard" | "overflow_only" | "online_only";

export interface ClassroomRoomDefinition {
  name: string;
  hasTv: boolean;
  capacity: number;
  category: ClassroomRoomCategory;
  active: boolean;
  sortOrder: number;
}

export const NO_ROOM_AVAILABLE = "NO_ROOM_AVAILABLE";
export const ROOM_ICONIC_TV = "Iconic (TV)";
export const ROOM_JOY = "Joy (TV)";
export const ROOM_KEEP_GOING_TV = "Keep Going (TV)";
export const ROOM_NEVER_EVER_TV = "Never Ever (TV)";
export const ROOM_RELAX_TV = "Relax (TV)";
export const ROOM_TURN_THE_PAGE_TV = "Turn The Page (TV)";
export const ROOM_REMEMBER_TV = "Remember (TV)";
export const ROOM_HERE_THERE_TV = "Here There (TV)";
export const ROOM_GO_ALL_IN_TV = "Go All In (TV)";
export const ROOM_DOUBT_TV = "Doubt (TV)";
export const ROOM_BIG_MEMORIES_TV = "Big Memories (TV)";
export const ROOM_THINK_OUTSIDE_THE_BOX = "Think Outside the Box";

export const TV_ROOM_WISE_NAME_BY_LEGACY_PLAIN_NAME = new Map<string, string>([
  ["Iconic", ROOM_ICONIC_TV],
  ["Joy", ROOM_JOY],
  ["Keep Going", ROOM_KEEP_GOING_TV],
  ["Never Ever", ROOM_NEVER_EVER_TV],
  ["Relax", ROOM_RELAX_TV],
  ["Turn The Page", ROOM_TURN_THE_PAGE_TV],
  ["Remember", ROOM_REMEMBER_TV],
  ["Here There", ROOM_HERE_THERE_TV],
  ["Go All In", ROOM_GO_ALL_IN_TV],
  ["Doubt", ROOM_DOUBT_TV],
  ["Big Memories", ROOM_BIG_MEMORIES_TV],
]);

export const LEGACY_PLAIN_TV_ROOM_NAMES = [...TV_ROOM_WISE_NAME_BY_LEGACY_PLAIN_NAME.keys()];
export const WISE_TV_ROOM_NAMES = [...TV_ROOM_WISE_NAME_BY_LEGACY_PLAIN_NAME.values()];

function normalizeRoomName(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function exactWiseRoomName(value: string | null | undefined): string {
  const normalized = normalizeRoomName(value);
  return TV_ROOM_WISE_NAME_BY_LEGACY_PLAIN_NAME.get(normalized) ?? normalized;
}

export function isLegacyPlainTvRoomName(value: string | null | undefined): boolean {
  return TV_ROOM_WISE_NAME_BY_LEGACY_PLAIN_NAME.has(normalizeRoomName(value));
}

export function tvRoomRepairLocation(value: string | null | undefined): string | null {
  return TV_ROOM_WISE_NAME_BY_LEGACY_PLAIN_NAME.get(normalizeRoomName(value)) ?? null;
}

export function normalizeTutorName(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function tutorRuleAliases(value: string): string[] {
  const normalized = normalizeTutorName(value).replace(/\s+Online$/i, "");
  const aliases = new Set([normalizeTutorName(value), normalized]);
  const nickname = normalized.match(/\(([^)]+)\)/)?.[1];
  if (nickname) aliases.add(normalizeTutorName(nickname));
  const firstName = normalized.split(/\s+/)[0];
  if (firstName) aliases.add(firstName);
  return [...aliases].filter(Boolean);
}

export const DEFAULT_CLASSROOM_ROOMS: ClassroomRoomDefinition[] = [
  { name: "Cool", hasTv: false, capacity: 3, category: "standard", active: true, sortOrder: 1 },
  { name: "Do It", hasTv: false, capacity: 3, category: "standard", active: true, sortOrder: 2 },
  { name: "Dream. Plan. Do.", hasTv: false, capacity: 3, category: "overflow_only", active: true, sortOrder: 3 },
  { name: "Focus", hasTv: false, capacity: 2, category: "standard", active: true, sortOrder: 4 },
  { name: "Hakuna Matata", hasTv: false, capacity: 3, category: "standard", active: true, sortOrder: 5 },
  { name: ROOM_ICONIC_TV, hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 6 },
  { name: "Isaac Newton", hasTv: false, capacity: 3, category: "standard", active: true, sortOrder: 7 },
  { name: ROOM_JOY, hasTv: true, capacity: 3, category: "standard", active: true, sortOrder: 8 },
  { name: ROOM_KEEP_GOING_TV, hasTv: true, capacity: 3, category: "standard", active: true, sortOrder: 9 },
  { name: "Nerd", hasTv: false, capacity: 3, category: "standard", active: true, sortOrder: 10 },
  { name: ROOM_NEVER_EVER_TV, hasTv: true, capacity: 3, category: "standard", active: true, sortOrder: 11 },
  { name: "OMG", hasTv: false, capacity: 3, category: "standard", active: true, sortOrder: 12 },
  { name: ROOM_RELAX_TV, hasTv: true, capacity: 8, category: "standard", active: true, sortOrder: 13 },
  { name: "Take Action", hasTv: false, capacity: 3, category: "standard", active: true, sortOrder: 14 },
  { name: "Tesla", hasTv: false, capacity: 3, category: "standard", active: true, sortOrder: 15 },
  { name: ROOM_THINK_OUTSIDE_THE_BOX, hasTv: false, capacity: 2, category: "standard", active: true, sortOrder: 16 },
  { name: ROOM_TURN_THE_PAGE_TV, hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 17 },
  { name: ROOM_REMEMBER_TV, hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 18 },
  { name: ROOM_HERE_THERE_TV, hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 19 },
  { name: ROOM_GO_ALL_IN_TV, hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 20 },
  { name: ROOM_DOUBT_TV, hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 21 },
  { name: ROOM_BIG_MEMORIES_TV, hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 22 },
  { name: "I learned (online)", hasTv: false, capacity: 1, category: "online_only", active: true, sortOrder: 23 },
  { name: "Hope (online)", hasTv: false, capacity: 1, category: "online_only", active: true, sortOrder: 24 },
];

export const TV_REQUIRED_TUTORS = new Set(
  [
    "Narongsak (Sagotty) Sriwiran",
    "Rachata (Mek) Sakpuaram",
    "Roger (Roger) Tang",
    "Patcharida (Nan) Penpakkul",
  ].flatMap(tutorRuleAliases).map(normalizeTutorName),
);

export const PREFERRED_BY_TUTOR = new Map<string, string>(
  [
    ["Wanwisa (Gift) Montrikittiphant", ROOM_JOY],
    ["Wanwisa (Gift) Montrikittiphant Online", ROOM_JOY],
    ["Tudda (Da) Tudsirivoravat", "Do It"],
    ["Tudda (Da) Tudsirivoravat Online", "Do It"],
    ["Wongsiri (Grace) Montrikittiphant", "Do It"],
    ["Wongsiri (Grace) Montrikittiphant Online", "Do It"],
    ["Apivit (Ek) Sirithana", "OMG"],
    ["Apivit (Ek) Sirithana Online", "OMG"],
    ["Usanee (Aey) Tortermpun", "Cool"],
    ["Usanee (Aey) Tortermpun Online", "Cool"],
    ["Chidchanok (Linn) Saetiaw", "Focus"],
    ["Chidchanok (Linn) Saetiaw Online", "Focus"],
    ["Thanit (Mimi) Montrikittiphant", "Take Action"],
    ["Thanit (Mimi) Montrikittiphant Online", "Take Action"],
    ["Pornnapha (Mint) Montrikittiphant", "Isaac Newton"],
    ["Pornnapha (Mint) Montrikittiphant Online", "Isaac Newton"],
    ["Smit (Tito) Kanjanapas", ROOM_THINK_OUTSIDE_THE_BOX],
    ["Kevin (Kev) Y. Hsieh", ROOM_THINK_OUTSIDE_THE_BOX],
    ["Kevin (Kev) Y. Hsieh Online", ROOM_THINK_OUTSIDE_THE_BOX],
    ["Menika (Menika) Ratnakovit", ROOM_ICONIC_TV],
    ["Menika (Menika) Ratnakovit Online", ROOM_ICONIC_TV],
    ["Kasidej (Peat) Jungrakangthong", "Hakuna Matata"],
    ["Kasidej (Peat) Jungrakangthong Online", "Hakuna Matata"],
    ["Mandy (Mandy) Boontanrart", ROOM_NEVER_EVER_TV],
    ["Mandy (Mandy) Boontanrart Online", ROOM_NEVER_EVER_TV],
    ["Calvin (Calvin) Lim Wen Quan", ROOM_NEVER_EVER_TV],
    ["Calvin (Calvin) Lim Wen Quan Online", ROOM_NEVER_EVER_TV],
    ["Narongsak (Sagotty) Sriwiran", ROOM_RELAX_TV],
    ["Narongsak (Sagotty) Sriwiran Online", ROOM_RELAX_TV],
    ["Thandolkhawathn (June) Choochaisangrathn", ROOM_BIG_MEMORIES_TV],
    ["Thandolkhawathn (June) Choochaisangrathn Online", ROOM_BIG_MEMORIES_TV],
    ["Sanpat (Copter) Chanthanuraks", ROOM_HERE_THERE_TV],
    ["Sanpat (Copter) Chanthanuraks Online", ROOM_HERE_THERE_TV],
    ["Nonthawat (Rew) Lertprasitchok", ROOM_GO_ALL_IN_TV],
    ["Nonthawat (Rew) Lertprasitchok Online", ROOM_GO_ALL_IN_TV],
    ["Porntawan (Lookpear) Maneechote", "Tesla"],
    ["Porntawan (Lookpear) Maneechote Online", "Tesla"],
  ].flatMap(([name, room]) => tutorRuleAliases(name).map((alias) => [normalizeTutorName(alias), room])),
);

export const PREFERRED_ROOMS = new Set(PREFERRED_BY_TUTOR.values());

const KEVIN_PRIORITY_TUTORS = new Set(
  [
    "Kevin (Kev) Y. Hsieh",
    "Kevin (Kev) Y. Hsieh Online",
  ].flatMap(tutorRuleAliases).map(normalizeTutorName),
);

export function isGiftTutor(tutorName: string): boolean {
  const tutorNorm = normalizeTutorName(tutorName);
  return (
    getPreferredRoom(tutorNorm) === ROOM_JOY ||
    tutorNorm === normalizeTutorName("Wanwisa (Gift) Montrikittiphant") ||
    tutorNorm === normalizeTutorName("Wanwisa (Gift) Montrikittiphant Online")
  );
}

export function isKevinPriorityTutor(tutorName: string): boolean {
  return KEVIN_PRIORITY_TUTORS.has(normalizeTutorName(tutorName));
}

export function getPreferredRoom(tutorName: string): string | undefined {
  return PREFERRED_BY_TUTOR.get(normalizeTutorName(tutorName));
}

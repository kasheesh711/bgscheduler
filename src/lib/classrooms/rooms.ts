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
export const ROOM_JOY = "Joy";
export const ROOM_THINK_OUTSIDE_THE_BOX = "Think Outside the Box";

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
  { name: "Iconic", hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 6 },
  { name: "Isaac Newton", hasTv: false, capacity: 3, category: "standard", active: true, sortOrder: 7 },
  { name: "Joy", hasTv: true, capacity: 3, category: "standard", active: true, sortOrder: 8 },
  { name: "Keep Going", hasTv: true, capacity: 3, category: "standard", active: true, sortOrder: 9 },
  { name: "Nerd", hasTv: false, capacity: 3, category: "standard", active: true, sortOrder: 10 },
  { name: "Never Ever", hasTv: true, capacity: 3, category: "standard", active: true, sortOrder: 11 },
  { name: "OMG", hasTv: false, capacity: 3, category: "standard", active: true, sortOrder: 12 },
  { name: "Relax", hasTv: true, capacity: 8, category: "standard", active: true, sortOrder: 13 },
  { name: "Take Action", hasTv: false, capacity: 3, category: "standard", active: true, sortOrder: 14 },
  { name: "Tesla", hasTv: false, capacity: 3, category: "standard", active: true, sortOrder: 15 },
  { name: ROOM_THINK_OUTSIDE_THE_BOX, hasTv: false, capacity: 2, category: "standard", active: true, sortOrder: 16 },
  { name: "Turn The Page", hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 17 },
  { name: "Remember", hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 18 },
  { name: "Here There", hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 19 },
  { name: "Go All In", hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 20 },
  { name: "Doubt", hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 21 },
  { name: "Big Memories", hasTv: true, capacity: 2, category: "standard", active: true, sortOrder: 22 },
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
    ["Wanwisa (Gift) Montrikittiphant", "Joy"],
    ["Wanwisa (Gift) Montrikittiphant Online", "Joy"],
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
    ["Menika (Menika) Ratnakovit", "Iconic"],
    ["Menika (Menika) Ratnakovit Online", "Iconic"],
    ["Kasidej (Peat) Jungrakangthong", "Hakuna Matata"],
    ["Kasidej (Peat) Jungrakangthong Online", "Hakuna Matata"],
    ["Mandy (Mandy) Boontanrart", "Never Ever"],
    ["Mandy (Mandy) Boontanrart Online", "Never Ever"],
    ["Calvin (Calvin) Lim Wen Quan", "Never Ever"],
    ["Calvin (Calvin) Lim Wen Quan Online", "Never Ever"],
    ["Narongsak (Sagotty) Sriwiran", "Relax"],
    ["Narongsak (Sagotty) Sriwiran Online", "Relax"],
    ["Thandolkhawathn (June) Choochaisangrathn", "Big Memories"],
    ["Thandolkhawathn (June) Choochaisangrathn Online", "Big Memories"],
    ["Sanpat (Copter) Chanthanuraks", "Here There"],
    ["Sanpat (Copter) Chanthanuraks Online", "Here There"],
    ["Nonthawat (Rew) Lertprasitchok", "Go All In"],
    ["Nonthawat (Rew) Lertprasitchok Online", "Go All In"],
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

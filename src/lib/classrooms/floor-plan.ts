import type { ClassroomRoomDefinition } from "./rooms";

export interface FloorPlanRoomGeometry {
  roomName: string;
  label: string;
  labelLines: string[];
  d: string;
  labelX: number;
  labelY: number;
  assignable: boolean;
  section: "left" | "center" | "right" | "context";
}

function rectPath(x: number, y: number, width: number, height: number): string {
  return `M${x} ${y}h${width}v${height}h-${width}z`;
}

export const FLOOR_PLAN_VIEWBOX = "0 0 1600 900";

export const FLOOR_PLAN_ROOMS: FloorPlanRoomGeometry[] = [
  {
    roomName: "Think Outside the Box",
    label: "Think Outside the Box",
    labelLines: ["Think", "Outside", "the Box"],
    d: rectPath(95, 30, 150, 190),
    labelX: 170,
    labelY: 92,
    assignable: true,
    section: "left",
  },
  {
    roomName: "Hakuna Matata",
    label: "Hakuna Matata",
    labelLines: ["Hakuna", "Matata"],
    d: rectPath(245, 70, 225, 125),
    labelX: 357,
    labelY: 118,
    assignable: true,
    section: "left",
  },
  {
    roomName: "Never Ever (TV)",
    label: "Never Ever (TV)",
    labelLines: ["Never Ever", "(TV)"],
    d: rectPath(470, 70, 220, 125),
    labelX: 580,
    labelY: 118,
    assignable: true,
    section: "left",
  },
  {
    roomName: "Keep Going (TV)",
    label: "Keep Going (TV)",
    labelLines: ["Keep Going", "(TV)"],
    d: rectPath(690, 70, 235, 125),
    labelX: 808,
    labelY: 118,
    assignable: true,
    section: "left",
  },
  {
    roomName: "Relax (TV)",
    label: "Relax (TV)",
    labelLines: ["Relax", "(TV)"],
    d: rectPath(95, 225, 285, 180),
    labelX: 237,
    labelY: 300,
    assignable: true,
    section: "left",
  },
  {
    roomName: "Big Memories (TV)",
    label: "Big Memories (TV)",
    labelLines: ["Big Memories", "(TV)"],
    d: rectPath(95, 405, 95, 105),
    labelX: 142,
    labelY: 448,
    assignable: true,
    section: "left",
  },
  {
    roomName: "Remember (TV)",
    label: "Remember (TV)",
    labelLines: ["Remember", "(TV)"],
    d: rectPath(190, 405, 95, 105),
    labelX: 238,
    labelY: 450,
    assignable: true,
    section: "left",
  },
  {
    roomName: "I learned (online)",
    label: "I learned (online)",
    labelLines: ["I learned", "(online)"],
    d: rectPath(285, 405, 95, 105),
    labelX: 333,
    labelY: 448,
    assignable: true,
    section: "left",
  },
  {
    roomName: "Dream. Plan. Do.",
    label: "Dream. Plan. Do.",
    labelLines: ["Dream.", "Plan.", "Do."],
    d: rectPath(75, 560, 115, 305),
    labelX: 133,
    labelY: 675,
    assignable: true,
    section: "left",
  },
  {
    roomName: "Doubt (TV)",
    label: "Doubt (TV)",
    labelLines: ["Doubt", "(TV)"],
    d: rectPath(190, 560, 85, 110),
    labelX: 232,
    labelY: 605,
    assignable: true,
    section: "left",
  },
  {
    roomName: "Here There (TV)",
    label: "Here There (TV)",
    labelLines: ["Here There", "(TV)"],
    d: rectPath(275, 560, 80, 110),
    labelX: 315,
    labelY: 602,
    assignable: true,
    section: "left",
  },
  {
    roomName: "Hope (online)",
    label: "Hope (online)",
    labelLines: ["Hope", "(online)"],
    d: rectPath(355, 560, 85, 110),
    labelX: 398,
    labelY: 602,
    assignable: true,
    section: "left",
  },
  {
    roomName: "Focus",
    label: "Focus",
    labelLines: ["Focus"],
    d: "M190 740h165v-30h45v155H190z",
    labelX: 292,
    labelY: 785,
    assignable: true,
    section: "left",
  },
  {
    roomName: "Do It",
    label: "Do It",
    labelLines: ["Do It"],
    d: "M600 245c0-70 45-105 155-105h0c110 0 155 35 155 105v105H600z",
    labelX: 755,
    labelY: 275,
    assignable: true,
    section: "center",
  },
  {
    roomName: "Take Action",
    label: "Take Action",
    labelLines: ["Take", "Action"],
    d: rectPath(600, 350, 150, 110),
    labelX: 675,
    labelY: 390,
    assignable: true,
    section: "center",
  },
  {
    roomName: "Tesla",
    label: "Tesla",
    labelLines: ["Tesla"],
    d: rectPath(750, 350, 160, 110),
    labelX: 830,
    labelY: 390,
    assignable: true,
    section: "center",
  },
  {
    roomName: "Cool",
    label: "Cool",
    labelLines: ["Cool"],
    d: "M600 460h150v110H615c-10 0-15-8-15-20z",
    labelX: 675,
    labelY: 502,
    assignable: true,
    section: "center",
  },
  {
    roomName: "Iconic (TV)",
    label: "Iconic (TV)",
    labelLines: ["Iconic", "(TV)"],
    d: "M750 460h160v90c0 12-8 20-20 20H750z",
    labelX: 830,
    labelY: 502,
    assignable: true,
    section: "center",
  },
  {
    roomName: "Go All In (TV)",
    label: "Go All In (TV)",
    labelLines: ["Go All In", "(TV)"],
    d: rectPath(635, 570, 145, 85),
    labelX: 708,
    labelY: 605,
    assignable: true,
    section: "center",
  },
  {
    roomName: "Turn The Page (TV)",
    label: "Turn The Page (TV)",
    labelLines: ["Turn The Page", "(TV)"],
    d: rectPath(635, 655, 145, 100),
    labelX: 708,
    labelY: 695,
    assignable: true,
    section: "center",
  },
  {
    roomName: "Joy (TV)",
    label: "Joy (TV)",
    labelLines: ["Joy", "(TV)"],
    d: "M1145 30h180v155h-180V60z",
    labelX: 1235,
    labelY: 86,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Isaac Newton",
    label: "Isaac Newton",
    labelLines: ["Isaac", "Newton"],
    d: rectPath(1145, 185, 180, 150),
    labelX: 1235,
    labelY: 250,
    assignable: true,
    section: "right",
  },
  {
    roomName: "OMG",
    label: "OMG",
    labelLines: ["OMG"],
    d: rectPath(1145, 335, 180, 145),
    labelX: 1235,
    labelY: 405,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Nerd",
    label: "Nerd",
    labelLines: ["Nerd"],
    d: rectPath(1145, 480, 180, 140),
    labelX: 1235,
    labelY: 550,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Parent Waiting Area",
    label: "Parent Waiting Area",
    labelLines: ["Parent", "Waiting Area"],
    d: "M1145 620h180v180l-65 30H1000l90-45z",
    labelX: 1200,
    labelY: 690,
    assignable: false,
    section: "context",
  },
];

export const FLOOR_PLAN_ASSIGNABLE_ROOM_NAMES = FLOOR_PLAN_ROOMS
  .filter((room) => room.assignable)
  .map((room) => room.roomName);

const FLOOR_PLAN_ORDER = new Map(
  FLOOR_PLAN_ROOMS.map((room, index) => [room.roomName, index]),
);

export function getFloorPlanGeometry(roomName: string): FloorPlanRoomGeometry | undefined {
  return FLOOR_PLAN_ROOMS.find((room) => room.roomName === roomName);
}

export function getFloorPlanRoomOrder(roomName: string): number {
  return FLOOR_PLAN_ORDER.get(roomName) ?? Number.MAX_SAFE_INTEGER;
}

export function sortRoomsByFloorPlan<T extends Pick<ClassroomRoomDefinition, "name" | "sortOrder">>(
  rooms: T[],
): T[] {
  return [...rooms].sort((a, b) => {
    const orderDiff = getFloorPlanRoomOrder(a.name) - getFloorPlanRoomOrder(b.name);
    if (orderDiff !== 0) return orderDiff;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name);
  });
}

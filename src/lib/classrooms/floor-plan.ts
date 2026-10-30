import type { ClassroomRoomDefinition } from "./rooms";

export interface FloorPlanRoomGeometry {
  roomName: string;
  label: string;
  labelLines: string[];
  d: string;
  labelX: number;
  labelY: number;
  markerX?: number;
  markerY?: number;
  assignable: boolean;
  section: "left" | "center" | "right" | "context";
}

function rectPath(x: number, y: number, width: number, height: number): string {
  return `M${x} ${y}h${width}v${height}h-${width}z`;
}

export const FLOOR_PLAN_WIDTH = 2200;
export const FLOOR_PLAN_HEIGHT = 1200;
export const FLOOR_PLAN_VIEWBOX = `0 0 ${FLOOR_PLAN_WIDTH} ${FLOOR_PLAN_HEIGHT}`;
export const FLOOR_PLAN_GUIDE_PATH = "M245 220H1145M430 815H1050M470 220V480M1090 220V960H1760V475M1480 220H2080M1760 220V245";

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
    labelLines: ["Big", "Memories", "(TV)"],
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
    labelLines: ["Here", "There", "(TV)"],
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
    d: "M600 300c0-37 45-55 155-55h0c110 0 155 18 155 55v50H600z",
    labelX: 755,
    labelY: 300,
    markerX: 650,
    markerY: 315,
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
    labelLines: ["Turn The", "Page", "(TV)"],
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
    d: rectPath(850, 1010, 1210, 145),
    labelX: 1455,
    labelY: 1070,
    assignable: false,
    section: "context",
  },
  {
    roomName: "Consistency Wins",
    label: "Consistency Wins",
    labelLines: ["Consistency", "Wins"],
    d: rectPath(1480, 30, 175, 155),
    labelX: 1567,
    labelY: 107,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Shift",
    label: "Shift",
    labelLines: ["Shift"],
    d: rectPath(1655, 30, 175, 155),
    labelX: 1742,
    labelY: 107,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Trust the Process",
    label: "Trust the Process",
    labelLines: ["Trust the", "Process"],
    d: rectPath(1830, 30, 230, 155),
    labelX: 1945,
    labelY: 107,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Eureka",
    label: "Eureka",
    labelLines: ["Eureka"],
    d: rectPath(1660, 245, 400, 150),
    labelX: 1860,
    labelY: 320,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Now",
    label: "Now",
    labelLines: ["Now"],
    d: rectPath(1830, 405, 230, 80),
    labelX: 1945,
    labelY: 445,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Win or Learn",
    label: "Win or Learn",
    labelLines: ["Win or Learn"],
    d: rectPath(1480, 505, 215, 110),
    labelX: 1587,
    labelY: 560,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Possible",
    label: "Possible",
    labelLines: ["Possible"],
    d: rectPath(1830, 505, 230, 110),
    labelX: 1945,
    labelY: 560,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Momentum",
    label: "Momentum",
    labelLines: ["Momentum"],
    d: rectPath(1480, 625, 215, 110),
    labelX: 1587,
    labelY: 680,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Try",
    label: "Try",
    labelLines: ["Try"],
    d: rectPath(1830, 625, 230, 110),
    labelX: 1945,
    labelY: 680,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Gain",
    label: "Gain",
    labelLines: ["Gain"],
    d: rectPath(1480, 745, 215, 110),
    labelX: 1587,
    labelY: 800,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Think Different",
    label: "Think Different",
    labelLines: ["Think", "Different"],
    d: rectPath(1830, 745, 230, 110),
    labelX: 1945,
    labelY: 800,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Productive",
    label: "Productive",
    labelLines: ["Productive"],
    d: rectPath(1830, 865, 230, 110),
    labelX: 1945,
    labelY: 920,
    assignable: true,
    section: "right",
  },
  {
    roomName: "Server and Printing",
    label: "Server and Printing",
    labelLines: ["Server and", "Printing"],
    d: rectPath(1480, 865, 215, 110),
    labelX: 1587,
    labelY: 920,
    assignable: false,
    section: "context",
  },
  {
    roomName: "Reception",
    label: "Reception",
    labelLines: ["Reception"],
    d: rectPath(850, 905, 570, 85),
    labelX: 1135,
    labelY: 947,
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

import css from "./dashboard.module.css";

type Shape = { label: string; values: number[]; tone: "profile" | "preScreen" };
type Corner = { name: string; value: string };

const CENTRE = [110, 100];
const RADIUS = 72;
const point = (i: number, v: number) => {
  const angle = ((-90 + 72 * i) * Math.PI) / 180;
  return [CENTRE[0] + RADIUS * v * Math.cos(angle), CENTRE[1] + RADIUS * v * Math.sin(angle)];
};
const polygon = (values: number[]) =>
  values.map((v, i) => point(i, v).map((n) => n.toFixed(1)).join(",")).join(" ");
// Nudges keep each label clear of its corner: top label sits above, lower ones sit below.
const NUDGE_X = [0, 6, 2, -2, -6];
const LINE = 14;
// Text sits 6 units clear of the ring: above the apex for the top corner, below the vertex for the lower two.
const GAP = 6;
const VIEW = { x: -50, y: -18, width: 320, height: 228 };
const ANCHOR = ["middle", "start", "start", "end", "end"] as const;

// "No evidence → Partial" is too wide for the edge corners on one line, so a changed result wraps at the arrow.
const valueLines = (value: string) => {
  const [before, after] = value.split(" → ");
  return after === undefined ? [value] : [before, `→ ${after}`];
};

/** Five-corner DSCTE chart. Every corner shows its name and a result or percentage. */
export function Pentagon({
  shapes,
  labels,
  size = 270,
  title = "DSCTE pentagon",
}: {
  shapes: Shape[];
  labels: Corner[];
  size?: number;
  title?: string;
}) {
  const description = labels.map((l) => `${l.name}: ${l.value}`).join(", ");
  return (
    <svg
      width={size}
      height={Math.round((size * VIEW.height) / VIEW.width)}
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`}
      role="img"
      aria-label={`${title}. ${description}`}
      className={css.pentagon}
    >
      <polygon points={polygon([1, 1, 1, 1, 1])} className={css.pentagonRing} />
      <polygon points={polygon([0.5, 0.5, 0.5, 0.5, 0.5])} className={css.pentagonRingInner} />
      {[0, 1, 2, 3, 4].map((i) => (
        <line key={i} x1={CENTRE[0]} y1={CENTRE[1]} x2={point(i, 1)[0]} y2={point(i, 1)[1]} className={css.pentagonRingInner} />
      ))}
      {shapes.map((s) => (
        <polygon
          key={s.label}
          points={polygon(s.values)}
          className={s.tone === "preScreen" ? css.pentagonPre : css.pentagonProfile}
        >
          <title>{s.label}</title>
        </polygon>
      ))}
      {labels.map((l, i) => {
        const [x, y] = point(i, 1);
        const lines = valueLines(l.value);
        // The name is the first baseline; the value lines follow it. The top corner's last line ends GAP above the apex.
        const top = i === 0 ? y - GAP - LINE * lines.length : y + (i === 2 || i === 3 ? GAP + 9 : 0);
        return (
          <g key={l.name} textAnchor={ANCHOR[i]} aria-hidden="true">
            <text x={x + NUDGE_X[i]} y={top} className={css.pentagonName}>{l.name}</text>
            {lines.map((line, n) => (
              <text key={n} x={x + NUDGE_X[i]} y={top + LINE * (n + 1)} className={css.pentagonValue}>{line}</text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

import css from "./dashboard.module.css";

/** Grey blocks in the shape of a tab while its data loads. The label names the tab. */
export function TabSkeleton({ label, hidden }: { label: string; hidden?: boolean }) {
  return (
    <div role="status" className={css.skeleton} hidden={hidden}>
      <p className={css.loading}>{label}</p>
      <span className={css.skeletonHero} aria-hidden="true" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={css.skeletonLine} aria-hidden="true" />
      ))}
    </div>
  );
}

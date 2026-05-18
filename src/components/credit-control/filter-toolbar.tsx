import type { AdminViewOption } from "@/types/credit-control";
import type { RiskFilter } from "@/lib/credit-control/ui-helpers";
import { capitalize } from "@/lib/credit-control/ui-helpers";

export function FilterToolbar({
  adminViews,
  adminView,
  onSetAdminView,
  search,
  onSetSearch,
  riskFilter,
  onSetRiskFilter,
  sortedQueueLength,
}: {
  adminViews: AdminViewOption[];
  adminView: string;
  onSetAdminView: (key: string) => void;
  search: string;
  onSetSearch: (value: string) => void;
  riskFilter: RiskFilter;
  onSetRiskFilter: (filter: RiskFilter) => void;
  sortedQueueLength: number;
}) {
  return (
    <>
      <section className="toolbar">
        <div className="tab-row">
          {adminViews.map((view) => (
            <button
              key={view.key}
              className={view.key === adminView ? "chip is-active" : "chip"}
              onClick={() => onSetAdminView(view.key)}
              type="button"
            >
              {view.label}
            </button>
          ))}
        </div>

        <div className="toolbar-right">
          <div className="search-wrap">
            <input
              aria-label="Search students"
              className="search-input"
              onChange={(event) => onSetSearch(event.target.value)}
              placeholder="Search student, parent, package"
              value={search}
            />
            {search ? (
              <button className="icon-button" onClick={() => onSetSearch("")} type="button">
                ×
              </button>
            ) : null}
          </div>
          <span className="meta-chip">{sortedQueueLength} students</span>
        </div>
      </section>

      <section className="toolbar">
        <div className="tab-row">
          {(["all", "notify", "watch", "ok"] as RiskFilter[]).map((filter) => (
            <button
              key={filter}
              className={filter === riskFilter ? "chip is-active" : "chip"}
              onClick={() => onSetRiskFilter(filter)}
              type="button"
            >
              {filter === "all" ? "All" : filter === "ok" ? "Healthy" : capitalize(filter)}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

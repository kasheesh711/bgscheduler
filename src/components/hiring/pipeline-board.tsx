"use client";

import { useMemo } from "react";
import { buildPipelineBoard } from "@/lib/hiring/pipeline-board";
import type { HiringData } from "./dashboard";
import css from "./dashboard.module.css";
import b from "./pipeline-board.module.css";

const people = (n: number) => `${n} ${n === 1 ? "candidate" : "candidates"}`;

/** The Overview board: each candidate in process from the HR call onward, by step, with the bottleneck named. */
export function PipelineBoardPanel({ data, onOpenRecord }: { data: HiringData; onOpenRecord: (id: string) => void }) {
  // A new clock for each data load keeps the days current.
  const board = useMemo(() => buildPipelineBoard(data, new Date()), [data]);
  const worst = board.columns.find((column) => column.key === board.bottleneck);
  return (
    <section className={css.panel} aria-labelledby="pipeline-board-title">
      <h2 id="pipeline-board-title" className={css.panelTitle}>Pipeline</h2>
      <p className={css.panelLede}>
        {worst ? (
          <>
            <strong>Bottleneck: {worst.label}.</strong>{" "}
            {worst.stuck > 0 ? `${people(worst.stuck)} stuck.` : `${people(worst.count)} wait here.`} Next action: {worst.owner}.
          </>
        ) : (
          "No bottleneck now."
        )}{" "}
        Click a name to open the record.
      </p>
      <ol className={b.board} role="list">
        {/* The HR call column shows only while a call is booked: HR calls are retired (Kevin, 24 Nov 2026). */}
        {board.columns.filter((column) => column.key !== "call" || column.cards.length > 0).map((column) => {
          const bottleneck = column.key === board.bottleneck;
          return (
            <li key={column.key} className={b.column} data-bottleneck={bottleneck ? "" : undefined} aria-label={`${column.label}: ${people(column.count)}${bottleneck ? ", bottleneck" : ""}`}>
              <div className={b.head}>
                <h3 className={b.label}>
                  {column.label} <span className={b.count}>{column.count}</span>
                </h3>
                {bottleneck && <span className={b.flag}>Bottleneck</span>}
                <p className={b.stats}>
                  {column.owner}
                  {column.medianDays !== null && ` · median ${column.medianDays} d`}
                  {column.stuck > 0 && ` · ${column.stuck} stuck`}
                </p>
              </div>
              {column.cards.length ? (
                <ul className={b.cards} role="list">
                  {column.cards.map((card) => (
                    <li key={card.id}>
                      <button
                        type="button"
                        className={b.card}
                        data-stuck={card.stuck ? "" : undefined}
                        onClick={() => onOpenRecord(card.id)}
                        aria-label={`Open ${card.name}: ${column.label}, ${card.stuck ? "stuck " : ""}${card.days} days. ${card.note}`}
                      >
                        <span className={b.name}>{card.name}</span>
                        <span className={b.days}>{card.stuck ? `Stuck ${card.days} d` : `${card.days} d`}</span>
                        {card.subject && <span className={b.meta}>{card.subject}</span>}
                        <span className={b.meta}>{card.note}</span>
                        <span className={b.meta}>Next: {card.owner}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={b.empty}>Nobody here</p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

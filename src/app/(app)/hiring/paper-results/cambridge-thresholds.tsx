import syllabuses from "@/lib/hiring/cambridge-igcse-thresholds.json";

const grades = ["A*", "A", "B", "C", "D", "E", "F", "G"];
const benchmark = 80;
const cell = "px-3 py-2 text-right whitespace-nowrap";

const zoneLookup = "https://www.cambridgeinternational.org/exam-administration/cambridge-exams-officers-guide/phase-1-preparation/timetabling-exams/administrative-zone/?Location=Bangkok";
const zoneTimetable = "https://www.cambridgeinternational.org/Images/757649-november-2026-zone-4-timetable.pdf";
const routeId = (code: string, components: string) => "igcse-" + code + "-" + components.replaceAll(", ", "-");

export function CambridgeThresholds() {
  return <section aria-labelledby="cambridge-title" id="cambridge-thresholds" className="scroll-mt-4">
    <h2 id="cambridge-title" className="text-xl font-semibold">Cambridge IGCSE grade thresholds</h2>
    <p className="mt-2 text-sm">Bangkok is in Cambridge administrative Zone 4. First Language English (0500) and Literature in English (0475) use paper variant 2. Choose the row for the components on the school’s entry. <a className="underline" href={zoneLookup}>Bangkok zone lookup</a> · <a className="underline" href={zoneTimetable}>Zone 4 timetable</a></p>
    <p className="my-2 text-sm text-muted-foreground">Five June exam series, 2022–2026. Each value is the average of five annual thresholds, expressed as a percentage of the maximum weighted mark for the stated combination of papers. We use variant 2 where available and the extended route for tiered subjects. Other combinations can have different thresholds.</p>
    <p className="mb-3 text-sm">Compare the 80% hiring benchmark with the minimum for each Cambridge grade. A positive gap means 80% is above the average A* threshold. Hiring papers assess different questions and levels, so this comparison cannot assign a Cambridge grade to a candidate.</p>
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-left text-sm tabular-nums">
        <caption className="sr-only">Five-year average threshold by syllabus and grade. Gap is 80% minus the A* threshold in percentage points.</caption>
        <thead className="bg-muted text-xs"><tr><th scope="col" className="px-3 py-2">Hiring subject / syllabus</th>
          {grades.map(grade => <th scope="col" className={cell} key={grade}>{grade}</th>)}
          <th scope="col" className={cell}>80% − A* (pp)</th></tr></thead>
        <tbody>{syllabuses.map(({ subject, code, years }) => {
          const averages = grades.map((_, index) => {
            const percentages = years.flatMap(({ marks, max }) => marks[index] === null ? [] : [100 * marks[index] / max]);
            return percentages.length === 5 ? percentages.reduce((sum, value) => sum + value, 0) / 5 : null;
          });
          const gap = averages[0] === null ? null : benchmark - averages[0];
          return <tr key={subject} className="border-t">
            <th scope="row" className="px-3 py-2 font-medium"><a href={'#' + routeId(code, years[0].components)} className="underline underline-offset-4">{subject} ({code})</a></th>
            {averages.map((value, i) => <td key={grades[i]} className={cell}>{value === null ? "—" : value.toFixed(1) + "%"}</td>)}
            <td className={cell}>{gap === null ? "—" : (gap > 0 ? "+" : "") + gap.toFixed(1)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <p className="mt-2 text-xs text-muted-foreground">A dash means the route did not offer that grade in all five years. Art &amp; Design Technology has two syllabuses. IELTS uses its own band scale. Hiring uses Cambridge AS &amp; A Level for Psychology.</p>
    <h3 className="mt-5 font-semibold">Annual thresholds and source papers</h3>
    <div className="mt-2 divide-y rounded-lg border bg-card">{syllabuses.map(({ subject, code, years }) =>
      <details key={subject} id={routeId(code, years[0].components)} className="scroll-mt-4 px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">{subject} ({code})</summary>
        <div className="mt-2 overflow-x-auto"><table className="w-full text-left tabular-nums">
          <caption className="mb-1 text-left text-xs text-muted-foreground">Minimum weighted marks by grade. Select a year to open the official table.</caption>
          <thead><tr><th scope="col">June series</th><th scope="col" className={cell}>Components</th><th scope="col" className={cell}>Maximum</th>
            {grades.map(grade => <th scope="col" className={cell} key={grade}>{grade}</th>)}</tr></thead>
          <tbody>{years.map(year => <tr key={year.year} className="border-t">
            <th scope="row"><a href={year.source} className="underline underline-offset-4" aria-label={subject + " June " + year.year + " Cambridge PDF"}>{year.year}</a></th>
            <td className={cell}>{year.components}</td><td className={cell}>{year.max}</td>
            {year.marks.map((mark, i) => <td key={grades[i]} className={cell}>{mark ?? "—"}</td>)}
          </tr>)}</tbody>
        </table></div>
      </details>)}</div>
  </section>;
}

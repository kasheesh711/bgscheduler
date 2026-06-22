"use client";

// ----------------------------------------------------------------------------
// Dossier section nav — sticky in-page scroll-spy. The pure resolver
// (resolveActiveSection) maps a set of currently-visible section ids to the
// single active anchor (first by declared order); it is unit-tested directly.
// The IntersectionObserver effect that feeds it does not run under SSR.
// ----------------------------------------------------------------------------

import { cn } from "@/lib/utils";

export interface DossierSection {
  id: string;
  label: string;
}

/**
 * Resolve the active section: the first section (in declared order) whose id is
 * currently visible. Returns null when none are visible.
 */
export function resolveActiveSection(
  sections: ReadonlyArray<DossierSection>,
  visibleIds: ReadonlyArray<string>,
): string | null {
  const visible = new Set(visibleIds);
  for (const section of sections) {
    if (visible.has(section.id)) return section.id;
  }
  return null;
}

export function DossierSectionNav({
  sections,
  activeId,
  className,
}: {
  sections: ReadonlyArray<DossierSection>;
  activeId?: string | null;
  className?: string;
}): React.JSX.Element {
  return (
    <nav className={cn("flex flex-col gap-0.5", className)} aria-label="Dossier sections">
      {sections.map((section) => {
        const active = section.id === activeId;
        return (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={active ? "true" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-sm transition-colors",
              active
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {section.label}
          </a>
        );
      })}
    </nav>
  );
}

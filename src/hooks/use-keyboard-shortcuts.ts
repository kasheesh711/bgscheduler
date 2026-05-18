import { useCallback, useEffect, useState } from "react";

export interface KeyboardShortcutActions {
  onNextStudent: () => void;
  onPrevStudent: () => void;
  onMarkContacted: () => void;
  onMarkPending: () => void;
  onMarkResolved: () => void;
  onOpenLineDrawer: () => void;
  onComboContactNext: () => void;
  onFocusSearch: () => void;
  onEscape: () => void;
}

export function useKeyboardShortcuts(actions: KeyboardShortcutActions) {
  const [showHelp, setShowHelp] = useState(false);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const tag = target.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || target.isContentEditable) return;

      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault();
          actions.onNextStudent();
          break;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          actions.onPrevStudent();
          break;
        case "c":
          actions.onMarkContacted();
          break;
        case "p":
          actions.onMarkPending();
          break;
        case "r":
          actions.onMarkResolved();
          break;
        case "l":
          actions.onOpenLineDrawer();
          break;
        case "L":
          if (event.shiftKey) {
            event.preventDefault();
            actions.onComboContactNext();
          }
          break;
        case "/":
        case "s":
          event.preventDefault();
          actions.onFocusSearch();
          break;
        case "Escape":
          actions.onEscape();
          break;
        case "?":
          event.preventDefault();
          setShowHelp((prev) => !prev);
          break;
      }
    },
    [actions],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return { showHelp, setShowHelp };
}

export const SHORTCUT_LIST = [
  { key: "j / ↓", description: "Next student" },
  { key: "k / ↑", description: "Previous student" },
  { key: "c", description: "Mark contacted" },
  { key: "p", description: "Mark pending callback" },
  { key: "r", description: "Mark resolved" },
  { key: "l", description: "Open LINE drawer" },
  { key: "Shift+L", description: "Copy LINE + mark contacted + next" },
  { key: "/ or s", description: "Focus search" },
  { key: "Esc", description: "Close / clear" },
  { key: "?", description: "Toggle this help" },
] as const;

// ----------------------------------------------------------------------------
// Shared form-control classes for the admissions raw <select> elements.
//
// One source of truth (previously copy-pasted per view with drift): sizing
// (h-*/w-*) stays with the consumer via cn(); the font pair `text-base
// md:text-sm` mirrors the Input/Textarea primitives so iOS Safari never
// zoom-on-focuses a sub-16px control on the mobile portals (design §5.2/§5.3).
// ----------------------------------------------------------------------------

/** Base classes for raw <select> controls; compose sizing via cn(). */
export const SELECT_FIELD_CLASSES =
  "rounded-lg border border-input bg-transparent px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

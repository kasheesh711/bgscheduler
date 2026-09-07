import { isPreviewEnvironment } from "@/lib/preview-policy";

export function PreviewBanner() {
  if (!isPreviewEnvironment()) return null;
  return (
    <div role="status" className="shrink-0 border-b border-amber-300 bg-amber-100 px-4 py-2 text-center text-sm font-medium text-amber-950">
      Preview workspace · Changes here are for testing. Publish your approved update to change the live website.
    </div>
  );
}

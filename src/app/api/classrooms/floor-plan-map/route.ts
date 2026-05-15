import { renderFloorPlanMapSvg } from "@/lib/classrooms/floor-plan-map";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rooms = url.searchParams.get("rooms")
    ?.split("|")
    .map((room) => room.trim())
    .filter(Boolean) ?? [];

  return new Response(renderFloorPlanMapSvg(rooms), {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

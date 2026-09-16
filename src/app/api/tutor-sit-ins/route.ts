import { requireSitInAccess } from "@/lib/tutor-sit-ins/access";
import { sitInError, sitInJson } from "@/lib/tutor-sit-ins/http";
import { defaultQuarter, quarterSchema } from "@/lib/tutor-sit-ins/model";
import { overview } from "@/lib/tutor-sit-ins/service";
export async function GET(request: Request) {
  try {
    return sitInJson(
      await overview(
        await requireSitInAccess(),
        quarterSchema.parse(
          new URL(request.url).searchParams.get("quarter") || defaultQuarter(),
        ),
      ),
    );
  } catch (e) {
    return sitInError(e);
  }
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ db: true })) }));
vi.mock("@/lib/line/oa-resolver", () => ({
  updateLineOaResolverRowsFromExtension: vi.fn(async () => ({ id: "run-1" })),
}));

import { updateLineOaResolverRowsFromExtension } from "@/lib/line/oa-resolver";
import { POST } from "@/app/api/line/contacts/oa-resolver/runs/[runId]/rows/route";

function request(body: unknown, token?: string) {
  return new NextRequest("http://test.local/api/line/contacts/oa-resolver/runs/run-1/rows", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ runId: "00000000-0000-4000-8000-000000000001" }) };

describe("LINE OA resolver row update route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(updateLineOaResolverRowsFromExtension).mockResolvedValue({ id: "run-1" } as never);
  });

  it("requires a resolver token", async () => {
    const response = await POST(request({ rows: [] }), ctx);

    expect(response.status).toBe(401);
    expect(updateLineOaResolverRowsFromExtension).not.toHaveBeenCalled();
  });

  it("validates row updates", async () => {
    const response = await POST(request({ rows: [{ status: "matched" }] }, "token-1"), ctx);

    expect(response.status).toBe(400);
    expect(updateLineOaResolverRowsFromExtension).not.toHaveBeenCalled();
  });

  it("passes valid updates to the resolver service", async () => {
    const response = await POST(request({
      rows: [{
        rowId: "00000000-0000-4000-8000-000000000002",
        status: "matched",
        lineChatUrl: "https://chat.line.biz/Ueebc1942ed1ed3bd52bb0c6e8d122565/chat/U9fdc5658d0c2cbfc02d0a2acc89fdb6d",
        chatTitle: "Maida/Nasda.Su",
        captureMode: "extension",
      }],
    }, "token-1"), ctx);

    expect(response.status).toBe(200);
    expect(updateLineOaResolverRowsFromExtension).toHaveBeenCalledWith({ db: true }, {
      token: "token-1",
      runId: "00000000-0000-4000-8000-000000000001",
      rows: [{
        rowId: "00000000-0000-4000-8000-000000000002",
        status: "matched",
        lineChatUrl: "https://chat.line.biz/Ueebc1942ed1ed3bd52bb0c6e8d122565/chat/U9fdc5658d0c2cbfc02d0a2acc89fdb6d",
        chatTitle: "Maida/Nasda.Su",
        captureMode: "extension",
      }],
    });
  });

  it("accepts multi-candidate resolver updates", async () => {
    const response = await POST(request({
      rows: [{
        rowId: "00000000-0000-4000-8000-000000000002",
        status: "ambiguous",
        candidates: [{
          lineChatUrl: "https://chat.line.biz/Ueebc1942ed1ed3bd52bb0c6e8d122565/chat/U9fdc5658d0c2cbfc02d0a2acc89fdb6d",
          chatTitle: "Copter mom",
          adminNoteRaw: "mom",
          relationshipRole: "mom",
          candidateRank: 1,
          captureMode: "extension",
          matchMode: "multi_candidate",
          searchCode: "Copter.Th",
        }],
      }],
    }, "token-1"), ctx);

    expect(response.status).toBe(200);
    expect(updateLineOaResolverRowsFromExtension).toHaveBeenLastCalledWith({ db: true }, {
      token: "token-1",
      runId: "00000000-0000-4000-8000-000000000001",
      rows: [{
        rowId: "00000000-0000-4000-8000-000000000002",
        status: "ambiguous",
        candidates: [{
          lineChatUrl: "https://chat.line.biz/Ueebc1942ed1ed3bd52bb0c6e8d122565/chat/U9fdc5658d0c2cbfc02d0a2acc89fdb6d",
          chatTitle: "Copter mom",
          adminNoteRaw: "mom",
          relationshipRole: "mom",
          candidateRank: 1,
          captureMode: "extension",
          matchMode: "multi_candidate",
          searchCode: "Copter.Th",
        }],
      }],
    });
  });
});

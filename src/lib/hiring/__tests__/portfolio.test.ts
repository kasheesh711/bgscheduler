import { beforeEach, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
const client = vi.hoisted(() => ({ handleUpload: vi.fn() }));
vi.mock("@vercel/blob", () => blob);
vi.mock("@vercel/blob/client", () => client);

import { MAX_PORTFOLIO_BYTES, portfolioPath } from "../model";
import { portfolioUploaded, portfolioUploadHandler, readPortfolio } from "../portfolio";

const id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => vi.clearAllMocks());

it("gives an upload token only for this candidate's own path, for a PDF or a picture of up to 25 MB", async () => {
  client.handleUpload.mockImplementation(async ({ onBeforeGenerateToken }) => onBeforeGenerateToken);
  const before = (await portfolioUploadHandler(new Request("https://app.test"), {} as never, id)) as unknown as (path: string) => Promise<object>;
  expect(await before(portfolioPath(id))).toMatchObject({
    allowedContentTypes: ["application/pdf", "image/jpeg", "image/png"],
    maximumSizeInBytes: MAX_PORTFOLIO_BYTES,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  await expect(before(portfolioPath("22222222-2222-4222-8222-222222222222"))).rejects.toMatchObject({ status: 400 });
  await expect(before(`hiring-signed-contracts/${id}.pdf`)).rejects.toMatchObject({ status: 400 });
});

it("finds only the exact file, and serves an unknown type as plain bytes", async () => {
  blob.list.mockResolvedValue({ blobs: [{ pathname: `${portfolioPath(id)}-other` }] });
  expect(await portfolioUploaded(id)).toBe(false);
  blob.list.mockResolvedValue({ blobs: [{ pathname: portfolioPath(id) }] });
  expect(await portfolioUploaded(id)).toBe(true);
  blob.get.mockResolvedValue(null);
  await expect(readPortfolio(id)).rejects.toMatchObject({ status: 404 });
  blob.get.mockResolvedValue({ statusCode: 200, stream: "bytes", blob: { contentType: "image/png", size: 3 } });
  expect(await readPortfolio(id)).toEqual({ stream: "bytes", size: 3, contentType: "image/png" });
  blob.get.mockResolvedValue({ statusCode: 200, stream: "bytes", blob: { contentType: "text/html", size: 3 } });
  expect((await readPortfolio(id)).contentType).toBe("application/octet-stream");
  expect(blob.get).toHaveBeenCalledWith(portfolioPath(id), expect.objectContaining({ access: "private" }));
});

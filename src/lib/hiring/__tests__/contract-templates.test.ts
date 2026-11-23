import { beforeEach, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({ put: vi.fn(), list: vi.fn(), get: vi.fn() }));
vi.mock("@vercel/blob", () => blob);
vi.mock("../service", () => ({ audit: vi.fn(), candidateById: vi.fn() }));
vi.mock("@vercel/blob/client", () => ({ handleUpload: vi.fn() }));

import type { Database } from "@/lib/db";
import { listContractTemplates, saveContractTemplate } from "../contract-templates";
import { OFFER_LETTERS } from "../offer-letters";
import { audit } from "../service";

const db = {} as Database;
beforeEach(() => vi.clearAllMocks());

it("stores a PDF template in private storage at the fixed path of its type", async () => {
  expect(await saveContractTemplate("specialist", Buffer.from("%PDF-1.7 blank contract"), "hr@example.test", db)).toBe("pdf");
  expect(blob.put).toHaveBeenCalledWith("hiring-contract-templates/specialist.pdf", expect.any(Buffer),
    expect.objectContaining({ access: "private", addRandomSuffix: false, allowOverwrite: true }));
  expect(audit).toHaveBeenCalledWith(db, "hr@example.test", "contract-template-uploaded", null, expect.objectContaining({ type: "specialist", format: "pdf" }));
});

it("refuses a file that is not a PDF or a Word document, and a file that is too large", async () => {
  await expect(saveContractTemplate("part_time", Buffer.from("<html>"), "hr@example.test", db)).rejects.toMatchObject({ status: 400 });
  await expect(saveContractTemplate("part_time", Buffer.alloc(4 * 1024 * 1024 + 1, "%"), "hr@example.test", db)).rejects.toMatchObject({ status: 400 });
  expect(blob.put).not.toHaveBeenCalled();
});

it("lists only the files of a known type and format", async () => {
  blob.list.mockResolvedValue({ blobs: [
    { pathname: "hiring-contract-templates/full_time.docx", size: 10, uploadedAt: new Date("2026-11-24T00:00:00Z") },
    { pathname: "hiring-contract-templates/other.pdf", size: 10, uploadedAt: new Date() },
    { pathname: "hiring-contract-templates/part_time.txt", size: 10, uploadedAt: new Date() },
  ] });
  expect(await listContractTemplates()).toEqual([{ type: "full_time", format: "docx", size: 10, uploadedAt: "2026-11-24T00:00:00.000Z" }]);
});

it("has one standard offer letter for each contract type, with the name and the subject", () => {
  expect(Object.keys(OFFER_LETTERS)).toEqual(["part_time", "full_time", "specialist"]);
  for (const [type, letter] of Object.entries(OFFER_LETTERS))
    expect(letter.text("Nicha", "Physics")).toContain(`Dear Nicha,\n\nWe are pleased to offer you the position of ${type.replace("_", "-")} Physics tutor`);
});

it("gives signed-contract access only for a hired tutor", async () => {
  const { candidateById } = await import("../service");
  const { readSignedContract, signedContractInfo, signedContractPath } = await import("../contract-templates");
  const id = "11111111-1111-4111-8111-111111111111";
  vi.mocked(candidateById).mockResolvedValue({ id, name: "Nicha Suwan / สุวรรณ", stage: "onsite_booked" } as never);
  await expect(signedContractInfo(id, db)).rejects.toMatchObject({ status: 409 });
  await expect(signedContractInfo("../x", db)).rejects.toMatchObject({ status: 400 });
  vi.mocked(candidateById).mockResolvedValue({ id, name: "Nicha Suwan / สุวรรณ", stage: "hired" } as never);
  blob.list.mockResolvedValue({ blobs: [{ pathname: `${signedContractPath(id)}.bak`, uploadedAt: new Date() }] });
  expect(await signedContractInfo(id, db)).toEqual({ uploadedAt: null });
  blob.get.mockResolvedValue({ statusCode: 200, stream: "bytes" });
  expect(await readSignedContract(id, db)).toEqual({ stream: "bytes", name: "BeGifted-signed-contract-Nicha-Suwan.pdf" });
  expect(blob.get).toHaveBeenCalledWith(`hiring-signed-contracts/${id}.pdf`, expect.objectContaining({ access: "private" }));
});

import { get, list, put } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { type Database } from "@/lib/db";
import { HiringError } from "./model";
import { OFFER_LETTERS, type OfferType } from "./offer-letters";
import { sniffResume } from "./resume-files";
import { audit, candidateById } from "./service";

/**
 * The blank contract for each offer type. The files hold pay rates and the repository is public,
 * so they stay in private storage and never in the code.
 */
export const CONTRACT_FORMATS = ["pdf", "docx"] as const;
export type ContractFormat = (typeof CONTRACT_FORMATS)[number];
export const MAX_CONTRACT_BYTES = 4 * 1024 * 1024; // under the 4.5 MB limit of a function request
const FOLDER = "hiring-contract-templates/";
const path = (type: OfferType, format: ContractFormat) => `${FOLDER}${type}.${format}`;
const TYPES: Record<ContractFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export type ContractTemplate = { type: OfferType; format: ContractFormat; size: number; uploadedAt: string };

export async function listContractTemplates(): Promise<ContractTemplate[]> {
  const { blobs } = await list({ prefix: FOLDER });
  return blobs.flatMap((blob) => {
    const match = /^([a-z_]+)\.(pdf|docx)$/.exec(blob.pathname.slice(FOLDER.length));
    return match && match[1] in OFFER_LETTERS
      ? [{ type: match[1] as OfferType, format: match[2] as ContractFormat, size: blob.size, uploadedAt: new Date(blob.uploadedAt).toISOString() }]
      : [];
  });
}

/** Replaces the template of this type and format. The bytes decide the format, not the file name. */
export async function saveContractTemplate(type: OfferType, bytes: Buffer, actor: string, db: Database) {
  if (!bytes.length || bytes.length > MAX_CONTRACT_BYTES) throw new HiringError(400, "Choose a file smaller than 4 MB.");
  const format = sniffResume(bytes)?.extension;
  if (!format) throw new HiringError(400, "Only a PDF or a Word (.docx) file can be used here.");
  await put(path(type, format), bytes, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: TYPES[format] });
  await audit(db, actor, "contract-template-uploaded", null, { type, format, size: bytes.length });
  return format;
}

export async function readContractTemplate(type: OfferType, format: ContractFormat) {
  const blob = await get(path(type, format), { access: "private", useCache: false });
  if (!blob || blob.statusCode !== 200) throw new HiringError(404, "This template is not uploaded yet.");
  return { stream: blob.stream, contentType: TYPES[format], name: `BeGifted-${type.replace("_", "-")}-tutor-agreement-template.${format}` };
}

/** The signed contract of one hired tutor: one PDF scan, replaced by a new upload. */
export const MAX_SIGNED_BYTES = 25 * 1024 * 1024;
export const signedContractPath = (candidateId: string) => `hiring-signed-contracts/${candidateId}.pdf`;

async function hiredCandidate(db: Database, candidateId: string) {
  if (!/^[0-9a-f-]{36}$/.test(candidateId)) throw new HiringError(400, "Invalid candidate.");
  const candidate = await candidateById(db, candidateId);
  if (candidate.stage !== "hired") throw new HiringError(409, "Only a hired tutor has a signed contract.");
  return candidate;
}

/**
 * A short-lived browser token for that one path, because a scan is larger than a function request allows.
 * The audit row records who started the upload.
 */
export function signedContractUploadHandler(request: Request, body: HandleUploadBody, actor: string, db: Database) {
  return handleUpload({
    request,
    body,
    onBeforeGenerateToken: async (pathname, candidateId) => {
      const candidate = await hiredCandidate(db, candidateId ?? "");
      if (pathname !== signedContractPath(candidate.id)) throw new HiringError(400, "Invalid upload.");
      await audit(db, actor, "signed-contract-upload", candidate.id, {});
      return {
        allowedContentTypes: ["application/pdf"],
        maximumSizeInBytes: MAX_SIGNED_BYTES,
        addRandomSuffix: false,
        allowOverwrite: true,
        validUntil: Date.now() + 5 * 60_000,
      };
    },
  });
}

export async function signedContractInfo(candidateId: string, db: Database) {
  const candidate = await hiredCandidate(db, candidateId);
  const { blobs } = await list({ prefix: signedContractPath(candidate.id) });
  const [file] = blobs.filter((blob) => blob.pathname === signedContractPath(candidate.id));
  return { uploadedAt: file ? new Date(file.uploadedAt).toISOString() : null };
}

export async function readSignedContract(candidateId: string, db: Database) {
  const candidate = await hiredCandidate(db, candidateId);
  const blob = await get(signedContractPath(candidate.id), { access: "private", useCache: false });
  if (!blob || blob.statusCode !== 200) throw new HiringError(404, "The signed contract is not uploaded yet.");
  const name = candidate.name.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tutor";
  return { stream: blob.stream, name: `BeGifted-signed-contract-${name}.pdf` };
}

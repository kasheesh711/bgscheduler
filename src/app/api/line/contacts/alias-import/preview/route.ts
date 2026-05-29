import { Buffer } from "node:buffer";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { previewLineAliasImport } from "@/lib/line/contact-aliases";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function nullableFormString(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function imageFromFormData(formData: FormData): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const file = formData.get("image");
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error("Image must be 5MB or smaller");
  }
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new Error("Image must be PNG, JPEG, or WebP");
  }
  return {
    bytes: Buffer.from(await file.arrayBuffer()),
    mimeType: file.type,
  };
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  let image: { bytes: Buffer; mimeType: string } | null;
  try {
    image = await imageFromFormData(formData);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid image" },
      { status: 400 },
    );
  }

  const text = nullableFormString(formData, "text");
  if (!image && !text) {
    return NextResponse.json({ error: "Paste chat-list text or upload a screenshot" }, { status: 400 });
  }

  try {
    const preview = await previewLineAliasImport({
      db: getDb(),
      text,
      image,
      preferredContactId: nullableFormString(formData, "preferredContactId"),
    });
    return NextResponse.json({ preview });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to preview alias import";
    return NextResponse.json({ error: message }, { status: message.includes("configured") ? 503 : 500 });
  }
}

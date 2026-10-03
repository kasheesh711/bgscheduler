"use client";

/** Process one image at a time to bound decoded-image memory on phones. Originals are untouched. */
export async function optimizeWorksheet(file: File): Promise<Blob> {
  if (!["image/jpeg", "image/png"].includes(file.type)) throw new Error("Choose a JPG or PNG photo.");
  if (file.size > 32 * 1024 * 1024) throw new Error("Choose a photo smaller than 32 MB before optimization.");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    if (bitmap.width * bitmap.height > 24_000_000) throw new Error("Choose a photo of at most 24 megapixels.");
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Photo preparation is unavailable. Retry after refreshing.");
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const optimized = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Photo preparation failed.")), "image/jpeg", 0.85));
    canvas.width = canvas.height = 0;
    return scale === 1 && optimized.size >= file.size ? file : optimized;
  } finally { bitmap.close(); }
}

/* Client-side downscale before upload, per spec section 8.

   Two reasons this happens here rather than on the server: the performance
   budget in section 16 puts a downscaled photo under 600 KB, and the upload
   limit is enforced on the stream, so shrinking first is what keeps an ordinary
   phone photo from being refused. */

import { t } from "../i18n/index.ts";

export const LONGEST_EDGE = 2000;
export const JPEG_QUALITY = 0.8;

export interface Downscaled {
  blob: Blob;
  width: number;
  height: number;
  /* Kept so the UI can say what it did, which matters when a photo is refused
     for being too large even after this. */
  originalBytes: number;
}

async function load(file: File): Promise<ImageBitmap> {
  try {
    /* createImageBitmap applies EXIF orientation with this option, which an
       <img> would do automatically and a raw canvas draw would not. A sideways
       grid is not a subtle bug but it is an easy one. */
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(t().photo.notAnImage);
  }
}

export async function downscale(file: File): Promise<Downscaled> {
  const bitmap = await load(file);
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > LONGEST_EDGE ? LONGEST_EDGE / longest : 1;
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t().photo.prepFailed);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!blob) throw new Error(t().photo.encodeFailed);

  return { blob, width, height, originalBytes: file.size };
}

export function kb(bytes: number): string {
  return t().photo.kb(bytes);
}

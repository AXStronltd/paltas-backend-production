// Decode only raster input and re-encode it: uploaded metadata, scripts and original bytes are never served.
import sharp from "sharp";
import { fail } from "../../../http/errors.js";

export async function normalizedPhoto(contentBase64: string): Promise<Buffer> {
  const bytes = Buffer.from(contentBase64, "base64");
  if (!bytes.length || bytes.length > 2 * 1024 * 1024 || bytes.toString("base64") !== contentBase64)
    throw fail.invalid("Choose a photo smaller than 2 MB.");
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (!jpeg && !png && !webp) throw fail.invalid("Choose a JPEG, PNG or WebP photo.");
  let photo: Buffer;
  try {
    photo = await sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning" })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch {
    throw fail.invalid("This photo could not be opened. Choose another JPEG, PNG or WebP image.");
  }
  if (photo.length > 512 * 1024) throw fail.invalid("This photo is too detailed. Choose a smaller image.");
  return photo;
}

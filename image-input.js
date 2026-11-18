export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_SEND_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64 * 1024;

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export function validateImageAttachment(image) {
  if (image == null) return null;
  if (!image || typeof image !== 'object' || typeof image.dataUrl !== 'string') {
    throw requestError(400, 'invalid image attachment');
  }

  // Strict base64 regex: only valid padding is = or == (never === or single = for non-2-char strings)
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(image.dataUrl);
  if (!match || !SUPPORTED_IMAGE_TYPES.has(match[1])) {
    throw requestError(400, 'attach a JPEG, PNG, WebP, or GIF image');
  }

  const b64 = match[2];
  // Strict padding validation: base64 length must be multiple of 4
  if (b64.length % 4 !== 0) {
    throw requestError(400, 'invalid base64 encoding');
  }

  const bytes = Buffer.from(b64, 'base64');
  // Verify round-trip EXACTLY (catches truncated/corrupted data)
  if (bytes.length === 0 || bytes.toString('base64') !== b64) {
    throw requestError(400, 'corrupted image data');
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw requestError(413, 'image exceeds 4 MiB limit');
  }

  return {
    name: typeof image.name === 'string' ? image.name.slice(0, 255) : 'image',
    dataUrl: image.dataUrl,
  };
}

function requestError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
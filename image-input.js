export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_SEND_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64 * 1024;

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export function modelSupportsVision(model) {
  if (!model || typeof model !== 'object') return null;
  const type = typeof model.type === 'string' ? model.type.toLowerCase() : '';
  if (type === 'vlm' || type === 'vision') return true;
  if (type === 'llm' || type === 'text') return false;

  const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
  if (capabilities.some(capability => ['vision', 'image_input', 'vision_input'].includes(capability))) return true;
  return null;
}

export function validateImageAttachment(image) {
  if (image == null) return null;
  if (!image || typeof image !== 'object' || typeof image.dataUrl !== 'string') {
    throw requestError(400, 'invalid image attachment');
  }

  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
  if (!match || !SUPPORTED_IMAGE_TYPES.has(match[1])) {
    throw requestError(400, 'attach a JPEG, PNG, WebP, or GIF image');
  }

  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== match[2]) {
    throw requestError(400, 'invalid image data');
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw requestError(413, 'image is too large (maximum 4 MiB)');
  }

  return {
    name: typeof image.name === 'string' ? image.name.slice(0, 255) : 'image',
    dataUrl: image.dataUrl,
  };
}

export function removeLegacyVisionInstructions(prompt) {
  return String(prompt || '')
    .replace(/\s*You lack vision and cannot process image files \([^)]*\); politely ask for a text description instead and never call read on image files\.?/gi, '')
    .trim();
}

function requestError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

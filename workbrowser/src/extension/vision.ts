import { ImageSchema, type AgentImage } from '../shared/agent';
import type { ScreenshotData } from '../browser-control';

/** Resize only the already masked and labelled image returned by the browser layer. */
export async function prepareImage(shot: ScreenshotData): Promise<AgentImage> {
  const bytes = Uint8Array.from(atob(shot.base64), char => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: shot.mimeType }));
  try {
    let ratio = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 4; attempt++) {
      const width = Math.max(1, Math.round(bitmap.width * ratio));
      const height = Math.max(1, Math.round(bitmap.height * ratio));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The browser cannot prepare a screenshot.');
      context.drawImage(bitmap, 0, 0, width, height);
      const encoded = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })).arrayBuffer());
      let binary = '';
      for (let i = 0; i < encoded.length; i += 0x8000) binary += String.fromCharCode(...encoded.subarray(i, i + 0x8000));
      const base64 = btoa(binary);
      if (base64.length <= 900000) return ImageSchema.parse({ mimeType: 'image/jpeg', base64, width, height });
      ratio *= 0.7;
    }
    throw new Error('The screenshot is too large to send. Try a smaller browser viewport.');
  } finally { bitmap.close(); }
}

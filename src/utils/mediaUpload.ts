// Uploading a picture / video to the business's ad account (server/adMedia.ts) - shared by the new
// campaign builder. Pictures are shrunk in the browser to fit one request (Vercel's 4.5MB limit);
// videos go in 3MB pieces, then we wait for Meta to process them.
const PIECE = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3.3 * 1024 * 1024;

export type UploadedMedia = { type: 'image'; hash: string; thumb: string; name: string } | { type: 'video'; id: string; thumb: string; name: string };

async function fitImage(file: File): Promise<Blob> {
  if (file.size <= MAX_IMAGE_BYTES && /jpe?g|png/i.test(file.type)) return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  for (const q of [0.92, 0.85, 0.75, 0.65, 0.55]) {
    const blob: Blob | null = await new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= MAX_IMAGE_BYTES) return blob;
  }
  throw new Error('התמונה גדולה מדי גם אחרי הקטנה');
}

export async function uploadMedia(file: File, onProgress: (pct: number, stage: 'uploading' | 'processing') => void): Promise<UploadedMedia> {
  if (file.type.startsWith('image/')) {
    onProgress(30, 'uploading');
    const blob = await fitImage(file);
    const name = file.name.replace(/\.\w+$/, '') + (/png$/i.test(blob.type) ? '.png' : '.jpg');
    const d = await fetch(`/api/meta-ads/images?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob }).then(r => r.json());
    if (!d?.success) throw new Error(d?.error || 'העלאת התמונה נכשלה');
    onProgress(100, 'uploading');
    return { type: 'image', hash: d.hash, thumb: d.url || URL.createObjectURL(blob), name: file.name };
  }
  if (!file.type.startsWith('video/')) throw new Error('אפשר להעלות תמונה או סרטון');
  const st = await fetch('/api/meta-ads/videos/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileSize: file.size }) }).then(r => r.json());
  if (!st?.success) throw new Error(st?.error || 'ההעלאה לא התחילה');
  let pos = Number(st.position) || 0;
  while (pos < file.size) {
    const piece = file.slice(pos, Math.min(pos + PIECE, file.size));
    const r = await fetch(`/api/meta-ads/videos/chunk?session=${encodeURIComponent(st.sessionId)}&pos=${pos}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: piece }).then(x => x.json());
    if (!r?.success && r?.position == null) throw new Error(r?.error || 'ההעלאה נכשלה');
    pos = Number(r.position);
    onProgress(Math.round((pos / file.size) * 100), 'uploading');
  }
  const fin = await fetch('/api/meta-ads/videos/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: st.sessionId, title: file.name }) }).then(r => r.json());
  if (!fin?.success) throw new Error(fin?.error || 'סיום ההעלאה נכשל');
  onProgress(100, 'processing');
  for (let i = 0; i < 90; i++) {
    await new Promise(res => setTimeout(res, 5000));
    const s = await fetch(`/api/meta-ads/videos/${fin.videoId}/status`).then(r => r.json()).catch(() => null);
    if (s?.error) throw new Error(s.error);
    if (s?.ready) return { type: 'video', id: fin.videoId, thumb: s.thumb, name: file.name };
  }
  throw new Error('מטא עדיין מעבדת את הסרטון - נסו שוב בעוד כמה דקות');
}

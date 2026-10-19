/** Voice-message recording (hold the mic). */
export function audioMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  return types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
}

/**
 * Starts recording from the microphone.
 * Returns { elapsed(), stop() → Promise<{blob, secs}>, cancel() }. `onLimit` fires after maxSeconds.
 */
export async function startVoice({ maxSeconds = 60, onLimit } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('Voice messages aren’t supported in this browser.');
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { throw new Error('Allow the microphone to record voice messages.'); }
  const mime = audioMime();
  let rec;
  try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {}); }
  catch (e) { stream.getTracks().forEach(t => t.stop()); throw new Error('Couldn’t start recording.'); }
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { rec.onstop = res; });
  const t0 = Date.now();
  rec.start(200);
  const timer = setTimeout(() => onLimit && onLimit(), maxSeconds * 1000);
  const cleanup = () => { clearTimeout(timer); stream.getTracks().forEach(t => t.stop()); };
  return {
    elapsed: () => (Date.now() - t0) / 1000,
    async stop() {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      cleanup();
      const secs = (Date.now() - t0) / 1000;
      return { blob: new Blob(chunks, { type: (rec.mimeType || mime || 'audio/webm').split(';')[0] }), secs };
    },
    cancel() {
      rec.onstop = null;
      try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
      cleanup();
    },
  };
}

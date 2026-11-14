// Camera QR scanner: native BarcodeDetector where available, jsQR otherwise
// (iOS Safari has no BarcodeDetector).

let jsQRPromise = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsQRPromise) {
    jsQRPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/jsQR.js';
      s.async = true;
      s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('jsQR ontbreekt')));
      s.onerror = () => { jsQRPromise = null; reject(new Error('jsQR kon niet laden')); };
      document.head.appendChild(s);
    });
  }
  return jsQRPromise;
}

async function makeDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats?.();
      if (!formats || formats.includes('qr_code')) {
        const det = new window.BarcodeDetector({ formats: ['qr_code'] });
        return { kind: 'native', detect: async (source) => (await det.detect(source)).map((b) => b.rawValue) };
      }
    } catch { /* fall through to jsQR */ }
  }
  const jsQR = await loadJsQR();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    kind: 'jsqr',
    detect: async (video) => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return [];
      // Scan the central square, downscaled: fast enough on older phones.
      const side = Math.min(vw, vh);
      const size = Math.min(side, 720);
      canvas.width = size;
      canvas.height = size;
      ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, size, size);
      const img = ctx.getImageData(0, 0, size, size);
      const hit = jsQR(img.data, size, size, { inversionAttempts: 'attemptBoth' });
      return hit ? [hit.data] : [];
    },
  };
}

export function cameraSupport() {
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'unsupported';
  return 'ok';
}

/**
 * Start scanning into `video`. Calls onResult(text) for every decoded QR.
 * Returns a controller with stop(). Throws an Error with .code on failure:
 * 'insecure' | 'unsupported' | 'denied' | 'nocamera' | 'busy' | 'failed'.
 */
export async function startScanner(video, onResult) {
  const support = cameraSupport();
  if (support !== 'ok') throw Object.assign(new Error(support), { code: support });

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    const name = err && err.name;
    const code = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied'
      : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'nocamera'
        : name === 'NotReadableError' || name === 'AbortError' ? 'busy' : 'failed';
    throw Object.assign(new Error(name || 'camera'), { code });
  }

  let stopped = false;
  const stop = () => {
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };

  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;
  try { await video.play(); } catch { /* some browsers need metadata first */ }

  let detector;
  try {
    detector = await makeDetector();
  } catch (err) {
    stop();
    throw Object.assign(err, { code: 'failed' });
  }

  const loop = async () => {
    if (stopped) return;
    if (video.readyState >= 2) {
      try {
        const results = await detector.detect(video);
        if (!stopped) for (const text of results) onResult(text);
      } catch { /* a single frame failing is fine */ }
    }
    if (!stopped) setTimeout(() => requestAnimationFrame(loop), 120);
  };
  loop();

  return { stop, kind: detector.kind };
}

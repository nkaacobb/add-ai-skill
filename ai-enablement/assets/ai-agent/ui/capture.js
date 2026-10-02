// Screenshots of what the user is looking at, for models that can see images.
//
// Two ways to get the picture, tried in this order:
//   1. The application's own `screenshot` hook: it returns a canvas, image, video frame, ImageBitmap, ImageData, Blob
//      or data URL (or null to decline). Best for canvas/WebGL views, and it needs no permission. A canvas returned
//      synchronously is read in the same task, so a WebGL canvas without preserveDrawingBuffer works when the hook
//      renders a frame and returns the canvas.
//   2. The browser's screen capture (getDisplayMedia), asking for this tab: the real pixels of the page, whatever
//      draws them. The browser asks the user first, and the first request needs a click. While the stream is kept
//      (the agent may look on its own) later screenshots need neither; otherwise it is stopped after each one.
//      Chromium behaviour checked with headless Edge: `preferCurrentTab` captures this tab; asking for the
//      viewport's own size (CSS px × devicePixelRatio) avoids the tab being re-rendered at another scale; a changed
//      page shows up in the stream within a frame or two, a static page produces no new frames.
//
// The result is always a JPEG scaled so its longer edge is at most `maxEdge`, plus a small thumbnail for the chat.

export const CAPTURE_DEFAULTS = Object.freeze({ maxEdge: 1280, quality: 0.82, thumbEdge: 220, maxChars: 2400000 });

export function screenCaptureSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function' && globalThis.isSecureContext !== false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n = 2) => new Promise((resolve) => {
  const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  if (typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') step(n); else setTimeout(resolve, 50);
});
const nextVideoFrame = (video, ms) => Promise.race([
  new Promise((r) => (typeof video.requestVideoFrameCallback === 'function' ? video.requestVideoFrameCallback(() => r(true)) : setTimeout(() => r(false), Math.min(ms, 120)))),
  sleep(ms).then(() => false),
]);

const isInstance = (v, name) => typeof globalThis[name] === 'function' && v instanceof globalThis[name];
const DRAWABLE = ['HTMLCanvasElement', 'OffscreenCanvas', 'ImageBitmap', 'HTMLImageElement', 'HTMLVideoElement', 'SVGImageElement', 'VideoFrame'];
const drawable = (v) => DRAWABLE.some((n) => isInstance(v, n));

function sizeOf(d) {
  return [d.videoWidth || d.naturalWidth || d.displayWidth || d.width || 0, d.videoHeight || d.naturalHeight || d.displayHeight || d.height || 0];
}

/** What a hook returned -> something drawImage accepts (async only for Blobs, URLs and ImageData). */
async function toDrawable(src) {
  if (drawable(src)) return src;
  if (isInstance(src, 'Blob')) return createImageBitmap(src);
  if (isInstance(src, 'ImageData')) {
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d').putImageData(src, 0, 0);
    return c;
  }
  if (typeof src === 'string' && src) {
    const img = new Image();
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('The screenshot image could not be loaded.'));
      img.src = src;
    });
    return img;
  }
  throw new Error('The screenshot hook must return a canvas, an image, a video, an ImageBitmap, ImageData, a Blob or a data URL (or null to use the browser\'s screen capture).');
}

/** Draw a region of `source` onto a new canvas whose longer edge is at most `maxEdge`. JPEG has no alpha: white behind. */
function render(source, { sx = 0, sy = 0, sw, sh, maxEdge }) {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function encode(canvas, o) {
  let url = '';
  try {
    for (const q of [o.quality, 0.6, 0.4]) {
      url = canvas.toDataURL('image/jpeg', q);
      if (url.length <= o.maxChars) break;
    }
  } catch (e) {
    throw new Error(e?.name === 'SecurityError'
      ? 'The screenshot could not be read: it contains images from another site that do not allow it (a "tainted" canvas).'
      : `The screenshot could not be encoded (${e?.message || e}).`);
  }
  const data = url.slice(url.indexOf(',') + 1);
  if (!url.startsWith('data:image/jpeg') || data.length < 16) throw new Error('The screenshot came out empty.');
  const thumb = render(canvas, { sw: canvas.width, sh: canvas.height, maxEdge: o.thumbEdge }).toDataURL('image/jpeg', 0.6);
  return { mime: 'image/jpeg', data, width: canvas.width, height: canvas.height, thumb };
}

let shotSeq = 0;

/**
 * @param {object} o
 * @param {Function|null} o.hook          the app's `screenshot` option
 * @param {() => boolean} [o.keep]        keep the screen stream open after a capture (the agent may look on its own)
 * @param {() => DOMRect|null} [o.drawerRect]  where the open drawer is, to leave it out of a tab capture
 * @param {(hidden: boolean) => void} [o.hideDrawer]  hide/show the drawer when it covers most of the page
 * @param {() => void} [o.onState]        the stream started or stopped
 */
export function createCapture({ hook = null, keep = () => false, drawerRect = () => null, hideDrawer = () => {}, onState = () => {}, maxEdge, quality } = {}) {
  const o = { ...CAPTURE_DEFAULTS };
  if (Number(maxEdge) >= 256) o.maxEdge = Math.min(4096, Math.round(Number(maxEdge)));
  if (Number(quality) > 0 && Number(quality) <= 1) o.quality = Number(quality);
  let stream = null;
  let video = null;
  let busy = null;

  const live = () => !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live');

  function stop() {
    const had = !!stream;
    if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
    if (video) { try { video.pause(); video.srcObject = null; } catch { /* ignore */ } }
    stream = null;
    video = null;
    if (had) onState();
  }

  async function openStream() {
    const dpr = window.devicePixelRatio || 1;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        // The viewport's own pixel size: a larger request makes Chromium re-render the tab at another scale.
        video: { displaySurface: 'browser', width: { ideal: Math.round(window.innerWidth * dpr) }, height: { ideal: Math.round(window.innerHeight * dpr) }, frameRate: { ideal: 10 } },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        monitorTypeSurfaces: 'exclude',
      });
    } catch (e) {
      stream = null;
      if (e?.name === 'NotAllowedError') throw new Error('Screen sharing was not allowed, so no screenshot was taken.');
      if (e?.name === 'InvalidStateError') throw new Error('The browser only shares the screen after a click. Press the camera button to take the screenshot.');
      throw new Error(`The browser could not share the screen (${e?.message || e?.name || e}).`);
    }
    for (const t of stream.getVideoTracks()) t.addEventListener('ended', () => { if (stream && !live()) stop(); });
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try { await video.play(); } catch { /* the frame loop below reports a video that never starts */ }
    for (let i = 0; i < 60 && !(video.videoWidth > 0 && video.readyState >= 2); i++) await sleep(50);
    if (!(video.videoWidth > 0)) { stop(); throw new Error('The shared screen did not produce a picture.'); }
    onState();
  }

  async function fromScreen() {
    if (!live()) await openStream();
    const surface = stream.getVideoTracks()[0]?.getSettings?.().displaySurface;
    const sameShape = () => Math.abs(video.videoWidth / video.videoHeight - window.innerWidth / window.innerHeight) < 0.025;
    // Only a capture of this very tab has the page's own geometry (then the drawer can be left out).
    const thisTab = surface === 'browser' && sameShape();
    const rect = thisTab ? drawerRect() : null;
    const covers = !!rect && rect.width > 0 && rect.left < window.innerWidth * 0.3;
    if (covers) hideDrawer(true);
    try {
      await frames(2);
      await nextVideoFrame(video, 250);
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      let sw = vw;
      if (rect && rect.width > 0 && !covers && thisTab) sw = Math.max(1, Math.round(vw * (rect.left / window.innerWidth)));
      return encode(render(video, { sw, sh: vh, maxEdge: o.maxEdge }), o);
    } finally {
      if (covers) hideDrawer(false);
      if (!keep()) stop();
    }
  }

  async function take(info = {}) {
    if (typeof hook === 'function') {
      let src = hook(info);
      if (src && typeof src.then === 'function') src = await src;
      if (src !== null && src !== undefined && src !== false) {
        // No await between the hook returning a canvas and reading it (see the header).
        const d = drawable(src) ? src : await toDrawable(src);
        const [w, h] = sizeOf(d);
        if (!(w > 0 && h > 0)) throw new Error('The application\'s screenshot is empty (0 × 0).');
        return { ...encode(render(d, { sw: w, sh: h, maxEdge: o.maxEdge }), o), source: 'app' };
      }
    }
    if (!screenCaptureSupported()) throw new Error('This browser cannot take screenshots of the page (screen capture is not available here).');
    return { ...(await fromScreen()), source: 'screen' };
  }

  return {
    /** 'app' (the hook), 'screen' (browser screen capture) or 'none'. With a hook that may decline, 'app' still applies. */
    method: () => (typeof hook === 'function' ? 'app' : screenCaptureSupported() ? 'screen' : 'none'),
    /** True when the next capture has to start from a click (the browser's share prompt). */
    needsGesture: () => typeof hook !== 'function' && !live(),
    live,
    stop,
    /** Take one screenshot: { id, mime, data (base64), width, height, thumb (data URL), source, at }. One at a time. */
    take(info) {
      if (busy) return busy;
      busy = take(info).then((shot) => ({ id: `s${Date.now().toString(36)}${(++shotSeq).toString(36)}`, at: Date.now(), ...shot })).finally(() => { busy = null; });
      return busy;
    },
  };
}

// Showunce tracking worker: runs MediaPipe Pose (lite) and Hand Landmarker off the main thread,
// so the page never waits on the models. Frames arrive as small ImageBitmaps; only landmarks go back.
/* global Vision */
importScripts("/vendor/mediapipe/vision_bundle.js");
const { FilesetResolver, PoseLandmarker, HandLandmarker } = self.Vision;
let pose = null, hands = null, delegate = "GPU", forceCpu = false;

async function make(Cls, path, extra) {
  const files = await FilesetResolver.forVisionTasks("/vendor/mediapipe/wasm");
  const base = { modelAssetPath: path };
  if (forceCpu) { delegate = "CPU"; return Cls.createFromOptions(files, { baseOptions: { ...base, delegate: "CPU" }, runningMode: "VIDEO", ...extra }); }
  try {
    return await Cls.createFromOptions(files, { baseOptions: { ...base, delegate: "GPU" }, canvas: new OffscreenCanvas(1, 1), runningMode: "VIDEO", ...extra });
  } catch (_) {
    delegate = "CPU";
    return await Cls.createFromOptions(files, { baseOptions: { ...base, delegate: "CPU" }, runningMode: "VIDEO", ...extra });
  }
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    forceCpu = !!m.cpu;
    try {
      pose = await make(PoseLandmarker, "/vendor/mediapipe/models/pose_landmarker_lite.task", { numPoses: 1 });
      hands = await make(HandLandmarker, "/vendor/mediapipe/models/hand_landmarker.task", { numHands: 2 });
      self.postMessage({ type: "ready", delegate, handConnections: HandLandmarker.HAND_CONNECTIONS.map((c) => [c.start, c.end]) });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err && err.message || err) });
    }
    return;
  }
  if (m.type === "frame" && pose) {
    const t0 = performance.now();
    let p = null, h = [];
    try {
      const pr = pose.detectForVideo(m.bitmap, m.t);
      const hr = hands.detectForVideo(m.bitmap, m.t);
      p = pr.landmarks && pr.landmarks[0] ? pr.landmarks[0].map((q) => ({ x: q.x, y: q.y, v: q.visibility ?? 1 })) : null;
      h = (hr.landmarks || []).map((hand) => hand.map((q) => ({ x: q.x, y: q.y })));
    } catch (_) { /* skip this frame */ }
    m.bitmap.close();
    self.postMessage({ type: "result", t: m.t, pose: p, hands: h, ms: performance.now() - t0 });
  }
};

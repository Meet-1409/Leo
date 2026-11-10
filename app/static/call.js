// The interview call: lobby checks, the WebRTC call, live transcript, proctoring
// alerts, and the report. Plain JavaScript, with no framework.

const $ = (id) => document.getElementById(id);
const TOKEN = window.LEO_TOKEN;
const API = `/i/${TOKEN}`;

// How often the voice bars update. Showing the speaking video follows OpenAI's audio signals.
const SPEECH_CHECK_MS = 70;

const TRANSCRIPT_WAIT_MS = 4000; // How long ending waits for the last answer's text.
const WRAP_UP_AT_SECONDS = 30; // Tell the AI to finish when this much time is left.
const FORCE_GOODBYE_AT_SECONDS = 15; // If it has not spoken by now, prompt the goodbye.
const INTERRUPT_AFTER_MS = 1500; // Sound must last this long to stop the interviewer.
const STUCK_TURN_MS = 45000; // Longest a single turn can run before the page ends it.
const END_WAIT_MAX_MS = 12000; // Longest wait for the AI's closing sentence to finish.

// Proctoring rules. These run on this device,
// and the video never leaves it. A rule with no limit warns but never ends the call.
const PROCTOR_RULES = {
  no_face: { limit: 5, cooldownMs: 3000, text: "We can't see your face. Stay in front of the camera." },
  multiple_faces: { limit: 3, cooldownMs: 3000, text: "More than one person is in view. You must be alone." },
  // Warns but never ends the call. Reading the transcript was flagged as looking away,
  // so this stays warn-only until real readings from candidates can tune it.
  looking_away: { limit: null, cooldownMs: 30000, text: "Please keep your attention on the interview." },
  forbidden_object: { limit: 3, cooldownMs: 5000, text: "Remove this from view:" },
  tab_switch: { limit: 3, cooldownMs: 3000, text: "Tab switching is not allowed. Stay on this tab." },
  window_blur: { limit: null, cooldownMs: 3000, text: "Stay in the interview window." },
  // Full screen keeps the candidate on the interview.
  fullscreen_exit: { limit: 3, cooldownMs: 3000, text: "You left full screen. Please stay in full screen." },
};
const PROCTOR_GRACE_MS = 5000; // No warnings just after the call starts.
const FACE_CHECK_MS = 400;
const OBJECT_CHECK_MS = 1500;

// Face detection values.
const FACE_CONFIDENCE = 0.75;
const HEAD_POSE_CONFIDENCE = 0.92;
const SAME_FACE_OVERLAP = 0.3; // Boxes overlapping this much count as one face.
const MIN_EYE_DISTANCE = 18;
const POSE_HISTORY = 5; // Readings in the moving median that steadies the head angle.
// Not degrees: these are ratios from the eye and nose points. The limits are wide, so that anywhere on the screen counts as looking at it. The
// transcript is on the candidate's right, so that side is wider still. Up and down are not
// checked: in a real call that reading swung from -59 to +117 with the head facing forward.
const YAW_LIMIT_TO_TRANSCRIPT = 130;
const YAW_LIMIT_OTHER_SIDE = 90;
const LOOKING_AWAY_MS = 6000; // The head must stay turned this long.
const BASELINE_READINGS = 5; // Readings at the start of the call that set "looking ahead".
const POSE_STALE_MS = 1000; // After this long with no reading, restart the timer.
const NO_FACE_MS = 1000; // A brief missed detection is not a violation.
const MULTIPLE_FACES_MS = 1000;

// Object detection values.
const OBJECT_MIN_SCORE = 0.3;
const OBJECT_MIN_AREA = 0.02; // Share of the frame.
const OBJECT_EDGE_MARGIN = 0.1; // The object's centre must not be in this outer band.
const OBJECT_CONFIRM_SCORE = 3; // Repeated sightings needed before a warning.
const OBJECT_MAX_SCORE = 6;
const OBJECT_DECAY = 0.85;
const PHONE_SHAPE_MIN_SCORE = 0.18; // A phone-shaped object can pass with a lower score.
const PHONE_SHAPE_MIN_AREA = 0.005;
const FORBIDDEN_OBJECTS = ["cell phone", "mobile phone", "laptop", "tablet", "book", "remote", "tv", "keyboard", "mouse", "monitor", "screen"];
const PROCTOR_SCRIPTS = [
  "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js",
  "https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface@0.1.0/dist/blazeface.min.umd.js",
  "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js",
];
const END_TEXT = {
  candidate_ended: "You ended the interview.",
  time_up: "The time for this interview is over.",
  server_closed: "The call was ended by the server.",
  connection_lost: "The connection was lost.",
  proctoring: "The interview was ended after repeated proctoring warnings.",
  abuse: "The interviewer ended the call because of abusive language.",
  non_cooperation: "The interviewer ended the call because the candidate did not cooperate.",
  candidate_request: "The interview was ended at your request.",
};

let settings = { interviewer: "Maya", role: "", minutes: 10, language: "English", limit_problem: "" };
let limitSeconds = 600;

// Devices, from the lobby onward.
let localStream = null;
let lobbyAudio = null;
let lobbyMeterTimer = null;
let proctorReady = false;
let faceModel = null;
let objectModel = null;

// The current call. All are null when no call is running.
let peerConnection = null;
let dataChannel = null;
let audioElement = null;
let callId = null;
let countdownTimer = null;
let finishing = false;
let callStartedAt = 0;

// Speaking detection.
let speechContext = null;
let speechTimer = null;
let isSpeaking = false;
let lastSpokeAt = 0;

// What the call produced so far. See resetCallData().
let usage;
let transcriptionSeconds;
let turns;
let wrapUpSent;
let spokeAfterWrapUp;
let responseActive;
let candidateSpeaking;
let endRequest;
let violationCounts;
let proctoringEvents;
let lastWarningAt;
let faceTimer;
let objectTimer;
let noFaceSince;
let manyFacesSince;
let turnedSince;
let yawHistory;
let objectScores;
let yawBaseline;
let baselineYaws;
let lastPoseAt;
let aiAudioPlaying;
let speechStartedAt;
let speechOverAi;
let interruptTimer;
let stuckTurnTimer;
let interrupted;
let replyPending;
let turnsAwaitingText;
let oneMinuteToastShown;

// ---------- Mumbai voice route ----------
// Stands in for the WebRTC connection: the server sends the same events as OpenAI.
const ECHO_TAIL_MS = 300;
let voiceContext = null;
let voiceOutput = null;
let voiceSources = new Set();
let voiceNextAt = 0;

function stopVoicePlayback() {
  voiceSources.forEach((source) => { source.onended = null; try { source.stop(); } catch (error) { /* already stopped */ } });
  voiceSources.clear();
  voiceNextAt = 0;
}

function playVoiceChunk(buffer) {
  const samples = new Int16Array(buffer);
  if (!samples.length) return;
  const audio = voiceContext.createBuffer(1, samples.length, 16000);
  const channel = audio.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 32768;
  const source = voiceContext.createBufferSource();
  source.buffer = audio;
  source.connect(voiceOutput);
  if (!voiceSources.size) handleEvent({ type: "output_audio_buffer.started" });
  const startAt = Math.max(voiceContext.currentTime, voiceNextAt);
  source.start(startAt);
  voiceNextAt = startAt + audio.duration;
  voiceSources.add(source);
  source.onended = () => {
    voiceSources.delete(source);
    if (!voiceSources.size) handleEvent({ type: "output_audio_buffer.stopped" });
  };
}

async function startMumbaiCall() {
  voiceOutput = voiceContext.createMediaStreamDestination();
  playVoice(voiceOutput.stream);
  startSpeechMonitor(voiceOutput.stream);
  await voiceContext.audioWorklet.addModule("/static/pcm-worklet.js");
  const sender = new AudioWorkletNode(voiceContext, "pcm-sender");
  const silent = voiceContext.createGain();
  silent.gain.value = 0;
  voiceContext.createMediaStreamSource(localStream).connect(sender).connect(silent).connect(voiceContext.destination);

  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}${API}/voice`);
  socket.binaryType = "arraybuffer";
  peerConnection = {
    get connectionState() { return socket.readyState === 1 ? "connected" : "closed"; },
    close() { sender.disconnect(); stopVoicePlayback(); socket.close(); if (voiceContext) voiceContext.close(); voiceContext = null; },
  };
  const channel = {
    get readyState() { return socket.readyState === 1 ? "open" : "closed"; },
    send(text) {
      if (JSON.parse(text).type === "output_audio_buffer.clear") {
        stopVoicePlayback();
        handleEvent({ type: "output_audio_buffer.cleared" });
      } else socket.send(text);
    },
  };
  sender.port.onmessage = (event) => {
    if (socket.readyState !== 1) return;
    // Her voice through the speakers must not be heard as the candidate's answer.
    const mayaIsTalking = voiceSources.size > 0 || Date.now() - lastSpokeAt < ECHO_TAIL_MS;
    socket.send(mayaIsTalking ? new ArrayBuffer(event.data.byteLength) : event.data);
  };

  await new Promise((resolve, reject) => {
    socket.onerror = () => reject(new Error("Could not reach the interview server."));
    socket.onclose = () => reject(new Error("The interview service did not answer. No credits were used. Please try again."));
    socket.onmessage = (message) => {
      if (message.data instanceof ArrayBuffer) { playVoiceChunk(message.data); return; }
      const event = JSON.parse(message.data);
      if (event.type === "leo.refused") { reject(new Error(event.error)); return; }
      if (event.type === "leo.ready") {
        callId = event.call_id;
        limitSeconds = event.seconds;
        dataChannel = channel;
        socket.onclose = () => finishCall("connection_lost");
        resolve();
        return;
      }
      handleEvent(event);
    };
  });
  callConnected();
}

function resetCallData() {
  usage = {
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    input_token_details: {
      text_tokens: 0, audio_tokens: 0, cached_tokens: 0,
      cached_tokens_details: { text_tokens: 0, audio_tokens: 0 },
    },
    output_token_details: { text_tokens: 0, audio_tokens: 0 },
  };
  transcriptionSeconds = 0;
  // Turns keyed by item id. A Map keeps the order they were first seen in, so a
  // candidate's text landing late still goes in that candidate's own slot.
  turns = new Map();
  wrapUpSent = false;
  spokeAfterWrapUp = false;
  responseActive = false;
  candidateSpeaking = false;
  endRequest = null;
  violationCounts = {};
  proctoringEvents = [];
  lastWarningAt = {};
  noFaceSince = null;
  manyFacesSince = null;
  turnedSince = null;
  yawHistory = [];
  objectScores = {};
  yawBaseline = null;
  baselineYaws = [];
  lastPoseAt = 0;
  aiAudioPlaying = false;
  speechStartedAt = 0;
  speechOverAi = false;
  clearTimeout(interruptTimer);
  interrupted = false;
  replyPending = false;
  turnsAwaitingText = 0;
  oneMinuteToastShown = false;
}

function showScreen(id) {
  for (const screen of ["lobby", "connecting", "call", "ended"]) $(screen).hidden = screen !== id;
}

// Small helper. It uses textContent, so nothing spoken can run as code.
function add(parent, tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  parent.appendChild(element);
  return element;
}

// ---------- Lobby ----------

function setCheck(id, state, text) {
  const item = $(id);
  item.classList.toggle("ok", state === "ok");
  item.classList.toggle("bad", state === "bad");
  item.querySelector(".check-text").textContent = text;
}

function updateJoinButton() {
  const devicesReady = localStream && localStream.getVideoTracks().length && localStream.getAudioTracks().length;
  $("join").disabled = !(devicesReady && $("consent").checked && !settings.limit_problem);
}

async function loadSettings() {
  try {
    const response = await fetch(`${API}/config`);
    if (response.ok) settings = await response.json();
    else settings.limit_problem = "This interview is not available right now.";
  } catch (error) {
    settings.limit_problem = "Could not reach the interview server.";
  }
  const initial = settings.interviewer.charAt(0);
  $("lobby-role").textContent = settings.role;
  $("call-role").textContent = settings.role;
  limitSeconds = settings.rejoin ? settings.seconds_left : settings.minutes * 60;
  if (settings.rejoin) {
    $("join").textContent = "Rejoin interview";
    $("lobby-details").dataset.rejoin = "1";
  }
  $("lobby-details").textContent = settings.rejoin
    ? `Your call dropped. ${Math.ceil(settings.seconds_left / 60)} minutes left with ${settings.interviewer}`
    : `${settings.minutes} minutes with ${settings.interviewer}, an AI interviewer`;
  $("call-subtitle").textContent = `AI interview with ${settings.interviewer}`;
  $("connecting-name").textContent = settings.interviewer;
  $("connecting-initial").textContent = initial;
  $("avatar-initial").textContent = initial;
  $("interviewer-label").textContent = `${settings.interviewer} · AI interviewer`;
  showLobbyProblem(settings.limit_problem);
  updateJoinButton();
}

function showLobbyProblem(message) {
  $("lobby-problem").textContent = message || "";
  $("lobby-problem").hidden = !message;
}

async function startDevices() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      // Echo cancelling stops the AI's own voice counting as the candidate.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    $("preview").srcObject = localStream;
    $("preview-empty").hidden = true;
    setCheck("check-camera", "ok", "Camera ready");
    setCheck("check-mic", "ok", "Microphone ready. Speak to test it.");
    startMicMeter();
  } catch (error) {
    console.warn("Devices not available:", error.name);
    setCheck("check-camera", "bad", "Camera or microphone blocked");
    setCheck("check-mic", "bad", "Allow both in your browser, then reload");
    $("preview-empty").textContent = "The interview needs your camera and microphone.";
  }
  updateJoinButton();
}

function startMicMeter() {
  lobbyAudio = new AudioContext();
  const analyser = lobbyAudio.createAnalyser();
  analyser.fftSize = 256;
  lobbyAudio.createMediaStreamSource(localStream).connect(analyser);
  const levels = new Uint8Array(analyser.frequencyBinCount);
  lobbyMeterTimer = setInterval(() => {
    analyser.getByteFrequencyData(levels);
    const average = levels.reduce((sum, level) => sum + level, 0) / levels.length;
    $("mic-meter").style.width = `${Math.min(100, average * 2.5)}%`;
  }, 100);
}

function stopMicMeter() {
  clearInterval(lobbyMeterTimer);
  if (lobbyAudio) lobbyAudio.close();
  lobbyAudio = null;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

// Loads the on-device models. If they fail, the call can still run, but the
// tab and full screen checks are then the only proctoring, and the page says so.
async function loadProctoring() {
  setCheck("check-proctor", "", "Proctoring loading");
  try {
    for (const src of PROCTOR_SCRIPTS) await loadScript(src);
    [faceModel, objectModel] = await Promise.all([blazeface.load(), cocoSsd.load()]);
    proctorReady = true;
    setCheck("check-proctor", "ok", "Proctoring ready");
  } catch (error) {
    console.error("Proctoring models failed:", error);
    setCheck("check-proctor", "bad", "Face and phone checks unavailable");
  }
}

// ---------- Toasts and proctoring ----------

function toast(message, kind, ms) {
  const element = add($("toasts"), "div", message, `toast ${kind || ""}`);
  setTimeout(() => element.remove(), ms || 6000);
}

// Records one problem, warns the candidate, and ends the call at that rule's limit.
function violation(type, detail, readings) {
  if (!peerConnection || !callStartedAt || finishing || endRequest) return;
  const rule = PROCTOR_RULES[type];
  const now = Date.now();
  if (now - callStartedAt < PROCTOR_GRACE_MS) return;
  if (now - (lastWarningAt[type] || 0) < rule.cooldownMs) return;
  lastWarningAt[type] = now;

  const event = { type, at_seconds: Math.round((now - callStartedAt) / 1000) };
  if (detail) event.detail = detail;
  if (readings) Object.assign(event, readings); // Kept in the log to tune the limits.
  proctoringEvents.push(event);
  violationCounts[type] = (violationCounts[type] || 0) + 1;
  const count = violationCounts[type];
  const message = detail ? `${rule.text} ${detail}.` : rule.text;

  if (rule.limit && count >= rule.limit) {
    toast("Too many violations. The interview is ending.", "danger", 8000);
    finishCall("proctoring");
    return;
  }
  const warningText = rule.limit ? ` Warning ${count} of ${rule.limit}.` : "";
  toast(message + warningText, rule.limit && count === rule.limit - 1 ? "danger" : "warn", 7000);
  setProctorState("bad", `${proctoringEvents.length} ${proctoringEvents.length === 1 ? "warning" : "warnings"}`);
}

function setProctorState(state, text) {
  $("proctor-state").classList.toggle("ok", state === "ok");
  $("proctor-state").classList.toggle("bad", state === "bad");
  $("proctor-text").textContent = text;
}

function faceProbability(face) {
  return Number(Array.isArray(face.probability) ? face.probability[0] : face.probability);
}

function boxOverlap(a, b) {
  const width = Math.min(a.bottomRight[0], b.bottomRight[0]) - Math.max(a.topLeft[0], b.topLeft[0]);
  const height = Math.min(a.bottomRight[1], b.bottomRight[1]) - Math.max(a.topLeft[1], b.topLeft[1]);
  if (width <= 0 || height <= 0) return 0;
  const area = (box) => (box.bottomRight[0] - box.topLeft[0]) * (box.bottomRight[1] - box.topLeft[1]);
  const shared = width * height;
  return shared / (area(a) + area(b) - shared);
}

// Keeps confident faces, and counts overlapping boxes as one, as glasses can cause a double.
function distinctFaces(detections) {
  const faces = [];
  detections
    .filter((face) => faceProbability(face) >= FACE_CONFIDENCE)
    .sort((a, b) => faceProbability(b) - faceProbability(a))
    .forEach((face) => {
      if (!faces.some((kept) => boxOverlap(kept, face) > SAME_FACE_OVERLAP)) faces.push(face);
    });
  return faces;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Works out head angles from the face's eye, nose and mouth points. Returns null when
// the reading is not reliable.
function headPose(face) {
  if (faceProbability(face) < HEAD_POSE_CONFIDENCE || !face.landmarks) return null;
  const [rightEye, leftEye, nose] = face.landmarks;
  const eyeDistance = Math.hypot(leftEye[0] - rightEye[0], leftEye[1] - rightEye[1]);
  const yaw = ((nose[0] - (rightEye[0] + leftEye[0]) / 2) / (eyeDistance || 1)) * 100;
  if (eyeDistance <= MIN_EYE_DISTANCE || Math.abs(yaw) >= 150) return null;
  yawHistory = [...yawHistory, yaw].slice(-POSE_HISTORY);
  return { yaw: median(yawHistory) };
}

// Applies the face rules to one set of detections.
function checkFaceRules(detections, now) {
  const faces = distinctFaces(detections);

  if (faces.length === 0) {
    if (noFaceSince === null) noFaceSince = now;
    if (now - noFaceSince >= NO_FACE_MS) violation("no_face");
  } else {
    noFaceSince = null;
  }

  if (faces.length > 1) {
    if (manyFacesSince === null) manyFacesSince = now;
    if (now - manyFacesSince >= MULTIPLE_FACES_MS) violation("multiple_faces");
  } else {
    manyFacesSince = null;
  }

  const pose = faces.length === 1 ? headPose(faces[0]) : null;
  if (!pose) return;
  if (now - lastPoseAt > POSE_STALE_MS) turnedSince = null;
  lastPoseAt = now;

  // An off-centre camera shifts the reading, so each person's own "ahead" is measured first.
  if (yawBaseline === null) {
    baselineYaws.push(pose.yaw);
    if (baselineYaws.length >= BASELINE_READINGS) yawBaseline = median(baselineYaws);
    return;
  }
  const yaw = pose.yaw - yawBaseline;
  // The camera image is not mirrored, so turning to your right moves the nose left: negative.
  const turned = yaw < -YAW_LIMIT_TO_TRANSCRIPT || yaw > YAW_LIMIT_OTHER_SIDE;
  if (!turned) turnedSince = null;
  else if (turnedSince === null) turnedSince = now;
  else if (now - turnedSince >= LOOKING_AWAY_MS) {
    violation("looking_away", null, { yaw: Math.round(yaw) });
  }
}

// Which forbidden object this detection counts as, or null. A phone-shaped object with
// a low score still counts as a phone, since phones are often only half visible.
function forbiddenLabel(item, frameWidth, frameHeight) {
  const [x, y, width, height] = item.bbox;
  const area = (width * height) / (frameWidth * frameHeight);
  const centreX = (x + width / 2) / frameWidth;
  const centreY = (y + height / 2) / frameHeight;
  const inFrame = centreX >= OBJECT_EDGE_MARGIN && centreX <= 1 - OBJECT_EDGE_MARGIN
    && centreY >= OBJECT_EDGE_MARGIN && centreY <= 1 - OBJECT_EDGE_MARGIN;
  if (!inFrame) return null;
  if (item.score >= OBJECT_MIN_SCORE && area > OBJECT_MIN_AREA && FORBIDDEN_OBJECTS.includes(item.class)) return item.class;

  const ratio = height ? width / height : 0;
  const phoneShaped = (ratio >= 1.3 && ratio <= 2.5) || (ratio > 0 && 1 / ratio >= 1.3 && 1 / ratio <= 2.5);
  if (phoneShaped && item.score > PHONE_SHAPE_MIN_SCORE && area > PHONE_SHAPE_MIN_AREA && item.class !== "person") return "cell phone";
  return null;
}

// Each sighting raises an object's score and each check lowers it, so one bad frame
// cannot trigger a warning but a steady object does.
function checkObjectRules(detections, frameWidth, frameHeight) {
  const seen = new Set();
  detections.forEach((item) => {
    const label = forbiddenLabel(item, frameWidth, frameHeight);
    if (label) seen.add(label);
  });
  for (const label of Object.keys(objectScores)) objectScores[label] *= OBJECT_DECAY;
  seen.forEach((label) => {
    objectScores[label] = Math.min(OBJECT_MAX_SCORE, (objectScores[label] || 0) + 1);
    if (objectScores[label] > OBJECT_CONFIRM_SCORE) violation("forbidden_object", label);
  });
}

function startProctoring() {
  setProctorState(proctorReady ? "ok" : "bad", proctorReady ? "Proctoring active" : "Face checks unavailable");
  if (!proctorReady) return;
  const video = $("camera");

  async function checkFaces() {
    try {
      if (video.readyState >= 2) checkFaceRules(await faceModel.estimateFaces(video, false), Date.now());
    } catch (error) {
      console.warn("Face check failed:", error.message);
    }
    if (peerConnection && !finishing) faceTimer = setTimeout(checkFaces, FACE_CHECK_MS);
  }
  async function checkObjects() {
    try {
      if (video.readyState >= 2) {
        // Asks for low scores too, for the phone shape rule. The rules then filter them.
        const found = await objectModel.detect(video, 20, PHONE_SHAPE_MIN_SCORE);
        checkObjectRules(found, video.videoWidth, video.videoHeight);
      }
    } catch (error) {
      console.warn("Object check failed:", error.message);
    }
    if (peerConnection && !finishing) objectTimer = setTimeout(checkObjects, OBJECT_CHECK_MS);
  }
  checkFaces();
  checkObjects();
}

function stopProctoring() {
  clearTimeout(faceTimer);
  clearTimeout(objectTimer);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) violation("tab_switch");
});
window.addEventListener("blur", () => {
  if (!document.hidden) violation("window_blur");
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) violation("fullscreen_exit");
});

// ---------- Interviewer video and speaking detection ----------

// If the two interviewer videos are missing, the voice-reactive avatar shows instead.
function hideAgentVideos() {
  $("listening-video").hidden = true;
  $("speaking-video").hidden = true;
}
$("listening-video").addEventListener("error", hideAgentVideos);
$("speaking-video").addEventListener("error", hideAgentVideos);

// Decode one clip at a time. A hidden playing video still consumes resources.
function setSpeaking(speaking) {
  const changed = isSpeaking !== speaking;
  isSpeaking = speaking;
  $("interviewer").classList.toggle("speaking", speaking);
  const active = $(speaking ? "speaking-video" : "listening-video");
  const inactive = $(speaking ? "listening-video" : "speaking-video");
  if (!active.hidden && !finishing) {
    if (speaking && changed) active.currentTime = 0;
    active.play().then(() => {
      if (isSpeaking === speaking) inactive.pause();
    }).catch(() => {});
  }
  updateInterviewerState();
}

function updateInterviewerState() {
  $("interviewer-state").textContent = aiAudioPlaying ? `${settings.interviewer} is speaking`
    : candidateSpeaking ? "Listening to your answer"
    : responseActive || replyPending ? "Preparing the next question"
    : "Take your time — speak when you are ready";
}

// Timings only: no transcript, media, token, or candidate data is logged here.
let replyRequestedAt = null;
let responseAudioMeasured = false;
function markReplyRequested() {
  replyRequestedAt = performance.now();
  responseAudioMeasured = false;
  updateInterviewerState();
}

function drawBars(levels) {
  const bars = $("bars").children;
  for (let i = 0; i < bars.length; i += 1) {
    const level = isSpeaking ? levels[2 + i * 5] / 255 : 0;
    bars[i].style.height = `${5 + level * 31}px`;
  }
}

// Listens to the AI's audio only, never the microphone, and only in this browser.
function startSpeechMonitor(remoteStream) {
  clearInterval(speechTimer);
  if (!speechContext) speechContext = new (window.AudioContext || window.webkitAudioContext)();
  speechContext.resume();
  const analyser = speechContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.5;
  speechContext.createMediaStreamSource(remoteStream).connect(analyser);

  const levels = new Uint8Array(analyser.frequencyBinCount);
  speechTimer = setInterval(() => {
    analyser.getByteFrequencyData(levels);
    drawBars(levels);
    sendPendingReply();
  }, SPEECH_CHECK_MS);
}

function stopSpeechMonitor() {
  clearInterval(speechTimer);
  speechTimer = null;
  if (speechContext) speechContext.close();
  speechContext = null;
  setSpeaking(false);
  drawBars(new Uint8Array(128));
}

// ---------- Maya's voice ----------

// A short sound as a data address, so it can play with no network.
function toneDataUrl(frequency, seconds) {
  const rate = 8000;
  const count = Math.floor(rate * seconds);
  const bytes = new Uint8Array(44 + count);
  const view = new DataView(bytes.buffer);
  const text = (at, value) => [...value].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
  text(0, "RIFF"); view.setUint32(4, 36 + count, true); text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, "data"); view.setUint32(40, count, true);
  for (let i = 0; i < count; i += 1) {
    bytes[44 + i] = frequency ? 128 + 60 * Math.sin((2 * Math.PI * frequency * i) / rate) : 128;
  }
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

// Safari only lets a page play sound if playback started from a click. So this runs
// directly inside the Join click, and the same element later plays Maya's voice.
function unlockAudio() {
  audioElement = $("ai-audio");
  audioElement.muted = false;
  audioElement.srcObject = null;
  audioElement.src = toneDataUrl(0, 0.1);
  audioElement.play().catch((error) => console.warn("Sound not unlocked yet:", error.name));
  if (!speechContext) speechContext = new (window.AudioContext || window.webkitAudioContext)();
  speechContext.resume();
}

function playVoice(stream) {
  audioElement.removeAttribute("src");
  audioElement.srcObject = stream;
  tryPlayingVoice();
}

function tryPlayingVoice() {
  return audioElement.play()
    .then(() => { $("sound-button").hidden = true; })
    .catch((error) => {
      console.warn("Browser blocked the voice:", error.name);
      showSoundButton("Tap to turn on Maya's voice");
    });
}

function showSoundButton(text) {
  $("sound-button").textContent = text;
  $("sound-button").hidden = false;
}

// If she is sending audio but the player is not moving, the browser is blocking it.
function checkAudioIsPlaying() {
  if (!audioElement) return;
  const startedAt = audioElement.currentTime;
  setTimeout(() => {
    if (aiAudioPlaying && (audioElement.paused || audioElement.currentTime === startedAt)) {
      showSoundButton("Tap to turn on Maya's voice");
    }
  }, 1500);
}

function repeatLastQuestion() {
  if (!dataChannel || dataChannel.readyState !== "open" || aiIsTalking() || endRequest) return;
  dataChannel.send(JSON.stringify({
    type: "response.create",
    response: {
      instructions: "The candidate could not hear you. Repeat your last question exactly, and say nothing else.",
      tool_choice: "none",
    },
  }));
}

// Catches a candidate saying they cannot hear her, in English or Hindi. The page shows
// the sound button, as she cannot fix a sound problem herself.
const CANNOT_HEAR = /\b(can'?t|cannot|can not|couldn'?t|unable to|not able to|don'?t|do not)\s+hear\b|\bnot hearing\b|\bno (sound|audio|voice)\b|awaaz nahi|awaz nahi|sunai nahi|आवाज़ नहीं|आवाज नहीं|सुनाई नहीं/i;

function checkForCannotHear(text) {
  if (!CANNOT_HEAR.test(text || "")) return;
  showSoundButton("Can't hear Maya? Check your volume, then tap here");
  toast("Check that your sound is on and your volume is up.", "warn", 7000);
}

$("sound-button").addEventListener("click", () => {
  if (speechContext) speechContext.resume();
  tryPlayingVoice().then(repeatLastQuestion);
  $("sound-button").hidden = true;
});

// Lets the candidate confirm their speakers work, which also unlocks sound in Safari.
$("test-sound").addEventListener("click", () => {
  const speaker = $("ai-audio");
  speaker.srcObject = null;
  speaker.muted = false;
  speaker.src = toneDataUrl(660, 0.8);
  speaker.play()
    .then(() => setCheck("check-sound", "ok", "Did you hear a tone? If not, turn your sound up."))
    .catch(() => setCheck("check-sound", "bad", "Your browser blocked sound. Try again."));
});

// ---------- Live transcript ----------

function turnFor(itemId, speaker) {
  if (!turns.has(itemId)) turns.set(itemId, { speaker, text: null, partial: "", failed: false });
  return turns.get(itemId);
}

function transcriptAtBottom() {
  const box = $("live-transcript");
  return box.scrollHeight - box.scrollTop - box.clientHeight < 40;
}

function renderTranscript() {
  const box = $("live-transcript");
  const follow = transcriptAtBottom(); // Keeps a reader's place if they scrolled up.
  box.replaceChildren();
  for (const turn of turns.values()) {
    const text = turn.failed && !turn.text ? "[not transcribed]" : turn.text ?? turn.partial;
    if (!text) continue;
    const row = add(box, "div", undefined, `turn ${turn.speaker}`);
    add(row, "span", turn.speaker === "interviewer" ? settings.interviewer : "You", "turn-speaker");
    add(row, "span", text);
  }
  if (!box.children.length) add(box, "p", "The conversation will appear here.", "muted");
  if (follow) box.scrollTop = box.scrollHeight;
  $("jump-latest").hidden = follow || transcriptAtBottom();
}

$("live-transcript").addEventListener("scroll", () => {
  $("jump-latest").hidden = transcriptAtBottom();
});
$("jump-latest").addEventListener("click", () => {
  const box = $("live-transcript");
  box.scrollTop = box.scrollHeight;
  $("jump-latest").hidden = true;
});

// The transcript sent to the server. Drops empty noise and unfinished AI turns,
// but keeps a candidate turn with no text, so scoring knows it was not read.
function transcriptForServer() {
  return [...turns.values()]
    .filter((t) => t.text !== "" && (t.text !== null || t.speaker === "candidate"))
    .map((t) => ({ speaker: t.speaker, text: t.text }));
}

// ---------- Events from OpenAI ----------

function addUsage(u) {
  const input = u.input_token_details || {};
  const output = u.output_token_details || {};
  const cached = input.cached_tokens_details || {};
  const total = usage.input_token_details;

  usage.total_tokens += u.total_tokens || 0;
  usage.input_tokens += u.input_tokens || 0;
  usage.output_tokens += u.output_tokens || 0;
  total.text_tokens += input.text_tokens || 0;
  total.audio_tokens += input.audio_tokens || 0;
  total.cached_tokens += input.cached_tokens || 0;
  total.cached_tokens_details.text_tokens += cached.text_tokens || 0;
  total.cached_tokens_details.audio_tokens += cached.audio_tokens || 0;
  usage.output_token_details.text_tokens += output.text_tokens || 0;
  usage.output_token_details.audio_tokens += output.audio_tokens || 0;
}

function handleEvent(event) {
  switch (event.type) {
    case "response.created":
      responseActive = true;
      if (wrapUpSent) spokeAfterWrapUp = true;
      break;

    case "output_audio_buffer.started":
      if (replyRequestedAt !== null && !responseAudioMeasured) {
        console.info("Leo voice timing", { output_buffer_start_ms: Math.round(performance.now() - replyRequestedAt), route: settings.voice_route });
        responseAudioMeasured = true;
      }
      aiAudioPlaying = true;
      setSpeaking(true);
      checkAudioIsPlaying();
      break;

    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared":
      aiAudioPlaying = false;
      setSpeaking(false);
      lastSpokeAt = Date.now();
      sendPendingReply();
      break;

    case "input_audio_buffer.speech_started":
      candidateSpeaking = true;
      $("self").classList.add("speaking");
      onSoundStarted(Date.now());
      break;

    case "input_audio_buffer.speech_stopped":
      candidateSpeaking = false;
      $("self").classList.remove("speaking");
      onSoundStopped(Date.now());
      break;

    case "conversation.item.added":
      // Reserves the turn's place now. Its text arrives in a later event.
      if (event.item.role === "user") turnFor(event.item.id, "candidate");
      if (event.item.role === "assistant") turnFor(event.item.id, "interviewer");
      break;

    case "leo.partial":
      turnFor(event.item_id, "candidate").partial = event.text || "";
      break;

    case "conversation.item.input_audio_transcription.delta":
      turnFor(event.item_id, "candidate").partial += event.delta || "";
      break;

    case "response.output_audio_transcript.delta":
      turnFor(event.item_id, "interviewer").partial += event.delta || "";
      break;

    case "conversation.item.input_audio_transcription.completed":
      turnFor(event.item_id, "candidate").text = event.transcript;
      if (event.usage && event.usage.type === "duration") {
        transcriptionSeconds += event.usage.seconds || 0;
      }
      onTurnText(event.transcript);
      checkForCannotHear(event.transcript);
      break;

    case "conversation.item.input_audio_transcription.failed":
      turnFor(event.item_id, "candidate").failed = true;
      // The words are unknown, so she should reply and ask them to repeat it.
      onTurnText("transcription failed");
      break;

    case "response.output_audio_transcript.done":
      turnFor(event.item_id, "interviewer").text = event.transcript;
      break;

    case "response.done": {
      responseActive = false;
      sendPendingReply();
      if (event.response.usage) addUsage(event.response.usage);
      const output = event.response.output || [];
      // Also covers a turn that was interrupted before its transcript finished.
      let spoke = false;
      for (const item of output) {
        const part = (item.content || []).find((c) => c.transcript);
        if (item.type === "message" && part) {
          turnFor(item.id, "interviewer").text = part.transcript;
          spoke = true;
        }
      }
      const call = output.find((item) => item.type === "function_call" && item.name === "end_interview");
      if (call) requestEnd(call, spoke);
      break;
    }

    case "session.created":
      console.info("Truncation setting:", event.session && event.session.truncation);
      break;

    case "error":
      console.error("OpenAI error:", event.error);
      break;
  }
  updateInterviewerState();
  renderTranscript();
}

// The API cannot tell speech from other sounds, so this page decides what counts.
// The interviewer stops only if a sound lasts, and replies only to a real turn.
// Uses OpenAI's own audio signals. The volume meter lags, so it is only for the visuals.
function aiIsTalking() {
  return aiAudioPlaying || responseActive;
}

function onSoundStarted(now) {
  speechStartedAt = now;
  interrupted = false;
  speechOverAi = aiIsTalking();
  clearTimeout(interruptTimer);
  if (speechOverAi) interruptTimer = setTimeout(interruptAi, INTERRUPT_AFTER_MS);
  // Safety net: if the end of speech is never reported, the interview must not hang.
  clearTimeout(stuckTurnTimer);
  stuckTurnTimer = setTimeout(endStuckTurn, STUCK_TURN_MS);
}

function endStuckTurn() {
  if (!candidateSpeaking || !dataChannel || dataChannel.readyState !== "open") return;
  console.warn("No end of speech reported, so the turn was ended by the page.");
  candidateSpeaking = false;
  $("self").classList.remove("speaking");
  dataChannel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  requestReply();
}

// The sound has lasted long enough to be the candidate speaking, so she stops.
function interruptAi() {
  if (!dataChannel || dataChannel.readyState !== "open" || endRequest) return;
  interrupted = true;
  if (responseActive) dataChannel.send(JSON.stringify({ type: "response.cancel" }));
  if (aiAudioPlaying) dataChannel.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
}

function onSoundStopped(now) {
  clearTimeout(interruptTimer);
  clearTimeout(stuckTurnTimer);
  // A short sound over the interviewer: she carries on as if nothing happened.
  if (speechOverAi && !interrupted && now - speechStartedAt < INTERRUPT_AFTER_MS) return;
  turnsAwaitingText += 1;
}

// She replies only once a turn has been transcribed into real words, whatever its length.
// A breath, a chair or a background sound usually comes back empty, so it gets no reply.
function onTurnText(text) {
  if (turnsAwaitingText === 0) return;
  turnsAwaitingText -= 1;
  if (/\p{L}{2,}/u.test(text || "")) requestReply();
}

function requestReply() {
  replyPending = true;
  updateInterviewerState();
  sendPendingReply();
}

function sendPendingReply() {
  if (!replyPending || aiIsTalking() || candidateSpeaking || endRequest) return;
  if (!dataChannel || dataChannel.readyState !== "open") return;
  replyPending = false;
  markReplyRequested();
  dataChannel.send(JSON.stringify({ type: "response.create" }));
}

// The AI decided to end the call. Stops the candidate's audio, lets the closing
// sentence finish, then ends. Only known reasons are accepted.
function requestEnd(call, spoke) {
  if (endRequest) return;
  let reason = "time_up";
  try {
    const args = JSON.parse(call.arguments || "{}");
    if (["abuse", "non_cooperation", "candidate_request", "time_up"].includes(args.reason)) reason = args.reason;
  } catch (error) {
    console.warn("Could not read the end_interview reason");
  }
  endRequest = { reason, at: Date.now() };
  if (localStream) localStream.getAudioTracks().forEach((track) => { track.enabled = false; });

  // If it called the function without speaking, ask for one closing sentence.
  if (!spoke && dataChannel && dataChannel.readyState === "open") {
    dataChannel.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: "Say one short, neutral closing sentence. Do not say whether the candidate passed.",
        tool_choice: "none",
      },
    }));
  }

  const waiter = setInterval(() => {
    const now = Date.now();
    const quiet = !isSpeaking && !responseActive && now - lastSpokeAt > 1200 && now - endRequest.at > 1500;
    if (quiet || now - endRequest.at > END_WAIT_MAX_MS || !peerConnection) {
      clearInterval(waiter);
      finishCall(reason);
    }
  }, 200);
}

// ---------- Recording ----------

// Records the candidate's camera and microphone for the employer. The interviewer's
// voice isn't included, and the transcript shows what she said.
let recorder = null;
let recordedChunks = [];

function startRecording() {
  if (!window.MediaRecorder || !settings.record || recorder) return;
  const type = ["video/mp4", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) return;
  try {
    recordedChunks = [];
    recorder = new MediaRecorder(localStream, { mimeType: type, videoBitsPerSecond: 400000, audioBitsPerSecond: 48000 });
    recorder.ondataavailable = (event) => { if (event.data && event.data.size) recordedChunks.push(event.data); };
    recorder.start(5000);
  } catch (error) {
    console.warn("Recording is not available:", error.name);
    recorder = null;
  }
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!recorder || recorder.state === "inactive") { resolve(); return; }
    recorder.onstop = resolve;
    recorder.stop();
  });
}

async function uploadRecording() {
  if (!recordedChunks.length || !recorder) return;
  const type = recorder.mimeType.split(";")[0];
  $("ended-status").textContent = "Saving the recording";
  try {
    await fetch(`${API}/recording`, { method: "POST", headers: { "Content-Type": type }, body: new Blob(recordedChunks, { type }) });
  } catch (error) {
    console.warn("The recording could not be saved:", error.message);
  }
}

// ---------- Timer ----------

// The AI has no clock of its own, so this changes its instructions near the end.
function wrapUpIfDue(secondsLeft) {
  if (!dataChannel || dataChannel.readyState !== "open" || endRequest) return;

  if (!wrapUpSent && secondsLeft <= WRAP_UP_AT_SECONDS) {
    wrapUpSent = true;
    dataChannel.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: `You are ${settings.interviewer}, an AI interviewer, and time is nearly up. Speak ${settings.language}. Ask no more questions. Thank the candidate in one short, neutral sentence, without saying whether they passed, then call end_interview with reason "time_up".`,
      },
    }));
  }

  // If the candidate has gone quiet, nothing would trigger the goodbye by itself.
  if (wrapUpSent && !spokeAfterWrapUp && !responseActive && !candidateSpeaking
      && secondsLeft <= FORCE_GOODBYE_AT_SECONDS) {
    spokeAfterWrapUp = true;
    dataChannel.send(JSON.stringify({ type: "response.create" }));
  }
}

function startCountdown() {
  const endsAt = Date.now() + limitSeconds * 1000;

  function tick() {
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    const minutes = String(Math.floor(left / 60)).padStart(2, "0");
    $("timer-text").textContent = `${minutes}:${String(left % 60).padStart(2, "0")}`;
    $("timer").classList.toggle("warning", left <= 60);
    if (left === 60 && !oneMinuteToastShown) {
      oneMinuteToastShown = true;
      toast("One minute left.", "", 4000);
    }
    wrapUpIfDue(left);
    if (left === 0) finishCall("time_up");
  }

  tick();
  countdownTimer = setInterval(tick, 1000);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
}

// ---------- The call ----------

function enterFullscreen() {
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!request) return;
  // Not awaited: Safari may never answer, and that must not hold up the call.
  const result = request.call(root);
  if (result && result.catch) result.catch((error) => console.warn("Full screen not available:", error.message));
}

function callConnected() {
  callStartedAt = Date.now();
  showScreen("call");
  $("camera").srcObject = localStream;
  setSpeaking(false);
  renderTranscript();
  startCountdown();
  startProctoring();
  startRecording();
  toast(settings.rejoin ? "You are back in the interview. The timer kept running." : "You are connected. Answer out loud.", "", 4000);
  // Without this the AI would wait for the candidate to speak first.
  markReplyRequested();
  dataChannel.send(JSON.stringify({ type: "response.create" }));
}

// Puts back what happened before the call dropped, so warnings can't be reset by reloading.
function restoreDroppedCall() {
  if (!settings.rejoin) return;
  limitSeconds = settings.seconds_left;
  (settings.transcript || []).forEach((turn, index) => {
    turns.set(`old-${index}`, { speaker: turn.speaker, text: turn.text, partial: "", failed: !turn.text });
  });
  proctoringEvents = settings.proctoring || [];
  proctoringEvents.forEach((event) => { violationCounts[event.type] = (violationCounts[event.type] || 0) + 1; });
}

async function startCall() {
  // These two must stay first: browsers only allow them directly inside the click.
  unlockAudio();
  enterFullscreen();
  $("join").disabled = true;
  showLobbyProblem("");
  resetCallData();
  restoreDroppedCall();
  stopMicMeter();

  showScreen("connecting");

  try {
    if (settings.voice_route === "mumbai") {
      voiceContext = new AudioContext({ sampleRate: 16000 });
      voiceContext.resume();
      await startMumbaiCall();
      return;
    }
    // 1. Create the peer connection and play the AI's audio when it arrives.
    peerConnection = new RTCPeerConnection();
    peerConnection.ontrack = (event) => {
      playVoice(event.streams[0]);
      startSpeechMonitor(event.streams[0]);
    };
    // "disconnected" can recover on its own, so only "failed" ends the call.
    peerConnection.onconnectionstatechange = () => {
      if (peerConnection && peerConnection.connectionState === "failed") finishCall("connection_lost");
    };

    // 2. Send only the microphone. The camera video stays on this device.
    peerConnection.addTrack(localStream.getAudioTracks()[0]);

    // 3. Open the data channel. Register listeners before creating the offer.
    dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.addEventListener("message", (message) => {
      const event = JSON.parse(message.data);
            handleEvent(event);
    });
    dataChannel.addEventListener("open", callConnected);
    // This closes if the call ends from OpenAI's side, as with the server hangup.
    dataChannel.addEventListener("close", () => finishCall("server_closed"));

    // 4. Exchange SDP through our server, which adds the API key.
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const response = await fetch(`${API}/session`, {
      method: "POST",
      body: offer.sdp,
      headers: { "Content-Type": "application/sdp" },
    });
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(details.error || `Server returned ${response.status}`);
    }

    callId = (response.headers.get("Location") || "").split("/").pop();
    limitSeconds = Number(response.headers.get("X-Time-Limit-Seconds")) || limitSeconds;
        await peerConnection.setRemoteDescription({ type: "answer", sdp: await response.text() });
  } catch (error) {
    console.error(error);
    failBeforeCall(error.message);
  }
}

// The call never started, so nothing was spent and there is nothing to report.
function failBeforeCall(message) {
  finishing = true;
  if (peerConnection) peerConnection.close();
  peerConnection = null;
  dataChannel = null;
  stopDevices();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (audioElement) audioElement.srcObject = null;
  showScreen("ended");
  $("ended-title").textContent = "The interview could not start";
  $("ended-reason").textContent = message;
  $("ended-spinner").hidden = true;
  $("restart").hidden = false;
}

function stopDevices() {
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  $("camera").srcObject = null;
  $("preview").srcObject = null;
}

// Transcription runs after a turn is committed, so the last answer's text can
// land just after the call ends. Waits briefly for it while the channel is open.
async function waitForLastTranscript() {
  const giveUpAt = Date.now() + TRANSCRIPT_WAIT_MS;
  while (Date.now() < giveUpAt && dataChannel && dataChannel.readyState === "open") {
    const waiting = [...turns.values()].some((t) => t.speaker === "candidate" && t.text === null && !t.failed);
    if (!waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Ends the call however it stopped, logs it, and shows the report. Runs only once.
async function finishCall(reason) {
  if (finishing || !peerConnection) return;
  finishing = true;
  $("listening-video").pause();
  $("speaking-video").pause();
  stopCountdown();
  stopProctoring();
  clearTimeout(interruptTimer);
  clearTimeout(stuckTurnTimer);
  replyPending = false;

  showScreen("ended");
  $("ended-title").textContent = "Interview ended";
  $("ended-reason").textContent = END_TEXT[reason] || "";
  $("ended-status").textContent = "Saving your interview";
  $("ended-spinner").hidden = false;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});

  // Stop listening and speaking straight away.
  await stopRecording();
  stopDevices();
  if (audioElement) audioElement.srcObject = null;
  stopSpeechMonitor();

  await waitForLastTranscript();
  peerConnection.close();
  $("ended-status").textContent = "Saving your interview";

  if (callId) await logAndScore(reason);
  else $("ended-status").textContent = "";

  $("ended-spinner").hidden = true;
  $("restart").hidden = false;
  peerConnection = null;
  dataChannel = null;
  audioElement = null;
  callId = null;
}

function usagePayload(reason) {
  return JSON.stringify({
    call_id: callId,
    usage,
    transcription_seconds: transcriptionSeconds,
    transcript: transcriptForServer(),
    end_reason: reason,
    proctoring: proctoringEvents,
  });
}

async function logAndScore(reason) {
  try {
    const response = await fetch(`${API}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: usagePayload(reason),
    });
    const result = await response.json();
    if (!response.ok) {
      $("ended-status").textContent = `The interview was not saved: ${result.error}`;
      return;
    }
    if (result.rejoin) {
      $("ended-title").textContent = "Your call dropped";
      $("ended-reason").textContent = "You have 5 minutes to rejoin. The interview timer keeps running.";
      $("ended-status").textContent = "";
      $("restart").textContent = "Rejoin";
      return;
    }
    if (result.retry) {
      $("ended-title").textContent = "The call did not connect";
      $("ended-reason").textContent = "No credits were used. Please try again.";
      $("ended-status").textContent = "";
      return;
    }
    await uploadRecording();
    location.href = `${API}/done`;
  } catch (error) {
    console.error(error);
    $("ended-status").textContent = `The interview was not saved: ${error.message}`;
  }
}

// If the page closes during a call, still report what happened so the cost is logged.
window.addEventListener("pagehide", () => {
  if (peerConnection && callId && !finishing) {
    navigator.sendBeacon(`${API}/finish`, new Blob([usagePayload("page_closed")], { type: "application/json" }));
  }
});

// ---------- Buttons ----------

$("consent").addEventListener("change", updateJoinButton);
$("join").addEventListener("click", startCall);
$("hangup").addEventListener("click", () => $("confirm-end").showModal());
$("confirm-cancel").addEventListener("click", () => $("confirm-end").close());
$("confirm-yes").addEventListener("click", () => {
  $("confirm-end").close();
  finishCall("candidate_ended");
});
$("mute").addEventListener("click", () => {
  const muted = $("mute").getAttribute("aria-pressed") !== "true";
  $("mute").setAttribute("aria-pressed", String(muted));
  $("mute").setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
  if (localStream) localStream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  if (muted) toast("You are muted. The interviewer can't hear you.", "warn", 4000);
});
$("restart").addEventListener("click", () => location.reload());

resetCallData();
loadSettings();
startDevices();
loadProctoring();

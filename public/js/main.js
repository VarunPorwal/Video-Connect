/* eslint-env browser */
const socket = io();

/* ───────────── query params ───────────── */
const params = new URLSearchParams(location.search);
const roomId = params.get("room");        //  e.g. 1234
const name   = params.get("name");        //  e.g. Varun
const email  = params.get("email");       //  e.g. varun@mail.com

/* ───────────── DOM refs ───────────── */
const localVideo      = document.getElementById("localVideo");
const remoteVideo     = document.getElementById("remoteVideo");
const localNameLabel  = document.getElementById("localName");
const remoteNameLabel = document.getElementById("remoteName");
const endBtn          = document.getElementById("end-call-btn");
const micBtn          = document.getElementById("micBtn");
const camBtn          = document.getElementById("cameraBtn");
const micIcon         = document.getElementById("micIcon");
const camIcon         = document.getElementById("camIcon");
const remoteMicIcon   = document.getElementById("remoteMicIcon");
const remoteCamIcon   = document.getElementById("remoteCamIcon");

/* ───────────── media / rtc ───────────── */
let localStream, peerConnection;
let audioEnabled = true, videoEnabled = true;

/* ───────────── recording ───────────── */
let mediaRecorder, recordedChunks = [];

/* On-screen badge while upload happens */
const badge = document.createElement("div");
badge.textContent = "⏳ Uploading audio…";
badge.style.cssText =
  "position:fixed;top:10px;left:10px;background:#f97316;color:#fff;padding:6px 12px;" +
  "border-radius:6px;font-size:14px;z-index:9999;display:none";
document.body.appendChild(badge);

/* ───────────── helpers ───────────── */
function startRecording() {
  const audioTrack      = localStream.getAudioTracks()[0];
  const recordingStream = new MediaStream([audioTrack]);

  mediaRecorder = new MediaRecorder(recordingStream,
    { mimeType: "audio/webm;codecs=opus" });

  mediaRecorder.ondataavailable = e => e.data.size && recordedChunks.push(e.data);
  mediaRecorder.start(10_000);                       // chunk every 10 s
}

function uploadBlob(blob) {
  if (!blob || !blob.size) return Promise.resolve();
  const fd = new FormData();
  fd.append("audio", blob, `${name}_${roomId}_${Date.now()}.webm`);
  fd.append("roomId", roomId);
  fd.append("userName", name);
  fd.append("email", email);
  return fetch("/upload-audio", { method: "POST", body: fd });
}

function stopRecordingAndUpload() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;

  badge.style.display = "block";
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: "audio/webm" });
    recordedChunks = [];
    uploadBlob(blob).finally(() => (badge.style.display = "none"));
  };
  mediaRecorder.stop();
}

/* Guarantee an upload even if tab/browser closes */
window.addEventListener("beforeunload", () => {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;

  mediaRecorder.stop();
  const blob = new Blob(recordedChunks, { type: "audio/webm" });
  recordedChunks = [];

  const fd = new FormData();
  fd.append("audio", blob, `${name}_${roomId}_${Date.now()}.webm`);
  fd.append("roomId", roomId);
  fd.append("userName", name);
  fd.append("email", email);
  navigator.sendBeacon("/upload-audio", fd);
});

/* ───────────── init camera / mic ───────────── */
async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    localVideo.srcObject = localStream;
    localNameLabel.textContent = `${name} (You)`;
    startRecording();
    socket.emit("join-room", { roomId, userName: name, email });
  } catch {
    alert("Camera & microphone permission are required.");
  }
}

/* Build a fresh RTCPeerConnection */
function createPeerConnection() {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.ontrack = (e) => {
    if (remoteVideo.srcObject !== e.streams[0])
      remoteVideo.srcObject = e.streams[0];
  };
  pc.onicecandidate = (e) =>
    e.candidate && socket.emit("ice-candidate", { candidate: e.candidate, roomId });
  return pc;
}

/* ───────────── socket events ───────────── */
socket.on("room-users-updated", (users) => {
  const me     = users.find((u) => u.socketId === socket.id);
  const remote = users.find((u) => u.socketId !== socket.id);
  if (me) localNameLabel.textContent = `${me.userName} (You)`;
  remoteNameLabel.textContent = remote ? remote.userName : "Waiting for user...";
});

socket.on("user-joined", async ({ userName }) => {
  remoteNameLabel.textContent = userName;
  peerConnection = createPeerConnection();
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit("offer", { offer, roomId });
});

socket.on("offer", async ({ offer }) => {
  peerConnection = createPeerConnection();
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit("answer", { answer, roomId });
});

socket.on("answer", ({ answer }) =>
  peerConnection.setRemoteDescription(new RTCSessionDescription(answer)));

socket.on("ice-candidate", ({ candidate }) =>
  candidate && peerConnection.addIceCandidate(new RTCIceCandidate(candidate)));

socket.on("room-full", () => {
  alert("Room full.");
  location.href = "/";
});

socket.on("call-ended", endCallCleanup);

/* Fires if page closes so fast the 'call-ended' never arrives */
socket.on("disconnect", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    stopRecordingAndUpload();
  }
});

/* Remote UI toggles */
socket.on("remote-mic-toggled", ({ micEnabled }) =>
  remoteMicIcon.classList.toggle("hidden", micEnabled));

socket.on("remote-camera-toggled", ({ camEnabled }) => {
  remoteCamIcon.classList.toggle("hidden", camEnabled);
  remoteVideo.style.opacity = camEnabled ? "1" : "0.1";
});

/* ───────────── buttons ───────────── */
micBtn.addEventListener("click", () => {
  audioEnabled = !audioEnabled;
  localStream.getAudioTracks().forEach((t) => (t.enabled = audioEnabled));
  micIcon.classList.toggle("fa-microphone-slash", !audioEnabled);
  micIcon.classList.toggle("fa-microphone", audioEnabled);
  micIcon.classList.toggle("text-red-600", !audioEnabled);
  socket.emit("toggle-mic", { roomId, micEnabled: audioEnabled });
});

camBtn.addEventListener("click", () => {
  videoEnabled = !videoEnabled;
  localStream.getVideoTracks().forEach((t) => (t.enabled = videoEnabled));
  camIcon.classList.toggle("fa-video-slash", !videoEnabled);
  camIcon.classList.toggle("fa-video", videoEnabled);
  camIcon.classList.toggle("text-red-600", !videoEnabled);
  socket.emit("toggle-camera", { roomId, camEnabled: videoEnabled });
});

endBtn.addEventListener("click", () => {
  socket.emit("end-call", { roomId });
  endCallCleanup();
});

/* ───────────── cleanup ───────────── */
function endCallCleanup() {
  /* ensure upload completes, then leave */
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    stopRecordingAndUpload();
    setTimeout(() => {
      peerConnection?.close();
      localStream?.getTracks().forEach((t) => t.stop());
      location.href = "/";
    }, 2000); // wait 2 s for fetch/beacon
    return;
  }
  /* quick exit when nothing to upload */
  peerConnection?.close();
  localStream?.getTracks().forEach((t) => t.stop());
  location.href = "/";
}

/* ───────────── boot ───────────── */
initMedia();

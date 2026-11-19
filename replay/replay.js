import { cameraName, renderAngles } from "../shared/replay.js";
import { ReplayDeck } from "../shared/replayDeck.js?v=1";
import { deriveKey, decryptFile, readSecret, saveSecret } from "../shared/crypto.js";

const byId = (id) => document.getElementById(id);
const momentsList = byId("momentsList");
const momentsStatus = byId("momentsStatus");
const momentsCount = byId("momentsCount");
const starredOnly = byId("starredOnly");
const anglesEl = byId("angles");
const downloadsEl = byId("downloads");
const grid = byId("grid");
const stageEmpty = byId("stageEmpty");
const playout = byId("playout");
const deckStatus = byId("deckStatus");
const timeline = byId("timeline");
const timecode = byId("timecode");
const deckControls = byId("deckControls");
const playPause = byId("playPause");
const playerError = byId("playerError");
const momentTitle = byId("momentTitle");
const momentMeta = byId("momentMeta");
const starBtn = byId("starBtn");
const noteBtn = byId("noteBtn");
const audioPill = byId("audioPill");
const unlockPanel = byId("unlockPanel");
const unlockForm = byId("unlockForm");
const unlockInput = byId("unlockInput");
const unlockError = byId("unlockError");

const EMPTY_HINT = "Choose a moment to replay it here. Every camera angle plays together on one " +
  "clock, just like the TV review — switch angles, scrub, or jog ±2.5 s.";

let recordings = [];
let signature = "";
let selectedId = null;
let angle = "all";
let deck = null;
let deckKey = "";
let readOnly = false;
let locked = false;
let cryptoKey = null;
let unlockErrorText = "";
const blobUrls = new Map();
let audioEnabled = false;
try { audioEnabled = localStorage.getItem("lol-replay-audio") === "1"; } catch { /* private mode */ }

async function api(path, init) {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Request failed. Try again.");
  }
  return response.json();
}

function showError(error) {
  playerError.textContent = error.message || "Check the connection and try again.";
  playerError.hidden = false;
}

function formatTime(value) {
  const tenths = Math.floor(Math.max(0, value) * 10);
  const minutes = String(Math.floor(tenths / 600)).padStart(2, "0");
  const seconds = String(Math.floor(tenths / 10) % 60).padStart(2, "0");
  return `${minutes}:${seconds}.${tenths % 10}`;
}

function updateTransport(status, position, duration, wantsPlay) {
  if (deckStatus.textContent !== status) deckStatus.textContent = status;
  const label = wantsPlay ? "Pause" : "Play";
  if (playPause.textContent !== label) playPause.textContent = label;
  const canSeek = duration > 0 && status !== "Unavailable";
  timeline.disabled = !canSeek;
  timeline.max = String(duration);
  timeline.value = String(Math.min(position, duration));
  const time = formatTime(position);
  timeline.setAttribute("aria-valuetext", time);
  timecode.textContent = `${time} / ${formatTime(duration)}`;
  for (const button of deckControls.children) {
    const canRetry = button.dataset.action === "restart" && status === "Unavailable";
    button.disabled = !canSeek && !canRetry;
  }
}

function readyClips(recording) {
  return recording.clips.filter((clip) => clip.ready && clip.url);
}

function momentLabel(recording) {
  return new Date(recording.buzzedAt).toLocaleString();
}

function momentMetaText(recording) {
  const angles = readyClips(recording).length;
  const players = recording.players ?? [];
  return [
    recording.challengeTitle,
    `${angles} angle${angles === 1 ? "" : "s"}`,
    players.length && `${players.length} player${players.length === 1 ? "" : "s"} · ${players.map((p) => p.name).join(", ")}`,
    recording.interrupted && "Ended early",
  ].filter(Boolean).join(" · ");
}

function sortedRecordings() {
  // Oldest first so the night can be watched from the start; starred picks stay pinned on top.
  return [...recordings].sort((a, b) =>
    Number(Boolean(b.starred)) - Number(Boolean(a.starred)) || a.buzzedAt - b.buzzedAt);
}

function renderList() {
  const filter = starredOnly.checked;
  const shown = sortedRecordings().filter((recording) => !filter || recording.starred);
  const starred = recordings.filter((recording) => recording.starred).length;
  momentsCount.textContent = recordings.length
    ? `${shown.length}/${recordings.length}${starred ? ` · ${starred} starred` : ""}` : "";
  momentsList.replaceChildren(...shown.map((recording) => {
    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "moment-row";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "moment";
    select.setAttribute("aria-current", String(recording.id === selectedId));
    const title = document.createElement("strong");
    title.textContent = momentLabel(recording);
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = momentMetaText(recording);
    select.append(title, meta);
    if (recording.note) {
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = recording.note;
      select.append(note);
    }
    select.addEventListener("click", () => selectMoment(recording.id));
    const star = document.createElement("button");
    star.type = "button";
    star.className = "star";
    star.hidden = readOnly;
    star.setAttribute("aria-pressed", String(Boolean(recording.starred)));
    star.textContent = recording.starred ? "★" : "☆";
    star.setAttribute("aria-label", `${recording.starred ? "Remove star from" : "Star"} moment from ${momentLabel(recording)}`);
    star.addEventListener("click", () => void toggleStar(recording));
    row.append(select, star);
    item.append(row);
    return item;
  }));
}

function renderDownloads(recording) {
  if (!recording) {
    downloadsEl.hidden = true;
    downloadsEl.replaceChildren();
    return;
  }
  const ready = readyClips(recording);
  downloadsEl.hidden = !ready.length;
  downloadsEl.replaceChildren(...ready.map((clip, index) => {
    const link = document.createElement("a");
    link.className = "download-link";
    const encryptedClip = clip.url.endsWith(".enc");
    link.href = encryptedClip ? "#" : `${clip.url}?download=1`;
    if (!encryptedClip) link.download = "";
    const size = clip.bytes ? ` · ${(clip.bytes / 1048576).toFixed(1)} MB` : "";
    link.textContent = `⬇ ${cameraName(clip.cameraId, index)}${size}`;
    link.setAttribute("aria-label", `Download ${cameraName(clip.cameraId, index)} MP4`);
    if (encryptedClip) {
      // Download the decrypted original, not the ciphertext.
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void decryptToBlobUrl(clip.url).then((blobUrl) => {
          const saver = document.createElement("a");
          saver.href = blobUrl;
          saver.download = clip.url.split("/").pop().replace(/\.enc$/, "");
          saver.click();
        }).catch(showError);
      });
    }
    return link;
  }));
}

function renderHeader(recording) {
  renderDownloads(recording);
  if (!recording) {
    momentTitle.textContent = "Pick a moment";
    momentMeta.textContent = "";
    starBtn.hidden = true;
    noteBtn.hidden = true;
    return;
  }
  momentTitle.textContent = [momentLabel(recording), recording.challengeTitle].filter(Boolean).join(" · ");
  momentMeta.textContent = momentMetaText(recording);
  starBtn.hidden = readOnly;
  starBtn.setAttribute("aria-pressed", String(Boolean(recording.starred)));
  starBtn.textContent = recording.starred ? "★ Starred" : "☆ Star";
  noteBtn.hidden = readOnly;
  noteBtn.textContent = recording.note ? "Edit note" : "Note";
}

function clearPlayer() {
  deck?.destroy();
  deck = null;
  deckKey = "";
  grid.hidden = true;
  playout.hidden = true;
  anglesEl.hidden = true;
  stageEmpty.hidden = false;
  stageEmpty.textContent = EMPTY_HINT;
}

async function decryptToBlobUrl(url) {
  if (blobUrls.has(url)) return blobUrls.get(url);
  if (!cryptoKey) throw new Error("Locked — enter the shared key first.");
  const plain = await decryptFile(cryptoKey, await (await fetch(url)).arrayBuffer());
  const blobUrl = URL.createObjectURL(new Blob([plain], { type: "video/mp4" }));
  blobUrls.set(url, blobUrl);
  return blobUrl;
}

async function playableClips(recording) {
  const clips = [];
  for (const clip of readyClips(recording)) {
    const url = clip.url.endsWith(".enc") ? await decryptToBlobUrl(clip.url) : clip.url;
    clips.push({ ...clip, url });
  }
  return clips;
}

async function buildDeck(recording) {
  const originals = readyClips(recording);
  const key = `${recording.id}:${originals.map((clip) => clip.url).join(",")}`;
  renderAngles(anglesEl, recording.clips, angle);
  anglesEl.hidden = !recording.clips.length;
  if (key === deckKey && deck) {
    deck.selectAngle(angle);
    return;
  }
  const cursor = deck && deckKey.startsWith(`${recording.id}:`) ? deck.cursor() : null;
  deck?.destroy();
  deck = null;
  deckKey = key;
  const ready = await playableClips(recording);
  if (!ready.length) {
    grid.hidden = true;
    playout.hidden = true;
    stageEmpty.hidden = false;
    stageEmpty.textContent = "No playable footage for this moment.";
    return;
  }
  stageEmpty.hidden = true;
  grid.hidden = false;
  playout.hidden = false;
  deck = new ReplayDeck(grid, ready, updateTransport, angle, cursor, {
    enabled: audioEnabled,
    onBlocked: () => setAudioEnabled(false),
  });
}

function selectMoment(id) {
  selectedId = id;
  angle = "all";
  playerError.hidden = true;
  const recording = recordings.find((r) => r.id === id);
  renderList();
  if (!recording) {
    selectedId = null;
    renderHeader(null);
    clearPlayer();
    return;
  }
  renderHeader(recording);
  void buildDeck(recording).catch((error) => { showError(error); updateUnlock(); });
}

function refreshSelection() {
  if (!selectedId) return;
  const recording = recordings.find((r) => r.id === selectedId);
  if (!recording) {
    selectedId = null;
    renderHeader(null);
    clearPlayer();
    renderList();
    return;
  }
  renderHeader(recording);
  void buildDeck(recording).catch((error) => { showError(error); updateUnlock(); });
}

function patchUrl(recording) {
  return `/api/host/recordings/${recording.date}/${encodeURIComponent(recording.id)}`;
}

function applyRecording(updated) {
  const index = recordings.findIndex((r) => r.id === updated.id);
  if (index === -1) recordings.unshift(updated);
  else recordings[index] = updated;
  signature = JSON.stringify(recordings);
  renderList();
  refreshSelection();
}

async function toggleStar(recording) {
  if (readOnly) return;
  playerError.hidden = true;
  try {
    const body = await api(patchUrl(recording), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ starred: !recording.starred }),
    });
    applyRecording(body.recording);
  } catch (error) {
    showError(error);
  }
}

starBtn.addEventListener("click", () => {
  const recording = recordings.find((r) => r.id === selectedId);
  if (recording) void toggleStar(recording);
});

noteBtn.addEventListener("click", async () => {
  const recording = recordings.find((r) => r.id === selectedId);
  if (!recording || readOnly) return;
  const next = window.prompt("Note for this moment (leave empty to clear)", recording.note ?? "");
  if (next === null) return;
  playerError.hidden = true;
  try {
    const body = await api(patchUrl(recording), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: next }),
    });
    applyRecording(body.recording);
  } catch (error) {
    showError(error);
  }
});

starredOnly.addEventListener("change", renderList);

deckControls.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (button) deck?.command(button.dataset.action);
});
timeline.addEventListener("input", () => deck?.scrub(timeline.valueAsNumber));
anglesEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-camera-id]");
  if (!button || button.disabled) return;
  angle = button.dataset.cameraId;
  const recording = recordings.find((r) => r.id === selectedId);
  if (recording) renderAngles(anglesEl, recording.clips, angle);
  deck?.selectAngle(angle);
});
window.addEventListener("keydown", (event) => {
  if (!deck || event.target.closest("button, input, a") || event.altKey || event.ctrlKey || event.metaKey) return;
  const action = { ArrowLeft: "back", ArrowRight: "forward", " ": "toggle" }[event.key];
  if (action) {
    event.preventDefault();
    deck.command(action);
  }
});

function setAudioEnabled(enabled) {
  audioEnabled = enabled;
  try { localStorage.setItem("lol-replay-audio", enabled ? "1" : "0"); } catch { /* private mode */ }
  audioPill.hidden = enabled;
  deck?.setAudioEnabled(enabled);
}
audioPill.addEventListener("click", () => setAudioEnabled(true));
setAudioEnabled(audioEnabled);

let archiveRequest = 0;
async function loadRecordings() {
  try {
    return await api("/api/recordings");
  } catch (error) {
    // Static export (GitHub Pages etc.): no server API. Plain or encrypted manifest.
    const plain = await fetch("recordings.json", { cache: "no-cache" });
    if (plain.ok) {
      readOnly = true;
      return await plain.json();
    }
    const [manifestRes, keyRes] = await Promise.all([
      fetch("recordings.json.enc", { cache: "no-cache" }),
      fetch("keyinfo.json", { cache: "no-cache" }),
    ]);
    if (!manifestRes.ok || !keyRes.ok) throw error;
    const keyinfo = await keyRes.json();
    const secret = readSecret();
    if (!secret) {
      locked = true;
      unlockErrorText = "";
      updateUnlock();
      return { recordings: [] };
    }
    try {
      cryptoKey = await deriveKey(secret, keyinfo);
      const manifest = await decryptFile(cryptoKey, await manifestRes.arrayBuffer());
      readOnly = true;
      locked = false;
      unlockErrorText = "";
      updateUnlock();
      return JSON.parse(new TextDecoder().decode(manifest));
    } catch {
      locked = true;
      unlockErrorText = "That key didn’t decrypt the gallery.";
      updateUnlock();
      return { recordings: [] };
    }
  }
}

function updateUnlock() {
  unlockPanel.hidden = !locked;
  unlockError.hidden = !unlockErrorText;
  unlockError.textContent = unlockErrorText;
}

unlockForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const secret = unlockInput.value.trim();
  if (!secret) return;
  saveSecret(secret);
  unlockInput.value = "";
  locked = false;
  signature = "";
  updateUnlock();
  void refreshRecordings();
});

async function refreshRecordings() {
  const request = ++archiveRequest;
  try {
    const { recordings: list, error } = await loadRecordings();
    if (request !== archiveRequest) return;
    if (locked) {
      momentsStatus.hidden = false;
      momentsStatus.textContent = "Locked — enter the shared key to open the gallery.";
      renderList();
      return;
    }
    if (JSON.stringify(list) === signature) return;
    signature = JSON.stringify(list);
    recordings = list;
    momentsStatus.hidden = false;
    momentsStatus.textContent = error ? "Could not save the latest replay." : recordings.length ? "" : "No saved moments yet. Buzz during a round and the footage lands here automatically.";
    if (!momentsStatus.textContent) momentsStatus.hidden = true;
    renderList();
    refreshSelection();
  } catch {
    if (request !== archiveRequest) return;
    momentsStatus.hidden = false;
    momentsStatus.textContent = "Saved clips unavailable.";
  }
}

async function poll(task, interval) {
  await task();
  window.setTimeout(() => poll(task, interval), interval);
}
void poll(refreshRecordings, 3500);

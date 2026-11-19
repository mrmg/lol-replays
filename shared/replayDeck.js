import { cameraName } from "./replay.js";

const STEP = 2.5;
const MAX_DRIFT = 0.12;
const BUFFER_TIMEOUT = 10_000;

function createTrack(clip, index) {
  const frame = document.createElement("figure");
  frame.className = "camera-frame";
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const name = cameraName(clip.cameraId, index);
  video.setAttribute("aria-label", name);
  const caption = document.createElement("figcaption");
  caption.textContent = name;
  const error = document.createElement("span");
  error.className = "feed-error";
  error.textContent = "No footage yet";
  error.hidden = true;
  frame.append(video, caption, error);
  video.src = clip.url;
  return { cameraId: clip.cameraId, hasAudio: clip.hasAudio, frame, video, error, failed: false, waitingSince: null };
}

// One clock for the whole review. Clips end together, so a shorter camera
// angle begins later on this clock.
export class ReplayDeck {
  constructor(grid, clips, onUpdate, cameraId = "all", cursor = null, audio = {}) {
    this.grid = grid;
    this.onUpdate = onUpdate;
    this.tracks = clips.map(createTrack);
    this.duration = cursor?.duration ?? 0;
    this.position = cursor?.position ?? 0;
    this.wantsPlay = cursor?.wantsPlay ?? true;
    this.audioEnabled = Boolean(audio.enabled);
    this.onAudioBlocked = audio.onBlocked;
    this.running = false;
    this.playing = [];
    this.destroyed = false;
    this.playAttempt = 0;
    grid.replaceChildren(...this.tracks.map((t) => t.frame));
    this.timer = window.setInterval(() => this.sync(), 100);
    this.selectAngle(cameraId);
  }

  get available() {
    return this.tracks.filter((track) => !track.frame.hidden && !track.failed);
  }

  selectAngle(cameraId) {
    if (cameraId === this.cameraId) return;
    const position = this.readPosition();
    this.cameraId = cameraId;
    for (const track of this.tracks) {
      track.frame.hidden = cameraId !== "all" && track.cameraId !== cameraId;
      track.waitingSince = null;
    }
    this.grid.dataset.count = String(this.tracks.filter((t) => !t.frame.hidden).length);
    this.seek(position);
    this.sync();
  }

  cursor() {
    return { position: this.readPosition(), duration: this.duration, wantsPlay: this.wantsPlay };
  }

  setAudioEnabled(enabled) {
    if (enabled === this.audioEnabled) return;
    this.audioEnabled = enabled;
    this.sync();
  }

  routeAudio(tracks) {
    const audible = this.audioEnabled &&
      (tracks.find((t) => t.hasAudio === true) ?? tracks.find((t) => t.hasAudio !== false));
    for (const track of this.tracks) {
      const muted = track !== audible;
      if (track.video.muted !== muted) track.video.muted = muted;
    }
  }

  replayStart() {
    const lengths = this.available.map((t) => t.video.duration).filter(Number.isFinite);
    return lengths.length ? Math.max(0, this.duration - Math.min(...lengths)) : 0;
  }

  fail(track) {
    track.failed = true;
    track.video.muted = true;
    track.video.pause();
    track.video.hidden = true;
    track.error.textContent = "Footage unavailable";
    track.error.hidden = false;
  }

  stopGroup() {
    this.running = false;
    this.playing = [];
    this.playAttempt++;
    for (const { video } of this.tracks) video.pause();
  }

  readPosition() {
    if (!this.running) return this.position;
    const leader = this.playing[0]?.video;
    const time = leader ? (this.duration - leader.duration) + leader.currentTime
      : (performance.now() - this.gapOrigin) / 1000;
    return Math.max(0, Math.min(this.duration, time));
  }

  seek(time) {
    this.stopGroup();
    this.position = Math.max(0, this.duration ? Math.min(time, this.duration) : time);
    this.needsSeek = !this.duration;
    if (!this.duration) return;
    for (const { video } of this.available) {
      if (!Number.isFinite(video.duration)) {
        this.needsSeek = true;
        continue;
      }
      const target = Math.max(0, this.position - (this.duration - video.duration));
      if (Math.abs(video.currentTime - target) > 0.005) video.currentTime = target;
    }
  }

  scrub(time) {
    this.seek(time);
    this.sync();
  }

  command(action) {
    if (!this.available.length) return;
    if (action === "restart") {
      this.wantsPlay = true;
      this.seek(this.replayStart());
    } else if (action === "toggle") {
      this.wantsPlay = !this.wantsPlay;
      const now = this.readPosition();
      this.seek(this.wantsPlay && now >= this.duration ? this.replayStart() : now);
    } else if (action === "back" || action === "forward") {
      this.seek(this.readPosition() + (action === "back" ? -STEP : STEP));
    }
    this.sync();
  }

  startGroup(tracks) {
    this.running = true;
    this.playing = tracks;
    // A late camera has no media clock before its first frame.
    if (!tracks.length) this.gapOrigin = performance.now() - this.position * 1000;
    const attempt = ++this.playAttempt;
    // Issue every play() in the same task, once all decoders can present.
    for (const track of tracks) {
      track.video.play().catch((error) => {
        if (attempt !== this.playAttempt || this.destroyed) return;
        this.position = this.readPosition();
        this.stopGroup();
        if (error.name === "NotAllowedError" && !track.video.muted) {
          this.audioEnabled = false;
          this.onAudioBlocked?.();
        } else if (error.name === "NotAllowedError") this.wantsPlay = false;
        else if (error.name !== "AbortError") this.fail(track);
        this.sync();
      });
    }
  }

  sync() {
    if (this.destroyed) return;
    this.position = this.readPosition();
    const now = performance.now();
    for (const track of this.available) {
      const video = track.video;
      // At the last frame browsers can report HAVE_CURRENT_DATA indefinitely.
      const atEnd = this.duration > 0 && this.position >= this.duration;
      const inRange = this.position >= this.duration - video.duration;
      const waiting = !Number.isFinite(video.duration) || video.duration <= 0 ||
        (inRange && !atEnd && this.wantsPlay && (video.readyState < 3 || video.seeking));
      if (!waiting) track.waitingSince = null;
      else track.waitingSince ??= now;
      if (video.error || (track.waitingSince !== null && now - track.waitingSince > BUFFER_TIMEOUT)) {
        this.fail(track);
      }
    }

    const selected = this.available;
    if (!selected.length) {
      this.routeAudio([]);
      if (this.running) this.stopGroup();
      this.onUpdate("Unavailable", this.position, this.duration, false);
      return;
    }
    if (selected.some(({ video }) => !Number.isFinite(video.duration) || video.duration <= 0)) {
      this.routeAudio([]);
      this.onUpdate("Loading", this.position, this.duration, this.wantsPlay);
      return;
    }
    const lengths = this.tracks.filter((track) => !track.failed).map((t) => t.video.duration).filter(Number.isFinite);
    const duration = Math.max(this.duration, ...lengths);
    if (duration !== this.duration) {
      const previous = this.duration;
      this.duration = duration;
      this.seek(this.position + (previous ? duration - previous : this.replayStart()));
    } else if (this.needsSeek) {
      this.seek(this.position);
    }

    const tracks = selected.filter((track) => {
      const beforeStart = this.position < duration - track.video.duration;
      track.video.hidden = beforeStart;
      track.error.hidden = !beforeStart;
      return !beforeStart;
    });
    this.routeAudio(tracks);
    if (this.position >= duration || this.playing.some(({ video }) => video.ended)) {
      if (this.running || this.wantsPlay) this.seek(duration);
      this.wantsPlay = false;
      this.onUpdate("Ended", duration, duration, false);
      return;
    }

    const groupChanged = this.playing.length !== tracks.length || tracks.some((t, i) => t !== this.playing[i]);
    if (this.running && groupChanged) this.seek(this.position);
    const buffered = tracks.every(({ video }) => video.readyState >= 3 && !video.seeking);
    if (this.running && !buffered) {
      this.seek(this.position);
    } else if (this.running) {
      for (const { video } of tracks.slice(1)) {
        const target = this.position - (duration - video.duration);
        if (Math.abs(video.currentTime - target) > MAX_DRIFT) {
          video.currentTime = target;
        }
      }
    } else if (this.wantsPlay && buffered) {
      this.startGroup(tracks);
    }
    const status = this.running ? "Playing" : this.wantsPlay ? "Buffering" : "Paused";
    this.onUpdate(status, this.position, duration, this.wantsPlay);
  }

  destroy() {
    this.destroyed = true;
    window.clearInterval(this.timer);
    this.stopGroup();
    for (const { video } of this.tracks) {
      video.removeAttribute("src");
      video.load();
    }
    this.grid.replaceChildren();
  }
}

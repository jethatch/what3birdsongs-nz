// Playback: an aviary that plays bird recordings, a scheduler that has it
// sing bar by bar, and two ways to get a song out as a file (render it
// offline, or record it as it plays).
//
// A "bar" here is one turn: one bird singing, or a stop's three birds
// singing together. Everything runs off one repeating tick on a Tone.js
// transport, sixteen to a bar, so that the pace can change at a bar line
// and the playhead can be drawn between them.

const SLOTS = 16;
const TAIL_SECONDS = 1.2; // after the last turn, for the last bird to fade
export const MAX_RENDER_SECONDS = 600;
const RENDER_RATE = 44100;
const CHUNK_SECONDS = 16;
const CHUNK_TAIL_SECONDS = 2;
const LOOKAHEAD_BARS = 6; // recordings fetched ahead of the playhead
const TOGETHER_GAIN = 0.6; // each of three birds singing at once
const TOGETHER_STAGGER = 0.25; // seconds between their entries

export function songSeconds(bars, pace) {
  return bars * pace + TAIL_SECONDS;
}

// ---------------------------------------------------------------------------
// The aviary: recordings, fetched once and shared by every context
// ---------------------------------------------------------------------------

const clips = new Map(); // url -> Promise<AudioBuffer>

export function loadClip(url) {
  if (!clips.has(url)) {
    const loading = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`A recording didn’t load (${response.status}).`);
      return Tone.getContext().decodeAudioData(await response.arrayBuffer());
    })();
    // A failed download shouldn't be remembered as the answer.
    loading.catch(() => clips.delete(url));
    clips.set(url, loading);
  }
  return clips.get(url);
}

// The buffer if it has already arrived, without waiting for it.
const ready = new Map(); // url -> AudioBuffer
function readyClip(url) {
  return ready.get(url) || null;
}
async function settle(url) {
  try {
    ready.set(url, await loadClip(url));
  } catch (error) {
    console.warn(error);
  }
}

export class Aviary {
  // `context` is the Tone context the birds are heard in (an offline one
  // when a song is being rendered to a file).
  constructor(context = Tone.getContext()) {
    this.context = context;
    this.limiter = new Tone.Limiter({ threshold: -1.5, context }).toDestination();
    this.output = new Tone.Gain({ gain: 0.9, context }).connect(this.limiter);
    this.sources = new Set();
  }

  // Resolves once every one of these birds' recordings has arrived or failed.
  async prepare(birds) {
    await Promise.all(birds.map((bird) => settle(bird.clip)));
  }

  // Asks for recordings without waiting for them.
  prefetch(birds) {
    for (const bird of birds) if (!ready.has(bird.clip)) settle(bird.clip);
  }

  // One turn: the birds start at `time` and fade out by `seconds` later.
  // A recording still on its way is left out rather than waited for.
  sing(birds, time, seconds) {
    const together = birds.length > 1;
    birds.forEach((bird, i) => {
      const buffer = readyClip(bird.clip);
      if (!buffer) {
        this.prefetch([bird]);
        return;
      }
      const at = time + (together ? i * TOGETHER_STAGGER : 0);
      const length = Math.min(buffer.duration, seconds - (at - time));
      if (length <= 0.1) return;
      const fade = Math.min(0.4, length / 4);
      const source = new Tone.ToneBufferSource({
        url: buffer, context: this.context, fadeIn: 0.03, fadeOut: fade, curve: "exponential",
      });
      const level = new Tone.Gain({ gain: together ? TOGETHER_GAIN : 1, context: this.context });
      source.chain(level, this.output);
      source.onended = () => {
        this.sources.delete(source);
        // Disposing during an offline render would cut it short.
        if (!this.context.isOffline) {
          source.dispose();
          level.dispose();
        }
      };
      this.sources.add(source);
      source.start(at, 0, length);
    });
  }

  silence() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch (error) {
        // Already stopped.
      }
    }
    this.sources.clear();
  }
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

export class Player {
  // `transport` defaults to the live one; an offline render passes its own.
  constructor(aviary, transport = Tone.getTransport(), offline = false) {
    this.aviary = aviary;
    this.transport = transport;
    this.offline = offline;
    this.state = "stopped"; // "stopped" | "playing" | "paused"
    this.pace = 4.5; // seconds a turn
    this.song = null;
    this.untilBar = Infinity;
    this.marks = [];
    this.onEnd = () => {};
  }

  setPace(seconds) {
    this.pace = seconds;
    this.transport.bpm.value = 240 / seconds;
  }

  // song: { bars, barAt(i) -> { birds, ...anything the caller wants back
  // from position() } }. `bars` may be Infinity.
  async play(song, fromBar = 0) {
    // Ask for the audio context first, while the click that got us here
    // still counts as a user gesture, then wait for the first recordings.
    const unlocked = Tone.start();
    const first = [];
    for (let bar = fromBar; bar < Math.min(song.bars, fromBar + 2); bar++) first.push(...song.barAt(bar).birds);
    await this.aviary.prepare(first);
    await unlocked;
    this.begin(song, fromBar);
    this.transport.start("+0.06");
    this.state = "playing";
  }

  begin(song, fromBar = 0) {
    this.stop();
    this.song = song;
    this.bar = fromBar;
    this.slot = 0;
    this.endingSlots = 0;
    this.slotTicks = this.transport.PPQ / 4;
    this.transport.bpm.value = 240 / this.pace;
    this.transport.scheduleRepeat((time) => this.tick(time), "16n", 0);
  }

  pause() {
    if (this.state !== "playing") return;
    this.transport.pause();
    this.aviary.silence();
    this.state = "paused";
  }

  async resume() {
    if (this.state !== "paused") return;
    // The birds were stopped by the pause; start the interrupted turn again.
    if (this.slot !== 0) this.seek(this.bar);
    await Tone.start();
    this.transport.start();
    this.state = "playing";
  }

  stop() {
    this.transport.stop();
    this.transport.cancel(0);
    this.aviary.silence();
    clearTimeout(this.endTimer);
    this.marks = [];
    this.pendingSeek = null;
    this.atBarLine = null;
    this.state = "stopped";
  }

  // Jump to the top of a bar on the next tick.
  seek(bar) {
    this.pendingSeek = bar;
  }

  // Run `remap(nextBar) -> bar` once, at the next bar line, so the caller
  // can change how bars are counted without cutting a turn short.
  onNextBarLine(remap) {
    this.atBarLine = remap;
  }

  tick(time) {
    const now = Math.round(this.transport.getTicksAtTime(time) / this.slotTicks);
    if (this.pendingSeek != null) {
      // Whatever was singing gives way.
      this.aviary.silence();
      this.bar = this.pendingSeek;
      this.slot = 0;
      this.endingSlots = 0;
      this.pendingSeek = null;
    }
    if (this.endingSlots > 0) {
      if (--this.endingSlots === 0) this.finish(time);
      return;
    }
    if (this.slot === 0) {
      // A chunk of an offline render plays up to its last bar and no further.
      if (this.bar >= this.untilBar) return;
      if (this.atBarLine) {
        this.bar = this.atBarLine(this.bar);
        this.atBarLine = null;
      }
      const info = this.bar < this.song.bars ? this.song.barAt(this.bar) : null;
      if (!info) {
        this.endingSlots = Math.max(1, Math.ceil(TAIL_SECONDS / (this.pace / SLOTS)));
        this.pushMark({ bar: this.song.bars, start: now, slots: this.endingSlots, info: { birds: [] }, ending: true });
        return;
      }
      this.aviary.sing(info.birds, time, this.pace);
      for (let ahead = 1; ahead <= LOOKAHEAD_BARS && this.bar + ahead < this.song.bars; ahead++) {
        this.aviary.prefetch(this.song.barAt(this.bar + ahead).birds);
      }
      this.pushMark({ bar: this.bar, start: now, slots: SLOTS, info });
    }
    if (++this.slot >= SLOTS) {
      this.slot = 0;
      this.bar++;
    }
  }

  pushMark(mark) {
    this.marks.push(mark);
    if (this.marks.length > 8) this.marks.shift();
  }

  finish(time) {
    this.transport.stop(time);
    // An offline render just runs out; nothing is listening for the end.
    if (this.offline) return;
    const delay = Math.max(0, time - this.transport.immediate()) * 1000;
    this.endTimer = setTimeout(() => {
      this.stop();
      this.onEnd();
    }, delay);
  }

  // Where the audible playhead is right now, or null before the first turn.
  position() {
    if (!this.marks.length) return null;
    const slotNow = this.transport.getTicksAtTime(this.transport.immediate()) / this.slotTicks;
    let mark = this.marks[0];
    for (const candidate of this.marks) if (candidate.start <= slotNow) mark = candidate;
    const into = Math.max(0, slotNow - mark.start);
    return {
      bar: mark.bar,
      info: mark.info,
      slot: Math.min(mark.slots - 1, Math.floor(into)),
      slots: mark.slots,
      fraction: Math.min(1, into / mark.slots),
      ending: Boolean(mark.ending),
    };
  }
}

// ---------------------------------------------------------------------------
// Getting a song out as a file
// ---------------------------------------------------------------------------

// 16-bit mono WAV from samples in the range -1..1.
function encodeWav(samples, sampleRate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (offset, string) => [...string].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  // Recordings vary a lot in level; bring the loudest moment of the whole
  // file to just under full scale, up or down.
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const scale = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i] * scale * 32767, true);
  return new Blob([view], { type: "audio/wav" });
}

// Hands control back to the page for a moment. A message channel rather
// than a timer, because browsers slow timers to one a second in a tab that
// isn't in front, and a render shouldn't crawl because of that.
function breathe() {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });
}

// Renders bars [fromBar, untilBar) of a song, plus a tail for the last
// birds to fade, in an offline context of its own.
async function renderChunk(song, pace, fromBar, untilBar, seconds) {
  const live = Tone.getContext();
  const context = new Tone.OfflineContext(2, seconds, RENDER_RATE);
  Tone.setContext(context);
  let rendering;
  try {
    const player = new Player(new Aviary(context), context.transport, true);
    player.pace = pace;
    player.begin(song, fromBar);
    player.untilBar = untilBar;
    context.transport.start(0);
    // Stepping the clock in one go, rather than with the library's pauses,
    // keeps this quick in a tab that isn't in front.
    rendering = context.render(false);
  } finally {
    Tone.setContext(live);
  }
  return (await rendering).get();
}

// Renders a whole song faster than real time and resolves to a WAV Blob.
// onProgress(fraction) is called as it goes: the first tenth for fetching
// recordings, the rest for rendering.
//
// The song is rendered a few bars at a time and the pieces overlapped: one
// long offline context has to carry every sound of the song at once, and
// slows down with the square of its length.
export async function renderSong(song, pace, onProgress = () => {}) {
  const seconds = songSeconds(song.bars, pace) + 0.3;
  if (!(seconds <= MAX_RENDER_SECONDS)) {
    const minutes = Math.round(seconds / 60);
    throw new Error(`This song is about ${minutes} minutes long, and downloads stop at ${MAX_RENDER_SECONDS / 60}. Try “All together” (a third as long), a quicker pace, or a shorter trip.`);
  }
  const birds = [];
  for (let bar = 0; bar < song.bars; bar++) birds.push(...song.barAt(bar).birds);
  await Promise.all(birds.map((bird) => loadClip(bird.clip)));
  for (const bird of birds) ready.set(bird.clip, await loadClip(bird.clip));
  onProgress(0.1);

  const mix = new Float32Array(Math.ceil(seconds * RENDER_RATE));
  const chunkBars = Math.max(1, Math.floor(CHUNK_SECONDS / pace));
  for (let fromBar = 0; fromBar < song.bars; fromBar += chunkBars) {
    const last = fromBar + chunkBars >= song.bars;
    const untilBar = last ? Infinity : fromBar + chunkBars;
    const bars = Math.min(chunkBars, song.bars - fromBar);
    const length = bars * pace + (last ? TAIL_SECONDS + 0.3 : CHUNK_TAIL_SECONDS);
    const chunk = await renderChunk(song, pace, fromBar, untilBar, length);
    const offset = Math.round(fromBar * pace * RENDER_RATE);
    const channels = [];
    for (let c = 0; c < chunk.numberOfChannels; c++) channels.push(chunk.getChannelData(c));
    const count = Math.min(chunk.length, mix.length - offset);
    for (let i = 0; i < count; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      mix[offset + i] += sample / channels.length;
    }
    onProgress(0.1 + 0.9 * Math.min(1, (fromBar + bars) / song.bars));
    await breathe();
  }
  return encodeWav(mix, RENDER_RATE);
}

// Records what the aviary plays, as it plays. The browser picks the format
// (WebM or Ogg in Chrome and Firefox, MP4 in Safari).
export class LiveRecorder {
  static get supported() {
    return Boolean(Tone.Recorder && Tone.Recorder.supported);
  }

  constructor(aviary) {
    this.aviary = aviary;
    this.recorder = new Tone.Recorder();
    aviary.limiter.connect(this.recorder);
  }

  start() {
    return this.recorder.start();
  }

  // Resolves to a Blob.
  async stop() {
    const blob = await this.recorder.stop();
    this.aviary.limiter.disconnect(this.recorder);
    this.recorder.dispose();
    return blob;
  }
}

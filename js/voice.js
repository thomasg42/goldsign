// The ears and mouth for "Read it out loud": the phone's own voice reads, the microphone records an answer,
// and the turn ends after 2 seconds of quiet. Every browser API comes in through `win` and `clock`,
// so tests drive this with a fake microphone and a hand-cranked clock (tests/voice.test.mjs).
//
// Phone traps this is built around (each one cost real time on earlier FGA builds):
// - iPhone ignores continuous speech recognition, so answers are recorded and turned into text by the Worker.
// - iPhone only lets a page talk after a tap, so prime() speaks inside the tap that starts reading.
// - With the microphone open, iPhone plays speech through the quiet earpiece, so the mic is only open while
//   listening and the audio session is switched back to playback before speaking.
// - The level meter can read dead zero on some phones. Then the turn falls back to the "Done talking" button
//   and a time limit instead of hanging forever.

export const QUIET_MS = 2000; // Thomas: a 2 second pause ends an answer
const FRAME_MS = 50;
const DEAD_MS = 1500;

export const isIos = (nav) => /iPad|iPhone|iPod/.test(nav?.userAgent || '') || (nav?.platform === 'MacIntel' && nav?.maxTouchPoints > 1);

// Decides when an answer is over, one level reading at a time. Pure, so it is tested on its own.
// The room's own level ("floor") is the quietest part of the last 1.5 seconds, so steady background noise
// (a fan, traffic, a TV) becomes the new quiet and never counts as talking, while the short gaps between
// words keep the floor down during an answer. startFloor carries the room's level over from the last answer.
export function createTurn({ quietMs = QUIET_MS, noSpeechMs = 8000, maxMs = 30000, startFloor = 0.01 } = {}) {
  const recent = new Array(30).fill(startFloor);
  let floor = startFloor;
  let t0 = null;
  let voiced = 0;
  let started = false;
  let lastVoice = 0;
  let everLive = false;
  let speechMs = 0;
  let peak = 0;
  return {
    get started() {
      return started;
    },
    get speechMs() {
      return speechMs;
    },
    get floor() {
      return floor;
    },
    // Something clearly louder than the room happened, even if it never counted as talking.
    get loudSeen() {
      return peak >= 2;
    },
    push(rms, now) {
      if (t0 === null) t0 = now;
      const elapsed = now - t0;
      if (rms !== 0) everLive = true;
      if (!everLive && elapsed >= DEAD_MS) return 'dead';
      if (elapsed >= maxMs) return 'max';
      recent.shift();
      recent.push(rms);
      floor = [...recent].sort((a, b) => a - b)[3];
      peak = Math.max(peak, rms / Math.max(floor, 0.002));
      const threshold = Math.max(0.012, floor * 2.5 + 0.004);
      const loud = rms > (started ? threshold * 0.6 : threshold);
      if (loud) {
        voiced += 1;
        if (voiced >= 3) {
          if (!started) speechMs += FRAME_MS * 2;
          started = true;
        }
        if (started) {
          lastVoice = now;
          speechMs += FRAME_MS;
        }
      } else voiced = 0;
      if (started && now - lastVoice >= quietMs) return 'quiet';
      if (!started && elapsed >= noSpeechMs) return 'nothing';
      return null;
    },
  };
}

const realClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

function pickMime(MediaRecorder) {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    try {
      if (MediaRecorder.isTypeSupported?.(t)) return t;
    } catch {
      /* try the next one */
    }
  }
  return '';
}

export function createVoice({ win = globalThis, clock = realClock } = {}) {
  const nav = win.navigator || {};
  const synth = win.speechSynthesis || null;
  const ios = isIos(nav);
  let ctx = null;
  let voice = null;
  let rate = 1;
  let speaking = null; // { utter, finish }
  let listening = null; // { finish }
  let heardOnce = false;
  let roomFloor = 0.01; // learned on each answer, so a loud room is only learned once

  const setSession = (type) => {
    try {
      if (nav.audioSession) nav.audioSession.type = type;
    } catch {
      /* older Safari: no audio session control */
    }
  };

  const pickVoice = () => {
    const list = synth?.getVoices?.() || [];
    const en = list.filter((v) => /^en[-_]US/i.test(v.lang));
    const pool = en.length ? en : list.filter((v) => /^en/i.test(v.lang));
    voice = pool.find((v) => /Samantha|Ava|Allison|Google US English|Aria|Jenny|Zira/.test(v.name)) || pool.find((v) => v.localService) || pool[0] || null;
  };

  const newContext = () => {
    const AC = win.AudioContext || win.webkitAudioContext;
    if (!AC) return null;
    try {
      const c = new AC();
      c.resume?.().catch?.(() => {});
      return c;
    } catch {
      return null;
    }
  };

  const api = {
    supported: Boolean(synth && win.SpeechSynthesisUtterance),
    canRecord: Boolean(nav.mediaDevices?.getUserMedia && win.MediaRecorder),
    ios,

    get heardOnce() {
      return heardOnce;
    },

    setRate(r) {
      rate = r;
    },

    // Must run inside the tap that starts reading: unlocks sound and speech for the rest of the visit.
    // With no words it only wakes the sound back up (the "Keep reading" tap).
    prime(firstWords = 'Okay.') {
      if (!ctx) ctx = newContext();
      else ctx.resume?.().catch?.(() => {});
      pickVoice();
      if (synth && !voice) synth.onvoiceschanged = pickVoice;
      return firstWords ? api.speak(firstWords) : Promise.resolve({ ok: true });
    },

    // Asks for the microphone once (the phone shows its Allow prompt), then lets go of it right away.
    async checkMic() {
      if (!api.canRecord) return { ok: false, why: 'unsupported' };
      try {
        const stream = await nav.mediaDevices.getUserMedia({ audio: true });
        for (const tr of stream.getTracks()) tr.stop();
        setSession('playback');
        return { ok: true };
      } catch (e) {
        return { ok: false, why: e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'denied' : 'failed' };
      }
    },

    // Resolves when the phone finishes saying it. { ok: false } means nothing played (muted or blocked).
    speak(text) {
      return new Promise((resolve) => {
        if (!synth || !win.SpeechSynthesisUtterance || !text) {
          resolve({ ok: false });
          return;
        }
        setSession('playback');
        if (!voice) pickVoice();
        const utter = new win.SpeechSynthesisUtterance(text);
        if (voice) utter.voice = voice;
        utter.lang = voice?.lang || 'en-US';
        utter.rate = rate;
        let started = false;
        let done = false;
        const words = String(text).split(/\s+/).length;
        const timers = [];
        const finish = (ok) => {
          if (done) return;
          done = true;
          for (const id of timers) clock.clearTimeout(id);
          if (speaking?.utter === utter) speaking = null;
          resolve({ ok: ok && started });
        };
        utter.onstart = () => {
          started = true;
          heardOnce = true;
        };
        utter.onend = () => {
          started = true;
          finish(true);
        };
        utter.onerror = () => finish(started);
        speaking = { utter, finish };
        // Nothing started in 4 seconds: the phone is muted or blocked speech.
        timers.push(clock.setTimeout(() => !started && finish(false), 4000));
        // Some phones never send "end": stop waiting after about twice as long as the words take.
        timers.push(clock.setTimeout(() => finish(true), Math.max(6000, (words * 420 * 2) / rate + 2000)));
        try {
          if (synth.paused) synth.resume();
          synth.speak(utter);
        } catch {
          finish(false);
        }
      });
    },

    // A short tone that means "talk now". Skipped quietly when sound is not unlocked.
    async beep() {
      if (!ctx || ctx.state !== 'running') {
        await new Promise((r) => clock.setTimeout(r, 150));
        return;
      }
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.18);
      } catch {
        /* no tone, the screen still says "Listening" */
      }
      await new Promise((r) => clock.setTimeout(r, 220));
    },

    // Records one answer. Resolves { blob, reason, heard } where reason is quiet | nothing | max | done | cancelled.
    // onLevel(0..1) feeds the meter; onManual() says the meter is dead and only "Done talking" or the limit ends it.
    async listen({ quietMs = QUIET_MS, noSpeechMs = 8000, maxMs = 30000, onLevel = () => {}, onManual = () => {} } = {}) {
      setSession('play-and-record');
      let stream;
      try {
        stream = await nav.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      } catch (e) {
        setSession('playback');
        return { blob: null, reason: 'nomic', why: e?.name || 'failed' };
      }
      const mime = pickMime(win.MediaRecorder);
      let rec;
      try {
        rec = new win.MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      } catch {
        for (const tr of stream.getTracks()) tr.stop();
        setSession('playback');
        return { blob: null, reason: 'nomic', why: 'recorder' };
      }
      const chunks = [];
      rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
      const stopped = new Promise((r) => {
        rec.onstop = r;
      });
      rec.start(250);

      let source = null;
      let analyser = null;
      let buf = null;
      const attach = () => {
        try {
          source?.disconnect?.();
          if (!ctx || ctx.state === 'closed') ctx = newContext();
          if (!ctx) return;
          ctx.resume?.().catch?.(() => {});
          source = ctx.createMediaStreamSource(stream);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          source.connect(analyser);
          buf = new Float32Array(analyser.fftSize);
        } catch {
          analyser = null;
        }
      };
      attach();

      let turn = createTurn({ quietMs, noSpeechMs, maxMs, startFloor: roomFloor });
      let repaired = false;
      let manual = !analyser;
      if (manual) onManual();
      const t0 = clock.now();
      const reason = await new Promise((resolve) => {
        const end = (why) => {
          clock.clearInterval(timer);
          listening = null;
          resolve(why);
        };
        listening = { finish: end };
        const timer = clock.setInterval(() => {
          const now = clock.now();
          if (manual) {
            onLevel(0);
            if (now - t0 >= maxMs) end('max');
            return;
          }
          let rms = 0;
          try {
            if (analyser.getFloatTimeDomainData) {
              analyser.getFloatTimeDomainData(buf);
              let sum = 0;
              for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
              rms = Math.sqrt(sum / buf.length);
            } else {
              const bytes = new Uint8Array(analyser.fftSize);
              analyser.getByteTimeDomainData(bytes);
              let sum = 0;
              for (const b of bytes) sum += ((b - 128) / 128) ** 2;
              rms = Math.sqrt(sum / bytes.length);
            }
          } catch {
            rms = 0;
          }
          onLevel(Math.min(1, rms * 8));
          const verdict = turn.push(rms, now);
          if (verdict === 'dead') {
            if (!repaired) {
              // Rebuild the sound graph once, newest context after the stream (the order that works on WebKit).
              repaired = true;
              try {
                ctx?.close?.();
              } catch {
                /* already closed */
              }
              ctx = null;
              attach();
              turn = createTurn({ quietMs, noSpeechMs, maxMs: Math.max(1000, maxMs - (now - t0)), startFloor: roomFloor });
              if (!analyser) {
                manual = true;
                onManual();
              }
            } else {
              manual = true;
              onManual();
            }
            return;
          }
          if (verdict) end(verdict);
        }, FRAME_MS);
      });

      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch {
        /* already stopped */
      }
      await Promise.race([stopped, new Promise((r) => clock.setTimeout(r, 1500))]);
      for (const tr of stream.getTracks()) tr.stop();
      try {
        source?.disconnect?.();
      } catch {
        /* gone */
      }
      setSession('playback');
      onLevel(0);
      if (!manual && turn.floor > 0) roomFloor = Math.min(0.05, Math.max(0.002, turn.floor));
      if (reason === 'cancelled') return { blob: null, reason };
      // A quiet voice in a loud room may never count as talking; send it anyway if anything stood out.
      if (reason === 'nothing' && !manual && !turn.loudSeen) return { blob: null, reason };
      const blob = new win.Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
      return { blob: blob.size ? blob : null, reason, heard: turn.started || manual, speechMs: turn.speechMs, manual };
    },

    // For a one-off "Read this to me" tap. Safari drops words spoken in the same moment as a cancel,
    // so only cancel when something is actually playing, then wait a beat.
    sayNow(text) {
      if (!ctx) ctx = newContext();
      if (speaking || synth?.speaking) {
        api.cancel();
        try {
          synth.cancel();
        } catch {
          /* nothing playing */
        }
        return new Promise((r) => clock.setTimeout(r, 120)).then(() => api.speak(text));
      }
      return api.speak(text);
    },

    // The "Done talking" button.
    finishTurn() {
      listening?.finish('done');
    },

    // Stop everything right now: the voice and the microphone.
    cancel() {
      listening?.finish('cancelled');
      if (speaking) {
        const s = speaking;
        speaking = null;
        try {
          synth.cancel();
        } catch {
          /* nothing to cancel */
        }
        s.finish(false);
      }
    },
  };
  return api;
}

// Turns any recording into 16 kHz mono WAV, which every speech-to-text model reads.
// Returns null when this browser cannot decode its own recording; the caller then sends it as is.
export async function toWav16k(blob, win = globalThis) {
  const Off = win.OfflineAudioContext || win.webkitOfflineAudioContext;
  if (!Off) return null;
  try {
    const bytes = await blob.arrayBuffer();
    const off = new Off(1, 16000, 16000);
    const audio = await new Promise((resolve, reject) => {
      const p = off.decodeAudioData(bytes, resolve, reject);
      if (p?.then) p.then(resolve, reject);
    });
    const n = audio.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < audio.numberOfChannels; c += 1) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < n; i += 1) mono[i] += d[i] / audio.numberOfChannels;
    }
    // decodeAudioData resamples to the context rate (16 kHz); guard anyway.
    const rateIn = audio.sampleRate || 16000;
    const step = rateIn / 16000;
    const len = Math.floor(n / step);
    const view = new DataView(new ArrayBuffer(44 + len * 2));
    const str = (o, s) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF');
    view.setUint32(4, 36 + len * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i += 1) {
      const v = Math.max(-1, Math.min(1, mono[Math.floor(i * step)]));
      view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new win.Blob([view.buffer], { type: 'audio/wav' });
  } catch {
    return null;
  }
}

// Blob -> base64 without the "data:...;base64," prefix.
export function blobToBase64(blob, win = globalThis) {
  return new Promise((resolve, reject) => {
    const r = new win.FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

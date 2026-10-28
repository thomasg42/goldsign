// "Read it out loud": reads the whole document from the top, stops at each of the signer's boxes,
// beeps, listens, writes the answer in, says it back, and keeps reading.
// Built for Thomas, who has a reading and writing disability: hearing the fine print is how he knows what it says.
// The page (sign.js) owns the boxes; this file only talks to it through `ops`, so tests can drive it with fakes.

import { h } from './render.js';
import { FIELD_TYPES, formatDate, isImageType } from './shared/fields.js';
import { command, fromSpeech, isNoise, sayBack, sentences, speakable } from './spoken.js';
import { QUIET_MS } from './voice.js';

// Walks the reading view in the order it is shown, so the voice and the screen always agree.
// Each step is { kind: 'say', text, block } or { kind: 'field', n, block }; block = index among #doc's children.
export function buildScript(docEl, { isMine, describeOther = () => '' }) {
  const steps = [];
  [...docEl.children].forEach((block, bi) => {
    let buf = '';
    const flush = () => {
      for (const text of sentences(buf)) steps.push({ kind: 'say', text: speakable(text), block: bi });
      buf = '';
    };
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) {
          buf += c.textContent;
          continue;
        }
        if (c.nodeType !== 1) continue;
        const n = c.getAttribute('data-n');
        if (n !== null) {
          if (isMine(Number(n))) {
            flush();
            steps.push({ kind: 'field', n: Number(n), block: bi });
          } else buf += ` ${describeOther(Number(n), c)} `;
        } else if (c.classList.contains('blank')) buf += ' blank ';
        else if (c.classList.contains('fixed') || c.classList.contains('num')) buf += ` ${c.textContent} `;
        else walk(c);
      }
    };
    walk(block);
    flush();
    // A heading gets its own breath before the next paragraph.
    if (/^H[1-6]$/.test(block.tagName) && steps.length && steps[steps.length - 1].kind === 'say' && !/[.!?:]$/.test(steps[steps.length - 1].text)) {
      steps[steps.length - 1].text += '.';
    }
  });
  return steps;
}

const promptFor = (f) => f.label || FIELD_TYPES[f.type]?.prompt || 'Your answer';

// ops (from the page):
//   field(n), value(f), fill(f, raw) -> { ok, value, error }, panel(f, { typed, prefill }) -> Promise (resolves on close),
//   transcribe(listenResult, f) -> Promise<string>, highlight(step | null), focus(f), today, finishText() -> string,
//   onEnd(), canListen (false = read and pause at each box for typing)
// engine: createVoice() from voice.js
export function createReadAloud({ steps, engine, ops }) {
  let pos = 0;
  let run = 0; // a new run number cancels the old loop
  let state = 'idle';
  let firstBox = true;
  let listenOk = ops.canListen;
  let barEl = null;
  const ui = {};

  // ---------- the bar at the bottom while reading ----------
  function bar() {
    if (barEl?.isConnected) return;
    document.body.classList.add('voice-on');
    ui.status = h('span', { class: 'voice-status', role: 'status', 'aria-live': 'polite' });
    ui.meter = h('span', { class: 'voice-meter', 'aria-hidden': 'true' }, h('span'));
    ui.done = h('button', { class: 'btn primary', type: 'button', onclick: () => engine.finishTurn() }, 'Done talking');
    ui.pause = h('button', { class: 'btn', type: 'button', onclick: () => (state === 'paused' ? api.resume() : api.pause()) }, 'Pause');
    ui.stop = h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Stop reading', onclick: () => api.stop() }, 'Stop');
    barEl = h('div', { class: 'voice-bar' }, h('div', { class: 'voice-info' }, ui.status, ui.meter), ui.done, ui.pause, ui.stop);
    document.body.append(barEl);
  }
  function show(mode, text) {
    bar();
    barEl.dataset.mode = mode;
    ui.status.textContent = text;
    ui.done.hidden = mode !== 'listening';
    ui.meter.hidden = mode !== 'listening';
    ui.pause.hidden = mode === 'listening' || mode === 'waiting';
    ui.pause.textContent = mode === 'paused' ? 'Keep reading' : 'Pause';
    ui.pause.classList.toggle('gold', mode === 'paused');
  }
  const level = (x) => {
    if (ui.meter?.firstChild) ui.meter.firstChild.style.width = `${Math.round(Math.max(0.04, x) * 100)}%`;
  };

  const alive = (id) => id === run && state === 'running';

  async function say(id, text) {
    if (!alive(id)) return false;
    const r = await engine.speak(text);
    if (!r.ok && alive(id) && !engine.heardOnce) {
      // Nothing has ever played: muted phone or blocked sound. Stop here instead of reading to nobody.
      pauseWith("Can't hear me? Turn the volume up. On iPhone, turn off Silent Mode. Then tap Keep reading.");
      return false;
    }
    return alive(id);
  }

  function pauseWith(text) {
    state = 'paused';
    run += 1;
    engine.cancel();
    show('paused', text);
  }

  async function loop(id) {
    while (alive(id) && pos < steps.length) {
      const step = steps[pos];
      ops.highlight(step);
      if (step.kind === 'say') {
        show('reading', 'Reading to you...');
        if (!(await say(id, step.text))) return;
      } else {
        const result = await askField(id, ops.field(step.n));
        if (result === 'paused' || !alive(id)) return;
      }
      if (alive(id)) pos += 1;
    }
    if (!alive(id)) return;
    ops.highlight(null);
    show('reading', 'Done reading.');
    await say(id, `That's the whole document. ${ops.finishText()}`);
    if (alive(id)) api.close();
  }

  // One box. Returns 'paused' when the signer has to type, otherwise moves on.
  async function askField(id, f) {
    const label = promptFor(f);
    if (f.type === 'date' && !f.allowChange) {
      return say(id, `${label}: today, ${formatDate(ops.today)}. Filled in for you.`);
    }
    if (isImageType(f.type)) {
      show('waiting', 'Make your mark, then tap Save.');
      const what = f.type === 'signature' ? 'This is where you sign.' : 'Your initials go here.';
      if (!(await say(id, `${what} Your name is already typed in script. Tap Save to sign with it, or tap Draw to draw it yourself.`))) return;
      await ops.panel(f, { typed: true });
      if (!alive(id)) return;
      const v = ops.value(f);
      return say(id, v?.png ? 'Signed.' : 'Skipped for now. You can sign it before you finish.');
    }
    if (!listenOk && f.type === 'address') {
      show('waiting', 'Type the address, then tap Save.');
      if (!(await say(id, `${label}. Type it in, then tap Save.`))) return;
      await ops.panel(f, {});
      return alive(id);
    }
    if (!listenOk) {
      ops.focus(f);
      if (!(await say(id, `${label}. Type it in, then tap Keep reading.`))) return;
      pauseWith(`Type in "${label}", then tap Keep reading.`);
      return 'paused';
    }
    let tries = 0;
    let lead = true;
    for (;;) {
      const current = ops.value(f);
      const filled = current !== undefined && current !== null && current !== '' && !(f.type === 'checkbox' && current !== true);
      // The first box explains the whole routine once; after that the label is enough.
      const intro = firstBox ? 'Your turn. ' : '';
      const how = firstBox ? ' Talk after the beep. When you stop talking, I write it in.' : '';
      let prompt;
      if (!lead) prompt = '';
      else if (f.type === 'checkbox') prompt = `${intro}${label}. Say yes to tick this box, or no to leave it.${how}`;
      else if (filled) prompt = `${intro}${label}. It says ${sayBack(f, current)}. Say a new answer to change it, or stay quiet to keep it.${how}`;
      else prompt = firstBox ? `${intro}${label}.${how}` : `${label}. After the beep.`;
      if (lead) firstBox = false;
      lead = true;
      ops.focus(f, { keyboard: false });
      if (prompt && !(await say(id, prompt))) return;
      await engine.beep();
      if (!alive(id)) return;
      show('listening', 'Listening. Talk now.');
      const heard = await engine.listen({
        quietMs: QUIET_MS,
        noSpeechMs: filled ? 4500 : 8000,
        maxMs: f.multiline ? 45000 : 30000,
        onLevel: level,
        onManual: () => show('listening', 'Talk, then tap Done talking.'),
      });
      if (!alive(id)) return;
      if (heard.reason === 'nomic') {
        listenOk = false;
        ops.focus(f);
        await say(id, "I can't use the microphone. Type it in, then tap Keep reading.");
        pauseWith(`Type in "${label}", then tap Keep reading.`);
        return 'paused';
      }
      let text = '';
      if (heard.blob) {
        show('working', 'Writing it in...');
        try {
          text = await ops.transcribe(heard, f);
        } catch (e) {
          if (!alive(id)) return;
          if (e?.status === 503 || e?.status === 429) {
            listenOk = false;
            ops.focus(f);
            await say(id, "I can't write down what you say right now. Type it in, then tap Keep reading.");
            pauseWith(`Type in "${label}", then tap Keep reading.`);
            return 'paused';
          }
          text = '';
        }
        if (!alive(id)) return;
      }
      const cmd = command(text);
      if (cmd === 'stop') {
        pauseWith('Paused. Tap Keep reading when you are ready.');
        return 'paused';
      }
      if (cmd === 'skip') return say(id, 'Skipped.');
      if (cmd === 'repeat') continue;
      if (!text || isNoise(text)) {
        if (filled) return say(id, 'Kept it.');
        tries += 1;
        if (tries < 2) {
          if (!(await say(id, "I didn't catch that. Say it again after the beep."))) return;
          lead = false;
          continue;
        }
        return say(id, 'Skipping this one. You can type it in at the end.');
      }
      const raw = fromSpeech(f, text, { today: ops.today });
      if (f.type === 'checkbox') {
        if (raw === null) {
          tries += 1;
          if (tries < 3) {
            if (!(await say(id, 'Say yes or no.'))) return;
            lead = false;
            continue;
          }
          return say(id, 'Left it for now.');
        }
        ops.fill(f, raw);
        return say(id, raw ? 'Ticked.' : 'Left it unticked.');
      }
      const r = ops.fill(f, raw);
      if (r.ok) return say(id, `Got it. ${sayBack(f, r.value)}.`);
      if (f.type === 'address') {
        show('waiting', 'Check the address, then tap Save.');
        if (!(await say(id, `I heard ${text}. ${r.error} Check it on the screen, then tap Save.`))) return;
        await ops.panel(f, { prefill: raw });
        return alive(id);
      }
      tries += 1;
      const why = f.type === 'date' && !raw ? 'Say a date, like November 15th.' : r.error;
      if (tries < 3) {
        if (!(await say(id, `I heard ${f.type === 'email' ? sayBack(f, raw) : text}. ${why} Say it again after the beep.`))) return;
        lead = false;
        continue;
      }
      return say(id, 'I left what I heard in the box. Fix it by typing when we are done.');
    }
  }

  const api = {
    get state() {
      return state;
    },
    get position() {
      return pos;
    },
    // Must be called inside the tap that starts reading (sound unlocks on that tap).
    start(from = 0) {
      pos = Math.max(0, Math.min(from, steps.length));
      state = 'running';
      run += 1;
      show('reading', 'Reading to you...');
      loop(run);
    },
    pause() {
      if (state !== 'running') return;
      pauseWith('Paused. Tap Keep reading when you are ready.');
    },
    resume() {
      if (state !== 'paused') return;
      engine.prime('');
      state = 'running';
      run += 1;
      show('reading', 'Reading to you...');
      loop(run);
    },
    stop() {
      api.close();
    },
    close() {
      state = 'idle';
      run += 1;
      engine.cancel();
      ops.highlight(null);
      barEl?.remove();
      barEl = null;
      document.body.classList.remove('voice-on');
      ops.onEnd(pos);
    },
  };
  return api;
}

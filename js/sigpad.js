// Finger or mouse drawing pad, and typed marks drawn in a script font. Both save as a PNG.

import { h } from './render.js';

export const SCRIPT_FONTS = ['Dancing Script', 'Great Vibes', 'Caveat'];

export function drawPad({ onChange } = {}) {
  const canvas = h('canvas', { 'aria-label': 'Drawing area. Draw your mark with your finger or mouse.' });
  const wrap = h('div', { class: 'sigpad' }, canvas, h('div', { class: 'baseline' }));
  const ctx = canvas.getContext('2d');
  let strokes = [];
  let current = null;

  const size = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    redraw();
  };

  const redraw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0b1a44';
    for (const s of strokes) {
      if (s.length === 1) {
        ctx.beginPath();
        ctx.arc(s[0].x, s[0].y, 1.4, 0, Math.PI * 2);
        ctx.fillStyle = '#0b1a44';
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(s[0].x, s[0].y);
      for (let i = 1; i < s.length - 1; i += 1) {
        const mx = (s[i].x + s[i + 1].x) / 2;
        const my = (s[i].y + s[i + 1].y) / 2;
        ctx.lineWidth = s[i].w;
        ctx.quadraticCurveTo(s[i].x, s[i].y, mx, my);
      }
      const last = s[s.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
  };

  const point = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, w: e.pressure && e.pointerType === 'pen' ? 1.5 + e.pressure * 2.5 : 2.6 };
  };

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    current = [point(e)];
    strokes.push(current);
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    e.preventDefault();
    current.push(point(e));
    redraw();
  });
  const end = () => {
    if (!current) return;
    current = null;
    onChange?.(!isEmpty());
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  const isEmpty = () => strokes.reduce((n, s) => n + s.length, 0) < 4;

  // Crops to the ink and exports a transparent PNG.
  const toPng = () => {
    if (isEmpty()) return null;
    const pts = strokes.flat();
    const pad = 8;
    const minX = Math.max(0, Math.min(...pts.map((p) => p.x)) - pad);
    const minY = Math.max(0, Math.min(...pts.map((p) => p.y)) - pad);
    const maxX = Math.max(...pts.map((p) => p.x)) + pad;
    const maxY = Math.max(...pts.map((p) => p.y)) + pad;
    const scale = 2;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round((maxX - minX) * scale));
    out.height = Math.max(1, Math.round((maxY - minY) * scale));
    const o = out.getContext('2d');
    o.scale(scale, scale);
    o.translate(-minX, -minY);
    o.lineCap = 'round';
    o.lineJoin = 'round';
    o.strokeStyle = '#0b1a44';
    o.fillStyle = '#0b1a44';
    for (const s of strokes) {
      if (s.length === 1) {
        o.beginPath();
        o.arc(s[0].x, s[0].y, 1.4, 0, Math.PI * 2);
        o.fill();
        continue;
      }
      o.beginPath();
      o.moveTo(s[0].x, s[0].y);
      for (let i = 1; i < s.length - 1; i += 1) {
        o.lineWidth = s[i].w;
        o.quadraticCurveTo(s[i].x, s[i].y, (s[i].x + s[i + 1].x) / 2, (s[i].y + s[i + 1].y) / 2);
      }
      o.lineTo(s[s.length - 1].x, s[s.length - 1].y);
      o.stroke();
    }
    return out.toDataURL('image/png');
  };

  const clear = () => {
    strokes = [];
    redraw();
    onChange?.(false);
  };

  return { el: wrap, mount: () => requestAnimationFrame(size), resize: size, toPng, clear, isEmpty };
}

export async function typedPng(text, font) {
  try {
    await document.fonts.load(`64px "${font}"`, text);
  } catch {
    /* falls back to the browser's cursive font */
  }
  const size = 64;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `${size}px "${font}", cursive`;
  const width = Math.ceil(probe.measureText(text).width) + 24;
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(1600, Math.max(40, width));
  canvas.height = Math.round(size * 1.5);
  const ctx = canvas.getContext('2d');
  ctx.font = `${size}px "${font}", cursive`;
  ctx.fillStyle = '#0b1a44';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 12, Math.round(size * 1.08));
  return canvas.toDataURL('image/png');
}

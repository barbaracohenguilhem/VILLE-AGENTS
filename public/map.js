// Ville — pixel map renderer. Everything is drawn procedurally on a 16px-per-tile
// logical grid and scaled by an integer factor so pixels stay crisp.

const T = 16; // logical pixels per tile
const CELL = { VOID: -1, WALL: -2, FENCE: -3, DOOR: -4 };
const FLAT = new Set(['rug', 'mat', 'splat', 'flowers', 'stones', 'lights']);

// ── colour helpers ───────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgb([r, g, b]) {
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
/** Lighten (>0) or darken (<0) a hex colour by a fraction. */
function shade(hex, f) {
  const c = hexToRgb(hex);
  return rgb(c.map((v) => (f > 0 ? v + (255 - v) * f : v * (1 + f))));
}
function hash2(x, y, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ── sprite primitives ────────────────────────────────────────────────────────

class Pix {
  constructor(ctx, s) {
    this.ctx = ctx;
    this.s = s;
  }
  /** Rounds edges (not sizes) so neighbouring rects never leave seams at fractional scales. */
  r(x, y, w, h, color) {
    const x0 = Math.round(x * this.s);
    const y0 = Math.round(y * this.s);
    const x1 = Math.round((x + w) * this.s);
    const y1 = Math.round((y + h) * this.s);
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  }
  /** Rectangle with the four corner pixels knocked out (cheap rounding). */
  rr(x, y, w, h, color) {
    this.r(x + 1, y, w - 2, h, color);
    this.r(x, y + 1, w, h - 2, color);
  }
}

// ── floors ───────────────────────────────────────────────────────────────────

function drawFloorTile(p, style, color, tx, ty) {
  const ox = tx * T;
  const oy = ty * T;
  const base = shade(color, 0.08);
  const dark = shade(color, -0.18);
  const light = shade(color, 0.22);
  switch (style) {
    case 'wood': {
      for (let row = 0; row < 4; row++) {
        const tone = hash2(tx, ty * 4 + row) < 0.5 ? base : shade(color, 0.02);
        p.r(ox, oy + row * 4, T, 4, tone);
        p.r(ox, oy + row * 4 + 3, T, 1, dark);
        const seam = Math.floor(hash2(tx, ty * 4 + row, 7) * 14) + 1;
        p.r(ox + seam, oy + row * 4, 1, 3, dark);
        if (hash2(tx, ty * 4 + row, 3) < 0.3) p.r(ox + ((seam + 6) % 14) + 1, oy + row * 4 + 1, 3, 1, light);
      }
      break;
    }
    case 'tile': {
      const a = shade(color, 0.14);
      const b = shade(color, -0.04);
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) {
          p.r(ox + i * 8, oy + j * 8, 8, 8, (i + j) % 2 ? a : b);
          p.r(ox + i * 8, oy + j * 8, 8, 1, dark);
          p.r(ox + i * 8, oy + j * 8, 1, 8, dark);
        }
      break;
    }
    case 'carpet': {
      p.r(ox, oy, T, T, base);
      for (let k = 0; k < 6; k++) {
        const x = Math.floor(hash2(tx, ty, 10 + k) * T);
        const y = Math.floor(hash2(tx, ty, 30 + k) * T);
        p.r(ox + x, oy + y, 1, 1, hash2(tx, ty, 50 + k) < 0.5 ? light : dark);
      }
      break;
    }
    case 'grass': {
      p.r(ox, oy, T, T, hash2(tx, ty, 1) < 0.5 ? base : shade(color, 0.03));
      for (let k = 0; k < 5; k++) {
        const x = Math.floor(hash2(tx, ty, 20 + k) * 15);
        const y = Math.floor(hash2(tx, ty, 40 + k) * 14);
        const c = hash2(tx, ty, 60 + k) < 0.6 ? dark : light;
        p.r(ox + x, oy + y, 1, 2, c);
        if (hash2(tx, ty, 80 + k) < 0.5) p.r(ox + x + 1, oy + y + 1, 1, 1, c);
      }
      break;
    }
    case 'stone': {
      p.r(ox, oy, T, T, base);
      p.r(ox, oy, T, 1, dark);
      p.r(ox, oy, 1, T, dark);
      p.r(ox + 1, oy + 1, T - 2, 1, light);
      break;
    }
    default: {
      // concrete
      p.r(ox, oy, T, T, base);
      for (let k = 0; k < 4; k++) {
        const x = Math.floor(hash2(tx, ty, 100 + k) * T);
        const y = Math.floor(hash2(tx, ty, 120 + k) * T);
        p.r(ox + x, oy + y, 2, 1, hash2(tx, ty, 140 + k) < 0.5 ? shade(color, 0.16) : dark);
      }
    }
  }
}

const WALL = { top: '#6b6478', face: '#4a4455', edge: '#2d2933', hi: '#8a8298' };
const FENCE = { wood: '#b98a52', dark: '#7a5631', hi: '#d9ad76' };

function drawWallTile(p, tx, ty, grid) {
  const ox = tx * T;
  const oy = ty * T;
  const below = cellAt(grid, tx, ty + 1);
  const faceVisible = below >= 0 || below === CELL.DOOR; // a room is south of this wall → we see its face
  p.r(ox, oy, T, T, WALL.top);
  p.r(ox, oy, T, 1, WALL.hi);
  if (faceVisible) {
    p.r(ox, oy + 9, T, 7, WALL.face);
    p.r(ox, oy + 9, T, 1, WALL.edge);
    p.r(ox, oy + 15, T, 1, WALL.edge);
    // brick hints
    for (let i = 0; i < 2; i++) p.r(ox + (i * 8 + ((ty % 2) * 4)) % 16, oy + 12, 1, 1, WALL.edge);
  } else {
    p.r(ox, oy + 15, T, 1, WALL.edge);
  }
  if (cellAt(grid, tx - 1, ty) >= 0) p.r(ox, oy, 1, T, WALL.edge);
  if (cellAt(grid, tx + 1, ty) >= 0) p.r(ox + 15, oy, 1, T, WALL.edge);
}

function drawFenceTile(p, tx, ty, color) {
  const ox = tx * T;
  const oy = ty * T;
  drawFloorTile(p, 'grass', color, tx, ty);
  p.r(ox, oy + 6, T, 2, FENCE.dark);
  p.r(ox, oy + 11, T, 2, FENCE.dark);
  for (let i = 0; i < 4; i++) {
    const x = ox + i * 4 + 1;
    p.r(x, oy + 2, 2, 13, FENCE.wood);
    p.r(x, oy + 2, 1, 13, FENCE.hi);
    p.r(x, oy + 1, 2, 1, FENCE.hi);
  }
}

function drawDoorTile(p, tx, ty, grid, rooms) {
  const ox = tx * T;
  const oy = ty * T;
  const horizontal = cellAt(grid, tx - 1, ty) >= 0 && cellAt(grid, tx + 1, ty) >= 0; // passage runs left↔right
  const a = horizontal ? cellAt(grid, tx - 1, ty) : cellAt(grid, tx, ty - 1);
  const b = horizontal ? cellAt(grid, tx + 1, ty) : cellAt(grid, tx, ty + 1);
  const ra = rooms[a];
  const rb = rooms[b];
  const outdoor = !!(ra?.outdoor && rb?.outdoor);
  // threshold
  p.r(ox, oy, T, T, outdoor ? shade(ra.color, 0.05) : '#8c6b45');
  if (!outdoor) {
    for (let i = 0; i < 4; i++) p.r(ox, oy + i * 4 + 3, T, 1, '#6a4e30');
    // mat
    p.rr(ox + 3, oy + 4, 10, 8, '#9b3b3b');
    p.r(ox + 4, oy + 5, 8, 6, '#b84a4a');
  }
  if (outdoor) return;
  // frame posts
  if (horizontal) {
    p.r(ox, oy, T, 2, WALL.edge);
    p.r(ox, oy + 14, T, 2, WALL.edge);
  } else {
    p.r(ox, oy, 2, T, WALL.edge);
    p.r(ox + 14, oy, 2, T, WALL.edge);
  }
}

function cellAt(grid, x, y) {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return CELL.VOID;
  return grid.cells[y * grid.width + x];
}

// ── furniture ────────────────────────────────────────────────────────────────

const WOOD = { top: '#b07a4a', face: '#8a5a33', dark: '#5f3d20', hi: '#d39a63' };
const BOOKS = ['#c0392b', '#2980b9', '#27ae60', '#f1c40f', '#8e44ad', '#e67e22', '#ecf0f1', '#16a085', '#d35400'];

/** Generic box with a lighter top face and darker front. */
function box(p, x, y, w, h, top, face, dark, topH = 10) {
  p.r(x, y, w, h, face);
  p.r(x, y, w, Math.min(h, topH), top);
  p.r(x, y + h - 1, w, 1, dark);
  p.r(x, y, 1, h, dark);
  p.r(x + w - 1, y, 1, h, dark);
}

function drawObject(p, o, now, extra = {}) {
  const x = o.x * T;
  const y = o.y * T;
  const w = o.w * T;
  const h = o.h * T;
  const seed = o.x * 31 + o.y * 17;
  switch (o.kind) {
    case 'rug': {
      p.rr(x + 1, y + 1, w - 2, h - 2, '#8e3b46');
      p.rr(x + 3, y + 3, w - 6, h - 6, '#b85463');
      p.rr(x + 6, y + 6, w - 12, h - 12, '#8e3b46');
      for (let i = 0; i < w / 4; i++) p.r(x + 2 + i * 4, y + 1, 1, 1, '#e8c3a0');
      for (let i = 0; i < w / 4; i++) p.r(x + 2 + i * 4, y + h - 2, 1, 1, '#e8c3a0');
      break;
    }
    case 'mat':
      p.rr(x + 2, y + 4, 12, 8, '#9b3b3b');
      break;
    case 'splat': {
      const cols = ['#e74c3c', '#3498db', '#f1c40f', '#9b59b6', '#2ecc71'];
      for (let k = 0; k < 4; k++) {
        const c = cols[(seed + k) % cols.length];
        const sx = x + 2 + Math.floor(hash2(o.x, o.y, k) * 10);
        const sy = y + 2 + Math.floor(hash2(o.x, o.y, 9 + k) * 10);
        p.rr(sx, sy, 4, 3, c);
        p.r(sx + 5, sy + 1, 1, 1, c);
      }
      break;
    }
    case 'flowers': {
      const cols = ['#ff6b81', '#ffd166', '#ff9f43', '#c56cf0', '#f8f8f8'];
      for (let k = 0; k < 5; k++) {
        const fx = x + 1 + Math.floor(hash2(o.x, o.y, k) * 13);
        const fy = y + 2 + Math.floor(hash2(o.x, o.y, 20 + k) * 11);
        p.r(fx, fy + 2, 1, 2, '#2f7a2f');
        p.r(fx - 1, fy, 3, 1, cols[(seed + k) % cols.length]);
        p.r(fx, fy - 1, 1, 3, cols[(seed + k) % cols.length]);
      }
      break;
    }
    case 'stones':
      p.rr(x + 3, y + 4, 10, 7, '#9a9a9a');
      p.r(x + 4, y + 5, 7, 4, '#b5b5b5');
      p.r(x + 5, y + 5, 3, 1, '#d0d0d0');
      break;
    case 'lights': {
      p.r(x, y + 3, w, 1, '#3a3a3a');
      for (let i = 0; i < w / 6; i++) {
        const on = Math.floor(now / 500 + i) % 3 !== 0;
        const lx = x + 3 + i * 6;
        p.r(lx, y + 4, 1, 1, '#3a3a3a');
        p.r(lx - 1, y + 5, 3, 3, on ? ['#ffd166', '#ff8fa3', '#8ef0ff', '#b8ff8e'][i % 4] : '#665');
        if (on) p.r(lx, y + 6, 1, 1, '#fff');
      }
      break;
    }
    case 'sofa': {
      const c = '#4f8a5b';
      const d = '#35603d';
      const l = '#6ea878';
      p.r(x + 1, y + 2, w - 2, 12, c);
      p.r(x + 1, y + 2, w - 2, 5, d); // backrest
      p.r(x + 2, y + 3, w - 4, 1, l);
      p.r(x + 1, y + 7, 3, 7, d); // arms
      p.r(x + w - 4, y + 7, 3, 7, d);
      for (let i = 1; i < o.w; i++) p.r(x + i * T, y + 7, 1, 6, d); // cushion seams
      p.r(x + 4, y + 8, w - 8, 1, l);
      p.r(x + 2, y + 14, 2, 2, '#3a2a1a');
      p.r(x + w - 4, y + 14, 2, 2, '#3a2a1a');
      break;
    }
    case 'armchair': {
      const c = '#8a5a7a';
      const d = '#5e3b53';
      p.r(x + 2, y + 2, 12, 12, c);
      p.r(x + 2, y + 2, 12, 4, d);
      p.r(x + 2, y + 6, 2, 8, d);
      p.r(x + 12, y + 6, 2, 8, d);
      p.r(x + 4, y + 7, 8, 1, '#a877a2');
      p.r(x + 3, y + 14, 2, 1, '#3a2a1a');
      p.r(x + 11, y + 14, 2, 1, '#3a2a1a');
      break;
    }
    case 'bench': {
      p.r(x + 1, y + 6, w - 2, 5, WOOD.top);
      for (let i = 0; i < 2; i++) p.r(x + 1, y + 7 + i * 2, w - 2, 1, WOOD.face);
      p.r(x + 1, y + 2, w - 2, 3, WOOD.top); // backrest
      p.r(x + 1, y + 4, w - 2, 1, WOOD.face);
      p.r(x + 2, y + 11, 2, 4, WOOD.dark);
      p.r(x + w - 4, y + 11, 2, 4, WOOD.dark);
      break;
    }
    case 'chair': {
      p.r(x + 4, y + 6, 8, 7, WOOD.top);
      p.r(x + 4, y + 12, 8, 1, WOOD.dark);
      if (o.facing !== 'up') {
        p.r(x + 4, y + 2, 8, 4, WOOD.face);
        p.r(x + 5, y + 3, 6, 1, WOOD.hi);
      } else {
        p.r(x + 4, y + 11, 8, 4, WOOD.face);
      }
      p.r(x + 4, y + 13, 1, 2, WOOD.dark);
      p.r(x + 11, y + 13, 1, 2, WOOD.dark);
      break;
    }
    case 'beanbag':
      p.rr(x + 2, y + 4, 12, 10, '#7a4fbf');
      p.rr(x + 4, y + 6, 8, 5, '#9a73d8');
      p.r(x + 5, y + 7, 3, 1, '#b99af0');
      break;
    case 'bed': {
      const blankets = ['#c0504d', '#4f81bd', '#9bbb59', '#8064a2', '#f79646', '#4bacc6'];
      const bl = blankets[seed % blankets.length];
      p.r(x + 1, y, 14, h - 1, WOOD.dark); // frame
      p.r(x + 2, y + 1, 12, h - 3, '#f0ede4'); // mattress
      p.r(x + 1, y, 14, 2, WOOD.face); // headboard
      p.r(x + 3, y + 3, 10, 4, '#ffffff'); // pillow
      p.r(x + 3, y + 6, 10, 1, '#d8d4c8');
      p.r(x + 2, y + 9, 12, h - 11, bl); // blanket
      p.r(x + 2, y + 9, 12, 2, shade(bl, 0.3));
      p.r(x + 2, y + h - 3, 12, 1, shade(bl, -0.3));
      if (extra.sleeper) drawSleeper(p, x, y, extra.sleeper, now, bl);
      break;
    }
    case 'table':
    case 'coffeetable': {
      const low = o.kind === 'coffeetable';
      const ty = low ? y + 5 : y;
      const th = low ? h - 7 : h - 3;
      box(p, x + 1, ty, w - 2, th, WOOD.top, WOOD.face, WOOD.dark, th - 3);
      p.r(x + 2, ty + 1, w - 4, 1, WOOD.hi);
      p.r(x + 2, ty + th, 2, 3, WOOD.dark);
      p.r(x + w - 4, ty + th, 2, 3, WOOD.dark);
      if (!low && o.w >= 3) {
        // a mug and a plate
        p.r(x + 6, y + 4, 3, 3, '#f5f5f5');
        p.r(x + 9, y + 5, 1, 1, '#f5f5f5');
        p.rr(x + w - 10, y + 4, 5, 4, '#e8e8e8');
      } else if (low) {
        p.r(x + 4, ty + 2, 4, 2, '#d8d8d8');
      }
      break;
    }
    case 'desk':
    case 'deskpc': {
      box(p, x + 1, y + 4, w - 2, h - 5, WOOD.top, WOOD.face, WOOD.dark, 6);
      p.r(x + w - 7, y + 11, 4, 1, WOOD.hi); // drawer handle
      if (o.kind === 'deskpc') {
        p.r(x + 3, y - 2, 10, 8, '#1e1e24'); // monitor
        p.r(x + 4, y - 1, 8, 6, Math.floor(now / 700) % 5 === 0 ? '#3a7bd5' : '#4f9df5');
        p.r(x + 5, y, 4, 1, '#9ad1ff');
        p.r(x + 7, y + 6, 2, 1, '#1e1e24');
        p.r(x + 4, y + 7, 7, 2, '#2b2b33'); // keyboard
        p.r(x + 13, y + 7, 2, 2, '#2b2b33'); // mouse
      } else {
        p.r(x + 3, y + 5, 6, 4, '#f3f0e6');
        p.r(x + 4, y + 6, 4, 1, '#999');
      }
      break;
    }
    case 'shelf': {
      p.r(x, y, w, h, WOOD.dark);
      const rows = Math.max(1, Math.floor(h / 8));
      for (let r = 0; r < rows; r++) {
        const ry = y + 1 + r * 8;
        p.r(x + 1, ry, w - 2, 6, '#3a2a1c');
        let bx = x + 2;
        let k = 0;
        while (bx < x + w - 2) {
          const bw = 1 + ((seed + k * 7 + r) % 2);
          const col = BOOKS[(seed + k * 3 + r * 5) % BOOKS.length];
          const bh = 4 + ((seed + k + r) % 3);
          if (hash2(o.x + k, o.y + r, 5) > 0.1) p.r(bx, ry + 6 - bh, bw, bh, col);
          bx += bw + 1;
          k++;
        }
        p.r(x + 1, ry + 6, w - 2, 1, WOOD.face);
      }
      p.r(x, y, w, 1, WOOD.face);
      break;
    }
    case 'counter':
    case 'counter-coffee':
    case 'counter-bowl':
    case 'counter-radio': {
      p.r(x, y + 3, T, 13, '#e9e4d8'); // cabinet
      p.r(x, y + 3, T, 4, '#cdbb9a'); // top
      p.r(x, y + 3, T, 1, '#efe3c8');
      p.r(x, y + 7, T, 1, '#b9a683');
      p.r(x + 7, y + 10, 2, 1, '#8a8a8a'); // handle
      p.r(x, y + 15, T, 1, '#b8b2a6');
      if (o.kind === 'counter-coffee') {
        p.r(x + 4, y - 1, 8, 7, '#2b2b33');
        p.r(x + 5, y, 6, 2, '#44444f');
        p.r(x + 6, y + 4, 4, 2, '#f1f1f1');
        p.r(x + 11, y + 1, 1, 1, Math.floor(now / 600) % 2 ? '#ff3b3b' : '#7a1a1a');
      } else if (o.kind === 'counter-bowl') {
        p.rr(x + 3, y + 1, 10, 5, '#5a8fd6');
        p.r(x + 5, y - 1, 2, 2, '#ff5a5a');
        p.r(x + 8, y - 1, 2, 2, '#ffd23f');
        p.r(x + 6, y, 3, 2, '#7bd14f');
      } else if (o.kind === 'counter-radio') {
        p.r(x + 3, y - 1, 10, 6, '#7a4a2a');
        p.r(x + 4, y, 5, 4, '#3a2a1a');
        p.r(x + 10, y + 1, 2, 2, '#e0c080');
        p.r(x + 12, y - 4, 1, 4, '#999');
      }
      break;
    }
    case 'stove':
      p.r(x, y + 3, T, 13, '#f2f2f2');
      p.r(x, y + 3, T, 4, '#44444c');
      p.r(x, y + 15, T, 1, '#aaa');
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) p.r(x + 3 + i * 7, y + 3 + j * 2, 3, 1, '#111');
      p.r(x + 2, y + 9, 12, 5, '#3a3a40');
      p.r(x + 3, y + 10, 10, 3, '#5a5a66');
      p.r(x + 4, y + 11, 8, 1, Math.floor(now / 900) % 3 ? '#ff9a3c' : '#5a5a66');
      break;
    case 'sink':
      p.r(x, y + 3, T, 13, '#e9e4d8');
      p.r(x, y + 3, T, 4, '#cdbb9a');
      p.r(x, y + 15, T, 1, '#b8b2a6');
      p.rr(x + 2, y + 2, 12, 6, '#9aa5b1');
      p.r(x + 4, y + 3, 8, 3, '#c4ccd6');
      p.r(x + 7, y - 2, 2, 5, '#cfcfcf'); // tap
      p.r(x + 7, y - 3, 4, 1, '#cfcfcf');
      if (Math.floor(now / 400) % 4 === 0) p.r(x + 10, y + 1, 1, 1, '#9ad1ff'); // drip
      break;
    case 'fridge':
      p.r(x + 1, y - 4, 14, 20, '#dfe3e8');
      p.r(x + 1, y - 4, 14, 1, '#f5f7fa');
      p.r(x + 1, y + 3, 14, 1, '#b8bec6');
      p.r(x + 1, y + 15, 14, 1, '#9aa0a8');
      p.r(x + 12, y - 2, 1, 4, '#888');
      p.r(x + 12, y + 5, 1, 6, '#888');
      // notes
      p.r(x + 3, y - 2, 3, 3, '#ffd166');
      p.r(x + 7, y - 1, 3, 2, '#8ecae6');
      p.r(x + 4, y + 6, 3, 3, '#ff8fa3');
      p.r(x + 8, y + 8, 3, 2, '#b8ff8e');
      break;
    case 'tv': {
      const back = o.facing === 'up';
      p.r(x + 2, y + 2, w - 4, 10, '#2a2a30');
      if (!back) p.r(x + 3, y + 3, w - 6, 8, Math.floor(now / 350) % 3 ? '#4a6fa5' : '#6a8fc5');
      else p.r(x + 3, y + 3, w - 6, 8, '#3a3a42');
      p.r(x + w / 2 - 1, y + 12, 2, 2, '#444');
      p.r(x + 4, y + 14, w - 8, 1, '#444');
      break;
    }
    case 'fireplace': {
      p.r(x, y, w, 16, '#6d6a66');
      p.r(x, y, w, 2, '#8c8882');
      p.r(x + 3, y + 4, w - 6, 11, '#1a1410');
      const f = Math.floor(now / 160) % 3;
      p.r(x + 6, y + 8 + f, w - 12, 6 - f, '#ff8c1a');
      p.r(x + 8, y + 10 + (f % 2), w - 16, 4, '#ffd23f');
      p.r(x + 5, y + 13, w - 10, 2, '#4a2a10');
      break;
    }
    case 'records':
      box(p, x + 1, y + 4, w - 2, 12, WOOD.top, WOOD.face, WOOD.dark, 4);
      p.r(x + 3, y + 1, 12, 5, '#3a3a42'); // player
      p.r(x + 5, y + 1, 7, 4, '#111');
      p.r(x + 8, y + 2, 1, 1, '#ddd');
      p.r(x + 13, y, 1, 4, '#bbb');
      for (let i = 0; i < 6; i++) p.r(x + 18 + i * 2, y + 2 + (i % 2), 1, 4, BOOKS[(i + 2) % BOOKS.length]);
      p.r(x + 3, y + 10, w - 6, 1, WOOD.dark);
      break;
    case 'board':
      p.r(x + 1, y + 1, 14, 12, '#5a3b22');
      p.r(x + 2, y + 2, 12, 10, '#c89f6a');
      p.r(x + 3, y + 3, 4, 4, '#fff7b0');
      p.r(x + 8, y + 4, 5, 3, '#ffd6e0');
      p.r(x + 4, y + 8, 6, 3, '#d6f5ff');
      break;
    case 'games':
      p.r(x + 2, y + 10, 12, 4, '#c0392b');
      p.r(x + 3, y + 6, 10, 4, '#2980b9');
      p.r(x + 4, y + 3, 8, 3, '#f1c40f');
      p.r(x + 3, y + 7, 10, 1, '#1f5f8b');
      break;
    case 'plant':
      p.r(x + 5, y + 10, 6, 5, '#b5603a');
      p.r(x + 4, y + 9, 8, 2, '#d0774c');
      p.r(x + 6, y + 4, 4, 6, '#2f8f3f');
      p.r(x + 3, y + 5, 3, 3, '#3fa84f');
      p.r(x + 10, y + 6, 3, 3, '#3fa84f');
      p.r(x + 7, y + 1, 2, 4, '#58c466');
      p.r(x + 4, y + 2, 2, 2, '#58c466');
      break;
    case 'tree': {
      p.r(x + 13, y + 16, 6, 14, '#6b4a2c');
      p.r(x + 15, y + 16, 2, 14, '#8c6540');
      p.rr(x + 2, y + 2, 28, 20, '#2f7a3a');
      p.rr(x + 5, y - 1, 22, 10, '#3a9148');
      p.rr(x + 8, y + 5, 14, 10, '#49a85a');
      // lemons that never ripen (green)
      p.r(x + 9, y + 9, 2, 2, '#c9e265');
      p.r(x + 20, y + 12, 2, 2, '#c9e265');
      p.r(x + 14, y + 4, 2, 2, '#c9e265');
      break;
    }
    case 'planter': {
      p.r(x, y + 2, w, 12, WOOD.face);
      p.r(x + 1, y + 3, w - 2, 10, '#4a3321');
      p.r(x, y + 2, w, 1, WOOD.hi);
      for (let i = 0; i < w / 5; i++) {
        const sx = x + 3 + i * 5;
        p.r(sx, y + 6, 1, 4, '#3f9a3f');
        p.r(sx - 1, y + 5, 3, 1, '#58c466');
        if ((seed + i) % 3 === 0) p.r(sx + 1, y + 7, 1, 1, '#ff5a5a');
      }
      break;
    }
    case 'can':
      p.r(x + 5, y + 7, 7, 7, '#7d8a99');
      p.r(x + 5, y + 7, 7, 1, '#a7b3c2');
      p.r(x + 12, y + 6, 2, 3, '#7d8a99');
      p.r(x + 7, y + 5, 3, 2, '#7d8a99');
      break;
    case 'bin':
      p.r(x + 3, y + 4, 10, 11, '#2f6b3a');
      p.r(x + 2, y + 3, 12, 2, '#3f8a4a');
      p.r(x + 6, y + 1, 4, 2, '#3f8a4a');
      p.r(x + 4, y + 7, 8, 1, '#245230');
      break;
    case 'chess':
      p.r(x + 2, y + 2, 12, 12, WOOD.dark);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) p.r(x + 4 + i * 2, y + 4 + j * 2, 2, 2, (i + j) % 2 ? '#f4e4c1' : '#5a3a22');
      p.r(x + 5, y + 5, 1, 1, '#fff');
      p.r(x + 10, y + 10, 1, 1, '#000');
      break;
    case 'lamp': {
      const night = extra.night > 0.3;
      p.r(x + 7, y + 6, 2, 8, '#8a8a8a');
      p.r(x + 5, y + 13, 6, 2, '#555');
      p.r(x + 3, y + 2, 10, 5, night ? '#ffe9a8' : '#e8d8a8');
      p.r(x + 4, y + 1, 8, 1, night ? '#fff4cf' : '#f3e8c8');
      break;
    }
    case 'globe':
      p.r(x + 7, y + 11, 2, 3, '#8a6a3a');
      p.r(x + 5, y + 13, 6, 1, '#5a3a22');
      p.rr(x + 4, y + 3, 8, 8, '#3a7bd5');
      p.r(x + 6, y + 5, 3, 2, '#5aa86a');
      p.r(x + 9, y + 8, 2, 2, '#5aa86a');
      break;
    case 'books':
      p.r(x + 4, y + 11, 8, 2, '#2980b9');
      p.r(x + 5, y + 9, 7, 2, '#c0392b');
      p.r(x + 4, y + 7, 8, 2, '#f1c40f');
      p.r(x + 5, y + 5, 6, 2, '#27ae60');
      break;
    case 'easel':
      p.r(x + 4, y + 6, 1, 9, WOOD.dark);
      p.r(x + 11, y + 6, 1, 9, WOOD.dark);
      p.r(x + 7, y + 10, 1, 5, WOOD.dark);
      p.r(x + 3, y + 1, 10, 9, '#f6f1e6');
      p.r(x + 3, y + 1, 10, 1, WOOD.face);
      p.r(x + 5, y + 3, 3, 3, '#e74c3c');
      p.r(x + 8, y + 5, 3, 2, '#3498db');
      p.r(x + 5, y + 7, 5, 1, '#f1c40f');
      break;
    case 'canvases':
      p.r(x + 2, y + 3, 10, 11, '#f0ebe0');
      p.r(x + 2, y + 3, 10, 1, WOOD.face);
      p.r(x + 4, y + 6, 4, 4, '#9b59b6');
      p.r(x + 14, y + 2, 10, 12, '#f6f1e6');
      p.r(x + 14, y + 2, 10, 1, WOOD.face);
      p.r(x + 16, y + 5, 6, 3, '#1abc9c');
      p.r(x + 17, y + 9, 4, 2, '#e67e22');
      break;
    case 'keyboard':
      p.r(x + 1, y + 4, w - 2, 7, '#1f1f26');
      p.r(x + 2, y + 5, w - 4, 4, '#f5f5f5');
      for (let i = 0; i < (w - 4) / 3; i++) p.r(x + 3 + i * 3, y + 5, 1, 4, '#ddd');
      for (let i = 0; i < (w - 6) / 3; i++) if (i % 7 !== 2 && i % 7 !== 6) p.r(x + 4 + i * 3, y + 5, 1, 2, '#111');
      p.r(x + 4, y + 11, 2, 4, '#444');
      p.r(x + w - 6, y + 11, 2, 4, '#444');
      break;
    case 'guitar':
      p.r(x + 7, y + 1, 2, 7, '#6b4a2c');
      p.r(x + 6, y, 4, 2, '#3a2a1a');
      p.rr(x + 4, y + 7, 8, 5, '#c98a4a');
      p.rr(x + 3, y + 10, 10, 5, '#c98a4a');
      p.r(x + 7, y + 10, 2, 2, '#3a2a1a');
      p.r(x + 5, y + 14, 6, 1, '#555');
      break;
    case 'speaker':
      p.r(x + 3, y + 1, 10, 14, '#1f1f26');
      p.rr(x + 5, y + 3, 6, 5, '#3a3a44');
      p.r(x + 7, y + 5, 2, 1, '#666');
      p.rr(x + 6, y + 9, 4, 4, '#3a3a44');
      break;
    case 'basket':
      p.r(x + 3, y + 5, 10, 9, '#c9a46a');
      for (let i = 0; i < 4; i++) p.r(x + 3, y + 6 + i * 2, 10, 1, '#a8864f');
      p.r(x + 4, y + 2, 3, 3, '#e74c3c');
      p.r(x + 8, y + 3, 4, 2, '#3498db');
      break;
    case 'mirror':
      p.r(x + 3, y + 1, 10, 13, WOOD.face);
      p.r(x + 4, y + 2, 8, 11, '#bfe3f7');
      p.r(x + 5, y + 3, 1, 8, '#ffffff');
      p.r(x + 6, y + 3, 1, 3, '#ffffff');
      break;
    case 'telescope':
      p.r(x + 7, y + 9, 1, 6, '#444');
      p.r(x + 4, y + 14, 3, 1, '#444');
      p.r(x + 8, y + 14, 3, 1, '#444');
      p.r(x + 3, y + 3, 10, 3, '#2b2b33');
      p.r(x + 11, y + 2, 3, 5, '#44444f');
      p.r(x + 3, y + 3, 10, 1, '#5a5a66');
      p.r(x + 6, y + 6, 3, 3, '#444');
      break;
    default: // box
      box(p, x + 2, y + 3, 12, 12, WOOD.top, WOOD.face, WOOD.dark, 4);
      p.r(x + 7, y + 8, 2, 1, WOOD.dark);
  }
}

// ── people ───────────────────────────────────────────────────────────────────

/**
 * Draws a 12×18 person whose feet are at logical (fx, fy).
 * frame: 0 standing, 1/2 walking steps. opts: { asleep, blink, talking }.
 */
function drawPerson(p, fx, fy, look, facing, frame, opts = {}) {
  const L = fx - 6;
  const top = fy - 18;
  const bob = frame ? -1 : 0;
  const Y = (row) => top + row + bob;
  const skin = look.skin;
  const hair = look.hair;
  const shirt = look.shirt;
  const pants = look.pants;
  const shoe = '#2a2320';
  const shirtDark = shade(shirt, -0.25);

  // shadow
  p.ctx.fillStyle = 'rgba(0,0,0,0.28)';
  p.ctx.fillRect(Math.round((L + 2) * p.s), Math.round((fy - 1) * p.s), Math.round(8 * p.s), Math.round(2 * p.s));

  // legs
  const legA = frame === 1 ? -1 : 0; // left leg lifted
  const legB = frame === 2 ? -1 : 0;
  p.r(L + 3, Y(12), 3, 4 + legA, pants);
  p.r(L + 6, Y(12), 3, 4 + legB, pants);
  p.r(L + 3, Y(16) + legA, 3, 2, shoe);
  p.r(L + 6, Y(16) + legB, 3, 2, shoe);

  // torso
  p.r(L + 3, Y(8), 6, 4, shirt);
  p.r(L + 3, Y(11), 6, 1, shirtDark);
  // arms
  const armA = frame === 1 ? -1 : frame === 2 ? 1 : 0;
  p.r(L + 2, Y(8) + armA, 1, 3, shirt);
  p.r(L + 9, Y(8) - armA, 1, 3, shirt);
  p.r(L + 2, Y(11) + armA, 1, 1, skin);
  p.r(L + 9, Y(11) - armA, 1, 1, skin);
  // neck
  p.r(L + 5, Y(7), 2, 1, skin);

  // head
  p.r(L + 2, Y(2), 8, 5, skin);
  p.r(L + 3, Y(0), 6, 2, hair);
  p.r(L + 2, Y(2), 8, 1, hair);
  p.r(L + 2, Y(3), 1, 1, hair);
  p.r(L + 9, Y(3), 1, 1, hair);

  if (facing === 'up') {
    p.r(L + 2, Y(2), 8, 4, hair);
    p.r(L + 3, Y(6), 6, 1, hair);
  } else {
    const eye = '#1b1b1f';
    const closed = opts.asleep || opts.blink;
    if (facing === 'down') {
      if (closed) {
        p.r(L + 4, Y(5), 2, 1, eye);
        p.r(L + 7, Y(5), 2, 1, eye);
      } else {
        p.r(L + 4, Y(4), 1, 2, eye);
        p.r(L + 7, Y(4), 1, 2, eye);
        p.r(L + 4, Y(4), 1, 1, '#fff');
        p.r(L + 7, Y(4), 1, 1, '#fff');
      }
      if (opts.talking && Math.floor(performance.now() / 180) % 2) p.r(L + 5, Y(6), 2, 1, '#8a4a3a');
    } else {
      const ex = facing === 'left' ? L + 3 : L + 8;
      if (closed) p.r(ex, Y(5), 2, 1, eye);
      else {
        p.r(ex, Y(4), 1, 2, eye);
        p.r(ex, Y(4), 1, 1, '#fff');
      }
      // hair sweeps to the back of the head
      if (facing === 'left') p.r(L + 7, Y(3), 3, 2, hair);
      else p.r(L + 2, Y(3), 3, 2, hair);
    }
  }
}

function drawSleeper(p, bx, by, mover, now, blanket) {
  const look = mover.look;
  // head on the pillow
  p.r(bx + 4, by + 2, 8, 5, look.skin);
  p.r(bx + 4, by + 1, 8, 2, look.hair);
  p.r(bx + 4, by + 3, 1, 1, look.hair);
  p.r(bx + 11, by + 3, 1, 1, look.hair);
  p.r(bx + 6, by + 5, 2, 1, '#1b1b1f');
  p.r(bx + 9, by + 5, 2, 1, '#1b1b1f');
  // body bump under the blanket
  p.r(bx + 3, by + 9, 10, 6, shade(blanket, 0.18));
  p.r(bx + 3, by + 9, 10, 1, shade(blanket, 0.35));
  // zzz
  const t = (now / 1400) % 1;
  const zx = bx + 13;
  const zy = by - 2 - Math.floor(t * 6);
  p.ctx.globalAlpha = 1 - t;
  p.r(zx, zy, 3, 1, '#fff');
  p.r(zx + 2, zy + 1, 1, 1, '#fff');
  p.r(zx + 1, zy + 2, 1, 1, '#fff');
  p.r(zx, zy + 3, 3, 1, '#fff');
  p.ctx.globalAlpha = 1;
}

function drawZzz(p, fx, fy, now) {
  const t = (now / 1400) % 1;
  const zx = fx + 5;
  const zy = fy - 22 - Math.floor(t * 6);
  p.ctx.globalAlpha = 1 - t;
  p.r(zx, zy, 3, 1, '#fff');
  p.r(zx + 2, zy + 1, 1, 1, '#fff');
  p.r(zx + 1, zy + 2, 1, 1, '#fff');
  p.r(zx, zy + 3, 3, 1, '#fff');
  p.ctx.globalAlpha = 1;
}

// ── the map view ─────────────────────────────────────────────────────────────

export class MapView {
  constructor(canvas, overlay, callbacks) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.ctx = canvas.getContext('2d');
    this.callbacks = callbacks;
    this.house = null;
    this.movers = new Map();
    this.time = { day: 1, hour: 8, minute: 0 };
    this.s = 2;
    this.dpr = 1;
    this.staticLayer = null;
    this.bubbles = new Map();
    this.hover = null;
    this.blinks = new Map();
    this.focused = null;

    canvas.addEventListener('click', (e) => this.onClick(e));
    canvas.addEventListener('mousemove', (e) => this.onMove(e));
    canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      canvas.style.cursor = 'default';
      canvas.title = '';
    });
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement.parentElement);
    requestAnimationFrame(() => this.frame());
    // rAF pauses in background tabs; keep the picture roughly current anyway.
    setInterval(() => {
      if (document.hidden) this.draw();
    }, 250);
  }

  setHouse(house) {
    this.house = house;
    this.rooms = house.rooms;
    this.grid = house.grid;
    this.objects = house.objects;
    this.flat = house.objects.filter((o) => FLAT.has(o.kind));
    this.solid = house.objects.filter((o) => !FLAT.has(o.kind));
    this.resize();
  }

  setMover(view, now = performance.now()) {
    const m = this.movers.get(view.name) ?? { name: view.name };
    Object.assign(m, view);
    if (view.walk) {
      m.walk = { path: view.walk.path, tileMs: view.walk.tileMs, start: now - (view.walk.elapsed ?? 0) };
    } else {
      m.walk = undefined;
    }
    this.movers.set(view.name, m);
    return m;
  }

  removeMover(name) {
    this.movers.delete(name);
    this.bubbles.get(name)?.el.remove();
    this.bubbles.delete(name);
  }

  startWalk(name, path, tileMs) {
    const m = this.movers.get(name);
    if (!m) return;
    m.walk = { path, tileMs, start: performance.now() };
  }

  setPos(name, x, y, facing) {
    const m = this.movers.get(name);
    if (!m) return;
    m.walk = undefined;
    m.x = x;
    m.y = y;
    m.facing = facing;
  }

  bubble(name, text, thought) {
    let b = this.bubbles.get(name);
    if (!b) {
      const el = document.createElement('div');
      el.className = 'bubble';
      this.overlay.appendChild(el);
      b = { el, until: 0 };
      this.bubbles.set(name, b);
    }
    b.el.textContent = thought ? `💭 ${text}` : text;
    b.el.classList.toggle('thought', !!thought);
    b.el.classList.toggle('human', !!this.movers.get(name)?.human);
    b.el.classList.add('show');
    b.thought = !!thought;
    b.until = performance.now() + (thought ? 4500 : Math.min(14000, 3500 + text.length * 50));
  }

  // ── geometry ───────────────────────────────────────────────────────────

  resize() {
    if (!this.grid) return;
    const wrap = this.canvas.parentElement.parentElement;
    const cw = wrap.clientWidth - 24;
    const ch = wrap.clientHeight - 44;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = this.grid.width * T;
    const H = this.grid.height * T;
    const fit = Math.min((cw * this.dpr) / W, (ch * this.dpr) / H);
    // Fractional scale fills the space; Pix.r rounds edges so pixels stay seam-free.
    const s = Math.max(1, fit);
    const width = Math.round(W * s);
    const height = Math.round(H * s);
    if (width === this.canvas.width && height === this.canvas.height && this.staticLayer) return;
    this.s = s;
    this.cssScale = 1;
    this.canvas.width = width;
    this.canvas.height = height;
    const cssW = ((W * this.s) / this.dpr) * this.cssScale;
    const cssH = ((H * this.s) / this.dpr) * this.cssScale;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.parentElement.style.width = `${cssW}px`;
    this.canvas.parentElement.style.height = `${cssH}px`;
    this.ctx.imageSmoothingEnabled = false;
    this.buildStatic();
  }

  /** Logical px → CSS px within the overlay. */
  toCss(lx, ly) {
    const k = (this.s / this.dpr) * (this.cssScale ?? 1);
    return { x: lx * k, y: ly * k };
  }

  tileFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const k = (this.s / this.dpr) * (this.cssScale ?? 1);
    const lx = (e.clientX - rect.left) / k;
    const ly = (e.clientY - rect.top) / k;
    return { lx, ly, tx: Math.floor(lx / T), ty: Math.floor(ly / T) };
  }

  moverAt(lx, ly) {
    let hit = null;
    for (const m of this.movers.values()) {
      const { fx, fy } = this.feetOf(m, performance.now());
      if (lx >= fx - 7 && lx <= fx + 7 && ly >= fy - 20 && ly <= fy + 1) hit = m; // later = drawn on top
    }
    return hit;
  }

  canStand(tx, ty) {
    if (!this.grid) return false;
    const c = cellAt(this.grid, tx, ty);
    if (c < 0 && c !== CELL.DOOR) return false;
    for (const o of this.solid) {
      if (tx >= o.x && tx < o.x + o.w && ty >= o.y && ty < o.y + o.h) return !!o.sit;
    }
    return true;
  }

  onClick(e) {
    const { lx, ly, tx, ty } = this.tileFromEvent(e);
    const m = this.moverAt(lx, ly);
    if (m) {
      if (!m.human) this.callbacks.onMoverClick(m.name);
      return;
    }
    if (this.canStand(tx, ty)) this.callbacks.onTileClick(tx, ty);
  }

  onMove(e) {
    const { lx, ly, tx, ty } = this.tileFromEvent(e);
    const m = this.moverAt(lx, ly);
    this.hover = m?.name ?? null;
    if (m) {
      this.canvas.style.cursor = m.human ? 'default' : 'pointer';
      this.canvas.title = m.human ? `${m.name} (you)` : `${m.name} — ${m.awake ? m.activity || 'idle' : 'asleep'}\nmood: ${m.mood} · energy ${m.energy}\n${m.provider} · ${m.model}`;
      return;
    }
    const o = this.objects?.find((o) => tx >= o.x && tx < o.x + o.w && ty >= o.y && ty < o.y + o.h && !FLAT.has(o.kind));
    this.canvas.title = o ? o.name : '';
    this.canvas.style.cursor = this.canStand(tx, ty) ? 'crosshair' : 'default';
  }

  // ── rendering ──────────────────────────────────────────────────────────

  buildStatic() {
    const off = document.createElement('canvas');
    off.width = this.canvas.width;
    off.height = this.canvas.height;
    const ctx = off.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const p = new Pix(ctx, this.s);
    const g = this.grid;
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        const c = cellAt(g, x, y);
        if (c >= 0) {
          const room = this.rooms[c];
          drawFloorTile(p, room.floor, room.color, x, y);
        } else if (c === CELL.WALL) drawWallTile(p, x, y, g);
        else if (c === CELL.FENCE) {
          const near = this.rooms.find((r) => r.outdoor) ?? this.rooms[0];
          drawFenceTile(p, x, y, near.color);
        } else if (c === CELL.DOOR) drawDoorTile(p, x, y, g, this.rooms);
        else p.r(x * T, y * T, T, T, '#0b0d12');
      }
    }
    for (const o of this.flat) drawObject(p, o, 0);
    this.staticLayer = off;
  }

  drawRoomLabels(ctx) {
    ctx.font = `600 ${Math.round(5.5 * this.s)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const r of this.rooms) {
      const label = `${r.emoji} ${r.name}`;
      const tw = ctx.measureText(label).width;
      const x = (r.x * T + 2) * this.s;
      const y = (r.y * T + 2) * this.s;
      const h = 7 * this.s;
      ctx.fillStyle = 'rgba(8,10,14,0.6)';
      ctx.beginPath();
      ctx.roundRect(x, y, tw + 5 * this.s, h, 2 * this.s);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillText(label, x + 2.5 * this.s, y + h / 2 + 0.5);
    }
  }

  feetOf(m, now) {
    let x = m.x;
    let y = m.y;
    let facing = m.facing;
    let frame = 0;
    if (m.walk) {
      const { path, tileMs, start } = m.walk;
      const t = Math.max(0, (now - start) / tileMs);
      const i = Math.floor(t);
      if (i >= path.length - 1) {
        const last = path[path.length - 1];
        x = last.x;
        y = last.y;
        const prev = path[path.length - 2];
        if (prev) facing = dirOf(prev, last);
      } else {
        const a = path[i];
        const b = path[i + 1];
        const f = t - i;
        x = a.x + (b.x - a.x) * f;
        y = a.y + (b.y - a.y) * f;
        facing = dirOf(a, b);
        frame = [0, 1, 0, 2][Math.floor(now / 130) % 4];
      }
    }
    return { fx: x * T + 8, fy: y * T + 14, facing, frame, x, y };
  }

  nightAmount() {
    const h = this.time.hour + this.time.minute / 60;
    if (h >= 7 && h < 18) return 0;
    if (h >= 18 && h < 21) return (h - 18) / 3;
    if (h >= 5 && h < 7) return 1 - (h - 5) / 2;
    return 1;
  }

  frame() {
    requestAnimationFrame(() => this.frame());
    this.draw();
  }

  draw() {
    if (!this.staticLayer || !this.grid) return;
    const now = performance.now();
    const ctx = this.ctx;
    const p = new Pix(ctx, this.s);
    ctx.drawImage(this.staticLayer, 0, 0);

    const night = this.nightAmount();
    const litRooms = new Set();
    for (const m of this.movers.values()) if (m.human || m.awake) litRooms.add(m.room);

    // depth-sorted furniture and people
    const items = [];
    const sleepers = new Map();
    for (const m of this.movers.values()) {
      if (!m.human && m.awake === false) {
        const bed = this.solid.find((o) => o.kind === 'bed' && m.x >= o.x && m.x < o.x + o.w && m.y >= o.y && m.y < o.y + o.h);
        if (bed) {
          sleepers.set(bed.id, m);
          continue;
        }
      }
      const f = this.feetOf(m, now);
      items.push({ kind: 'mover', m, f, z: f.fy + 0.5 });
    }
    for (const o of this.solid) items.push({ kind: 'obj', o, z: (o.y + o.h) * T - 2 + (o.sit ? -8 : 0) });
    items.sort((a, b) => a.z - b.z);

    for (const it of items) {
      if (it.kind === 'obj') {
        drawObject(p, it.o, now, { sleeper: sleepers.get(it.o.id), night });
      } else {
        const { m, f } = it;
        const blink = this.blinking(m.name, now);
        const asleep = !m.human && m.awake === false;
        const talking = (this.bubbles.get(m.name)?.until ?? 0) > now && !this.bubbles.get(m.name)?.thought;
        drawPerson(p, f.fx, f.fy, m.look, f.facing, f.frame, { asleep, blink, talking });
        if (asleep) drawZzz(p, f.fx, f.fy, now);
      }
    }

    // lighting
    if (night > 0) this.drawNight(ctx, night, litRooms);
    this.drawRoomLabels(ctx);

    // name tags
    ctx.font = `600 ${Math.round(5 * this.s)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const it of items) {
      if (it.kind !== 'mover') continue;
      const { m, f } = it;
      const label = m.human ? `${m.name} · you` : m.name;
      const tw = ctx.measureText(label).width + 4 * this.s;
      const x = f.fx * this.s;
      const y = (f.fy + 4) * this.s;
      const h = 6.5 * this.s;
      ctx.fillStyle = this.hover === m.name || this.focused === m.name ? 'rgba(255,255,255,0.92)' : 'rgba(8,10,14,0.72)';
      ctx.beginPath();
      ctx.roundRect(x - tw / 2, y - h / 2, tw, h, 2 * this.s);
      ctx.fill();
      ctx.fillStyle = this.hover === m.name || this.focused === m.name ? '#111' : m.human ? '#ffd166' : '#fff';
      ctx.fillText(label, x, y + 0.5);
      // colour dot
      ctx.fillStyle = m.color;
      ctx.fillRect(x - tw / 2 - 1.5 * this.s, y - 1.5 * this.s, 3 * this.s, 3 * this.s);
    }
    ctx.textAlign = 'left';

    // speech bubbles follow heads
    for (const [name, b] of this.bubbles) {
      const m = this.movers.get(name);
      if (!m || b.until < now) {
        b.el.classList.remove('show');
        continue;
      }
      const f = this.feetOf(m, now);
      const css = this.toCss(f.fx, f.fy - 20);
      b.el.style.left = `${css.x}px`;
      b.el.style.top = `${css.y}px`;
    }
  }

  blinking(name, now) {
    let b = this.blinks.get(name);
    if (!b) {
      b = { next: now + 1500 + Math.random() * 3000 };
      this.blinks.set(name, b);
    }
    if (now > b.next + 140) {
      b.next = now + 2000 + Math.random() * 3500;
      return false;
    }
    return now > b.next;
  }

  drawNight(ctx, night, litRooms) {
    const s = this.s;
    const g = this.grid;
    const full = 0.55 * night;
    ctx.fillStyle = `rgba(12, 18, 48, ${full})`;
    // walls, fences, doors and outdoor rooms get the full night
    ctx.beginPath();
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        const c = cellAt(g, x, y);
        if (c < 0) ctx.rect(x * T * s, y * T * s, T * s, T * s);
      }
    }
    ctx.fill();
    for (let i = 0; i < this.rooms.length; i++) {
      const r = this.rooms[i];
      const lit = litRooms.has(r.id) && !r.outdoor;
      ctx.fillStyle = r.outdoor ? `rgba(12, 18, 48, ${full})` : lit ? `rgba(40, 30, 20, ${0.18 * night})` : `rgba(12, 18, 48, ${0.5 * night})`;
      ctx.fillRect(r.x * T * s, r.y * T * s, r.w * T * s, r.h * T * s);
      if (lit) {
        const cx = (r.x + r.w / 2) * T * s;
        const cy = (r.y + r.h / 2) * T * s;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(r.w, r.h) * T * s * 0.6);
        grad.addColorStop(0, `rgba(255, 200, 120, ${0.16 * night})`);
        grad.addColorStop(1, 'rgba(255, 200, 120, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(r.x * T * s, r.y * T * s, r.w * T * s, r.h * T * s);
      }
    }
    // lamps, fireplaces and fairy lights glow
    for (const o of this.objects) {
      if (!['lamp', 'fireplace', 'lights'].includes(o.kind)) continue;
      const cx = (o.x + o.w / 2) * T * s;
      const cy = (o.y + o.h / 2) * T * s;
      const rad = (o.kind === 'lights' ? o.w * T * 0.8 : T * 2.4) * s;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      grad.addColorStop(0, `rgba(255, 190, 110, ${0.35 * night})`);
      grad.addColorStop(1, 'rgba(255, 190, 110, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    }
  }
}

function dirOf(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

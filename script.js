// ================================================================
// STATE
// ================================================================
const S = {
  pattern: 'terrain', theme: 'light',
  inverted: false,
  motionOn: true, mode: 'passive',
  movement: 'fixed', spatialX: 0, driftY: 0,
  speed: 0.5, density: 0.5, seed: 5,
  lineColor: '#FFFFFF', canvasBg: '#DFDFDF',
  colorMode: 'normal',          // 'normal' | 'radial'
  radialColorA: '#063BE9',      // radial: center/innermost color
  radialColorB: '#C0D4FF',      // radial: edge/outermost color
  shapes: [],
  mx: -9999, my: -9999, recording: false,
  networkNodes: null, networkNodes3D: null
};

// Base themes — Invert button swaps lc ↔ bg at runtime.
// 'radial' uses a fixed blue→light-blue gradient per line; lc/bg set the canvas+accents.
const THEMES = {
  'light':   { lc: '#FFFFFF', bg: '#DFDFDF' },
  'color-1': { lc: '#063BE9', bg: '#FFFFFF' },
  'color-2': { lc: '#112AAC', bg: '#063BE9' },
  'dark':    { lc: '#292929', bg: '#000000' },
  'radial':  { lc: '#063BE9', bg: '#FFFFFF' },   // accent color; lines use radialColorA/B
};

// Returns true if a hex colour is perceptually light (needs dark panel text)
function isLight(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return (r*299 + g*587 + b*114) / 1000 > 128;
}

// Interpolate between two hex colors. t=0 → colorA, t=1 → colorB.
function lerpColor(colorA, colorB, t) {
  t = Math.max(0, Math.min(1, t));
  const pa = parseInt(colorA.slice(1), 16), pb = parseInt(colorB.slice(1), 16);
  const aR = (pa >> 16) & 0xff, aG = (pa >> 8) & 0xff, aB = pa & 0xff;
  const bR = (pb >> 16) & 0xff, bG = (pb >> 8) & 0xff, bB = pb & 0xff;
  const r = Math.round(aR + (bR - aR) * t);
  const g = Math.round(aG + (bG - aG) * t);
  const b = Math.round(aB + (bB - aB) * t);
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Return the radial value (0..1) stored on a path object, or null if not in radial mode.
// 0 = center/innermost/high → radialColorA (blue); 1 = edge/outermost/low → radialColorB (light).
function pathRadialVal(p) {
  if (S.colorMode !== 'radial') return null;
  if (S.pattern === 'terrain')  return p.terrainVal      ?? null;
  if (S.pattern === 'pathways') return p.bundleVal       ?? null;
  if (S.pattern === 'city')     return p.cityColorVal    ?? null;
  if (S.pattern === 'networks') return p.networkColorVal ?? null;
  return null;
}

// Central theme applicator — handles inversion and panel colour switching.
// Three panel states:
//   menu-light → black ink  (Light Mode — both normal and inverted)
//   menu-blue  → blue ink   (Color Mode 1 — normal / non-inverted only)
//   [neither]  → white ink  (Color Mode 1 inverted, Color Mode 2 both, Dark Mode both)
function applyTheme(key, inverted) {
  const base = THEMES[key];
  const lc = inverted ? base.bg : base.lc;
  const bg = inverted ? base.lc : base.bg;
  S.theme = key; S.inverted = inverted;
  S.lineColor = lc; S.canvasBg = bg;
  document.documentElement.style.setProperty('--line-color', lc);

  if (key === 'radial') {
    S.colorMode = 'radial';
    // Normal: blue center/high → light-blue edge/low
    // Inverted: light-blue center/high → blue edge/low (on blue background)
    S.radialColorA = inverted ? '#FFFFFF' : '#063BE9';
    S.radialColorB = inverted ? '#3A60F0' : '#C0D4FF';
  } else {
    S.colorMode = 'normal';
  }

  const isMenuLight = (key === 'light');
  const isMenuBlue  = (key === 'color-1' && !inverted) || (key === 'radial' && !inverted);
  document.body.classList.toggle('menu-light', isMenuLight);
  document.body.classList.toggle('menu-blue',  isMenuBlue);
}

// ================================================================
// SEEDED RANDOM & UTILITY
// ================================================================
function mkRand(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
}

// ================================================================
// MODULAR ARCHITECTURE — GEO UTILITIES & PATTERN GENERATORS
// ================================================================

/**
 * GEO — Shared geometric utilities for all pattern types
 */
const GEO = {
  /**
   * PERLIN NOISE & FRACTAL BROWNIAN MOTION (fBm)
   *
   * Phase 1 improvement: Replace value noise with proper multi-octave Perlin noise
   * Provides stable, fractal-like scalar fields with design-quality output
   */

  /**
   * Fixed gradient vectors for 2D Perlin noise (improves coherence vs random gradients)
   */
  _gradients: [
    {x: 1, y: 0}, {x: -1, y: 0}, {x: 0, y: 1}, {x: 0, y: -1},
    {x: 1, y: 1}, {x: 1, y: -1}, {x: -1, y: 1}, {x: -1, y: -1},
    {x: 2, y: 1}, {x: 2, y: -1}, {x: -2, y: 1}, {x: -2, y: -1},
    {x: 1, y: 2}, {x: 1, y: -2}, {x: -1, y: 2}, {x: -1, y: -2}
  ],

  /**
   * Generate deterministic permutation table from seed.
   * Results are cached by seed — each unique seed generates its table once.
   */
  _permCache: new Map(),

  _permute: function(seed) {
    if (this._permCache.has(seed)) return this._permCache.get(seed);
    const perm = [];
    for (let i = 0; i < 256; i++) perm[i] = i;
    const rng = mkRand(seed);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    this._permCache.set(seed, perm);
    return perm;
  },

  /**
   * Core Perlin noise implementation shared by both standard and tileable variants.
   * pW / pH control the lattice period — use 256 for standard (non-tileable) noise,
   * or a smaller integer for seamless tiling at that period.
   */
  _perlinCore: function(x, y, pW, pH, seed) {
    const perm  = this._permute(seed);
    const grads = this._gradients;
    const fade  = t => t * t * t * (t * (t * 6 - 15) + 10);
    const lerp  = (t, a, b) => a + t * (b - a);
    const xi = Math.floor(x) | 0, yi = Math.floor(y) | 0;
    const xf = x - xi,            yf = y - yi;
    const xi0 = ((xi % pW) + pW) % pW, xi1 = (xi0 + 1) % pW;
    const yi0 = ((yi % pH) + pH) % pH, yi1 = (yi0 + 1) % pH;
    const gi00 = perm[(perm[xi0 & 255] + yi0) & 255] & 15;
    const gi10 = perm[(perm[xi1 & 255] + yi0) & 255] & 15;
    const gi01 = perm[(perm[xi0 & 255] + yi1) & 255] & 15;
    const gi11 = perm[(perm[xi1 & 255] + yi1) & 255] & 15;
    const g00  = grads[gi00].x * xf       + grads[gi00].y * yf;
    const g10  = grads[gi10].x * (xf - 1) + grads[gi10].y * yf;
    const g01  = grads[gi01].x * xf       + grads[gi01].y * (yf - 1);
    const g11  = grads[gi11].x * (xf - 1) + grads[gi11].y * (yf - 1);
    const u = fade(xf), v = fade(yf);
    return Math.max(-0.95, Math.min(0.95, lerp(v, lerp(u, g00, g10), lerp(u, g01, g11)))) / 0.95;
  },

  /** Standard (non-tileable) Perlin noise — delegates to _perlinCore with period 256 */
  perlinNoise: function(x, y, seed) {
    return this._perlinCore(x, y, 256, 256, seed);
  },

  /**
   * Fractal Brownian Motion: Multi-octave noise for natural-looking variation
   *
   * Design principle: Balance detail with clarity. Too many octaves = noise. Too few = smooth.
   * Output range: [-1, 1] with stable distribution for marching squares
   */
  fBm: function(x, y, seed, octaves = 3, persistence = 0.5, lacunarity = 2.0) {
    let amplitude = 1;
    let frequency = 1;
    let result = 0;
    let maxAmplitude = 0;

    const rng = mkRand(seed * 13);
    const baseFreq = 0.01; // Tunable: controls overall scale

    for (let i = 0; i < octaves; i++) {
      // Vary seed per octave for visual interest while maintaining determinism
      const octaveSeed = seed + i * 1000;
      result += amplitude * this.perlinNoise(
        x * baseFreq * frequency,
        y * baseFreq * frequency,
        octaveSeed
      );
      maxAmplitude += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }

    // Normalize to [-1, 1] range
    return maxAmplitude > 0 ? result / maxAmplitude : 0;
  },

  /** Tileable Perlin noise — delegates to _perlinCore with explicit lattice period */
  perlinNoiseTileable: function(x, y, pW, pH, seed) {
    return this._perlinCore(x, y, pW, pH, seed);
  },

  // fBmTileable(px, py, Wp, Hp, seed, octaves, persistence, lacunarity):
  //   Fractal Brownian Motion that tiles seamlessly at canvas dimensions Wp × Hp.
  //   CELLS = 2 base cells per dimension gives large-scale character matching
  //   the existing terrain while guaranteeing zero seam at canvas boundaries.
  fBmTileable: function(px, py, Wp, Hp, seed, octaves = 3, persistence = 0.5, lacunarity = 2.0) {
    const CELLS = 2;  // 2 primary undulations per canvas width — preserves existing scale
    let amp = 1, freq = 1, val = 0, maxAmp = 0;
    for (let i = 0; i < octaves; i++) {
      const c = Math.round(CELLS * freq);  // integer cell count — period stays exact
      val   += amp * this.perlinNoiseTileable(px * c / Wp, py * c / Hp, c, c, seed + i * 1000);
      maxAmp += amp;
      amp   *= persistence;
      freq  *= lacunarity;
    }
    return maxAmp > 0 ? val / maxAmp : 0;
  },

  /**
   * Marching Squares: Extract contour lines from a scalar field
   */
  marchingSquares: function(grid, COLS, ROWS, cellW, cellH, level) {
    const MS = [
      [], [[3,2]], [[1,2]], [[3,1]], [[0,1]],
      [[0,1],[3,2]], [[0,2]], [[0,3]], [[0,3]],
      [[0,2]], [[0,3],[1,2]], [[0,1]], [[3,1]],
      [[1,2]], [[3,2]], []
    ];

    const ePt = (edge, col, row) => {
      if (edge === 0) { const v0=grid[row][col],v1=grid[row][col+1]; return {x:(col+(level-v0)/(v1-v0))*cellW, y:row*cellH}; }
      if (edge === 1) { const v0=grid[row][col+1],v1=grid[row+1][col+1]; return {x:(col+1)*cellW, y:(row+(level-v0)/(v1-v0))*cellH}; }
      if (edge === 2) { const v0=grid[row+1][col],v1=grid[row+1][col+1]; return {x:(col+(level-v0)/(v1-v0))*cellW, y:(row+1)*cellH}; }
      /* edge 3 */ const v0=grid[row][col],v1=grid[row+1][col]; return {x:col*cellW, y:(row+(level-v0)/(v1-v0))*cellH};
    };

    const segs = [];
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const idx = (grid[row][col]>level?8:0)|(grid[row][col+1]>level?4:0)|
                    (grid[row+1][col+1]>level?2:0)|(grid[row+1][col]>level?1:0);
        for (const [e0,e1] of MS[idx]) {
          const p0=ePt(e0,col,row), p1=ePt(e1,col,row);
          segs.push({x1:p0.x,y1:p0.y,x2:p1.x,y2:p1.y});
        }
      }
    }
    return segs;
  },

  /**
   * Chain segments into polylines via endpoint adjacency
   */
  chainSegments: function(segs) {
    const pk = (x,y) => (Math.round(x*8)|0)+'_'+(Math.round(y*8)|0);
    const adj = new Map();
    for (let i = 0; i < segs.length; i++) {
      const s=segs[i], k1=pk(s.x1,s.y1), k2=pk(s.x2,s.y2);
      if(!adj.has(k1))adj.set(k1,[]); if(!adj.has(k2))adj.set(k2,[]);
      adj.get(k1).push({idx:i,end:0}); adj.get(k2).push({idx:i,end:1});
    }
    const used = new Uint8Array(segs.length);
    const chains = [];
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const s = segs[i];
      const chain = [{x:s.x1,y:s.y1},{x:s.x2,y:s.y2}];
      for (const front of [false, true]) {
        for (;;) {
          const p = front ? chain[0] : chain[chain.length-1];
          const nbrs = adj.get(pk(p.x,p.y));
          let found = false;
          if (nbrs) for (const nb of nbrs) {
            if (used[nb.idx]) continue;
            used[nb.idx] = 1;
            const ns = segs[nb.idx];
            const pt = nb.end===0 ? {x:ns.x2,y:ns.y2} : {x:ns.x1,y:ns.y1};
            front ? chain.unshift(pt) : chain.push(pt);
            found = true; break;
          }
          if (!found) break;
        }
      }
      if (chain.length >= 3) chains.push(chain);
    }
    return chains;
  },

  /**
   * Smooth a polyline using Catmull-Rom spline interpolation.
   * steps controls subdivision density (8 = high quality, 4 = lighter weight).
   */
  smoothCatmullRom: function(pts, tension = 0.5, steps = 8) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = i === 0 ? pts[0] : pts[i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = i + 2 < pts.length ? pts[i + 2] : p2;

      for (let t = 1; t <= steps; t++) {
        const u = t / steps;
        const u2 = u * u, u3 = u2 * u;

        const c0 = -tension * u3 + 2 * tension * u2 - tension * u;
        const c1 = (2 - tension) * u3 + (tension - 3) * u2 + 1;
        const c2 = (tension - 2) * u3 + (3 - 2 * tension) * u2 + tension * u;
        const c3 = tension * u3 - tension * u2;

        out.push({
          x: c0 * p0.x + c1 * p1.x + c2 * p2.x + c3 * p3.x,
          y: c0 * p0.y + c1 * p1.y + c2 * p2.y + c3 * p3.y
        });
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  },

  /**
   * Orthogonal routing with safe quarter-circle corners
   */
  flattenOrthogonal: function(waypoints, rad) {
    const flat = [];
    const n = waypoints.length;
    if (n < 2) return flat;
    const STEP = 4, ARC_STEPS = 24;

    const segs = [];
    for (let i = 0; i < n - 1; i++) {
      const a = waypoints[i], b = waypoints[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.001) continue;
      const ux = dx / len, uy = dy / len;
      const trimS = (i > 0)     ? rad : 0;
      const trimE = (i < n - 2) ? rad : 0;
      segs.push({
        sx: a.x + ux * trimS, sy: a.y + uy * trimS,
        ex: b.x - ux * trimE, ey: b.y - uy * trimE,
        ux, uy, trimE
      });
    }
    if (!segs.length) return flat;

    flat.push({ x: segs[0].sx, y: segs[0].sy });
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const lineLen = Math.hypot(s.ex - s.sx, s.ey - s.sy);
      const steps = Math.max(1, Math.ceil(lineLen / STEP));
      for (let j = 1; j <= steps; j++) {
        const t = j / steps;
        flat.push({ x: s.sx + (s.ex - s.sx) * t, y: s.sy + (s.ey - s.sy) * t });
      }
      if (i < segs.length - 1) {
        const next = segs[i + 1];
        const cross = s.ux * next.uy - s.uy * next.ux;
        const px = cross > 0 ? -s.uy :  s.uy;
        const py = cross > 0 ?  s.ux : -s.ux;
        const arcCx = s.ex + px * rad;
        const arcCy = s.ey + py * rad;
        const fromA = Math.atan2(s.ey - arcCy, s.ex - arcCx);
        const toA   = Math.atan2(next.sy - arcCy, next.sx - arcCx);
        let da = toA - fromA;
        if (da > Math.PI)  da -= Math.PI * 2;
        if (da < -Math.PI) da += Math.PI * 2;
        for (let j = 1; j <= ARC_STEPS; j++) {
          const a = fromA + da * j / ARC_STEPS;
          flat.push({ x: arcCx + rad * Math.cos(a), y: arcCy + rad * Math.sin(a) });
        }
      }
    }
    return flat;
  },

  /**
   * Distance between two points
   */
  dist: (a, b) => Math.hypot(b.x - a.x, b.y - a.y),

  /**
   * Vector length
   */
  len: (v) => Math.hypot(v.x, v.y),

  /**
   * Normalize vector
   */
  norm: (v) => {
    const l = Math.hypot(v.x, v.y);
    return l > 0.001 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
  },

  /**
   * Perpendicular vector (rotate 90° CCW)
   */
  perp: (v) => ({ x: -v.y, y: v.x }),

  /**
   * Rotate vector by angle (radians)
   */
  rotateVec: (v, angle) => ({
    x: v.x * Math.cos(angle) - v.y * Math.sin(angle),
    y: v.x * Math.sin(angle) + v.y * Math.cos(angle)
  }),

  /**
   * Flow field: angle at each point derived from noise
   * Used for Pathways to steer routes naturally
   */
  flowAngle: function(x, y, scale, seed) {
    // Use fBm for flow field direction (more coherent than single-octave noise)
    const nx = GEO.fBm(x * scale * 0.001, y * scale * 0.001, seed, 2, 0.5, 2.0);
    return (nx * 2 - 1) * Math.PI * 2;
  },

  /**
   * Direction vector from angle
   */
  angleToDir: (angle) => ({ x: Math.cos(angle), y: Math.sin(angle) }),

  /**
   * Polygon clipping helper: point-in-rect
   */
  pointInRect: (p, rx, ry, rw, rh) => (
    p.x >= rx && p.x <= rx + rw && p.y >= ry && p.y <= ry + rh
  ),

  /**
   * PHASE 3: Simple line intersection detection for street graphs
   */
  lineIntersection: function(p1, p2, p3, p4) {
    const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
    const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;

    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 0.001) return null;

    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), t, u };
    }
    return null;
  },

  /**
   * PHASE 4: Delaunay triangulation via incremental insertion
   * Returns array of edges suitable for network visualization
   */
  delaunayTriangulate: function(points) {
    if (points.length < 3) return [];

    // Super-triangle: large triangle enclosing all points
    const margin = 10000;
    const st = [
      { x: -margin, y: -margin, id: -1 },
      { x: margin, y: -margin, id: -2 },
      { x: 0, y: margin, id: -3 }
    ];

    const triangles = [[0, 1, 2].map((i, idx) => st[i])];

    // Incremental insertion
    for (let pi = 0; pi < points.length; pi++) {
      const p = { ...points[pi], id: pi };
      const polygon = [];

      // Find all triangles whose circumcircle contains p
      for (let ti = triangles.length - 1; ti >= 0; ti--) {
        const tri = triangles[ti];
        const cc = this._circumcircle(tri[0], tri[1], tri[2]);
        const d = Math.hypot(p.x - cc.x, p.y - cc.y);

        if (d < cc.r) {
          polygon.push([tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]);
          triangles.splice(ti, 1);
        }
      }

      // Remove duplicate edges from polygon
      for (let i = polygon.length - 1; i >= 0; i--) {
        for (let j = i - 1; j >= 0; j--) {
          if ((polygon[i][0] === polygon[j][0] && polygon[i][1] === polygon[j][1]) ||
              (polygon[i][0] === polygon[j][1] && polygon[i][1] === polygon[j][0])) {
            polygon.splice(i, 1);
            polygon.splice(j, 1);
            i--;
            break;
          }
        }
      }

      // Create new triangles
      for (const [a, b] of polygon) {
        triangles.push([a, b, p]);
      }
    }

    // Extract edges (exclude super-triangle)
    const edges = [];
    const seen = new Set();
    for (const tri of triangles) {
      if (tri[0].id >= 0 && tri[1].id >= 0 && tri[2].id >= 0) {
        for (let i = 0; i < 3; i++) {
          const a = tri[i], b = tri[(i + 1) % 3];
          if (a.id >= 0 && b.id >= 0) {
            const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
            if (!seen.has(key)) {
              seen.add(key);
              edges.push([a, b]);
            }
          }
        }
      }
    }

    return edges;
  },

  /**
   * Helper: Circumcircle of three points
   */
  _circumcircle: function(p0, p1, p2) {
    const ax = p0.x, ay = p0.y;
    const bx = p1.x, by = p1.y;
    const cx = p2.x, cy = p2.y;

    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-10) return { x: 0, y: 0, r: 1e10 };

    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    const r = Math.hypot(ax - ux, ay - uy);

    return { x: ux, y: uy, r: r + 0.01 };
  },

  /**
   * PHASE 5: Trace path along vector field (continuous flow-based routing)
   */
  traceFlowPath: function(startX, startY, fieldFn, maxSteps = 200, stepSize = 4) {
    const path = [{ x: startX, y: startY }];
    let x = startX, y = startY;
    const visited = new Set();

    for (let step = 0; step < maxSteps; step++) {
      const angle = fieldFn(x, y);
      const nx = x + Math.cos(angle) * stepSize;
      const ny = y + Math.sin(angle) * stepSize;

      // Boundary check
      if (nx < -20 || nx > W + 20 || ny < -20 || ny > H + 20) break;

      // Loop detection
      const key = Math.round(nx / 10) + ',' + Math.round(ny / 10);
      if (visited.has(key)) break;
      visited.add(key);

      path.push({ x: nx, y: ny });
      x = nx;
      y = ny;
    }

    return path;
  },

  /**
   * NEW: Compute unit normals at each point along a polyline
   * Used for creating corridor bundles via perpendicular offsets
   */
  computeNormals: function(pts) {
    const normals = [];
    const n = pts.length;

    for (let i = 0; i < n; i++) {
      const prev = pts[i > 0 ? i - 1 : i];
      const next = pts[i < n - 1 ? i + 1 : i];

      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const len = Math.hypot(dx, dy);

      if (len > 0.001) {
        // Perpendicular (rotated 90° CCW)
        normals.push({ x: -dy / len, y: dx / len });
      } else {
        normals.push(normals.length > 0 ? normals[normals.length - 1] : { x: 0, y: 1 });
      }
    }

    return normals;
  },

  /**
   * NEW: Create parallel offset polyline via normal-based offsets
   * Maintains consistent spacing along the entire curve
   */
  offsetPolyline: function(pts, distance) {
    const normals = this.computeNormals(pts);
    return pts.map((p, i) => ({
      x: p.x + normals[i].x * distance,
      y: p.y + normals[i].y * distance
    }));
  },

  /**
   * PHASE 3: Build street graph from horizontal and vertical paths
   * Detects intersections, creates vertex/edge structure for planar graph
   */
  buildStreetGraph: function(hPaths, vPaths) {
    const SNAP_DIST = 2;  // Intersection snapping tolerance
    const vertices = [];
    const edges = [];
    const vMap = new Map();  // Key: "x,y" → vertex index

    // Helper: get or create vertex
    const getVertex = (x, y) => {
      const key = Math.round(x * 10) + ',' + Math.round(y * 10);
      if (vMap.has(key)) return vMap.get(key);
      const idx = vertices.length;
      vertices.push({ x, y, key });
      vMap.set(key, idx);
      return idx;
    };

    // Helper: check if point is on segment
    const pointOnSegment = (p, s1, s2) => {
      const dx = s2.x - s1.x, dy = s2.y - s1.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 0.001) return false;
      let t = ((p.x - s1.x) * dx + (p.y - s1.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const closest = { x: s1.x + t * dx, y: s1.y + t * dy };
      return Math.hypot(p.x - closest.x, p.y - closest.y) < SNAP_DIST;
    };

    // Helper: subdivide polyline at intersections
    const subdivideAtIntersections = (path, otherPaths) => {
      const points = [...path];
      let modified = true;
      while (modified) {
        modified = false;
        for (let i = 0; i < points.length - 1; i++) {
          const p1 = points[i], p2 = points[i + 1];
          for (const otherPath of otherPaths) {
            for (let j = 0; j < otherPath.length - 1; j++) {
              const p3 = otherPath[j], p4 = otherPath[j + 1];
              const isect = this.lineIntersection(p1, p2, p3, p4);
              if (isect && Math.abs(isect.t) > 0.01 && Math.abs(isect.t - 1) > 0.01) {
                points.splice(i + 1, 0, isect);
                modified = true;
                break;
              }
            }
            if (modified) break;
          }
          if (modified) break;
        }
      }
      return points;
    };

    // Subdivide all paths at intersections
    const allHPaths = hPaths.map(p => subdivideAtIntersections(p, vPaths));
    const allVPaths = vPaths.map(p => subdivideAtIntersections(p, hPaths));

    // Create vertices from all path points
    for (const path of [...allHPaths, ...allVPaths]) {
      for (const pt of path) {
        getVertex(pt.x, pt.y);
      }
    }

    // Create edges from path segments
    const edgeSet = new Set();
    const addEdge = (v0, v1) => {
      if (v0 === v1) return;
      const key = v0 < v1 ? `${v0}-${v1}` : `${v1}-${v0}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push([v0, v1]);
      }
    };

    for (const path of [...allHPaths, ...allVPaths]) {
      for (let i = 0; i < path.length - 1; i++) {
        const v0 = getVertex(path[i].x, path[i].y);
        const v1 = getVertex(path[i + 1].x, path[i + 1].y);
        addEdge(v0, v1);
      }
    }

    return { vertices, edges };
  },

  /**
   * PHASE 3: Extract faces (closed blocks) from planar street graph
   * Uses planar graph face finding (traversal-based cycle extraction)
   */
  extractFaces: function(graph) {
    const { vertices, edges } = graph;
    const faces = [];

    // Build adjacency with angle-sorted neighbors for CCW traversal
    const adj = new Map();
    for (let i = 0; i < vertices.length; i++) {
      adj.set(i, []);
    }

    for (const [v0, v1] of edges) {
      adj.get(v0).push(v1);
      adj.get(v1).push(v0);
    }

    // Sort neighbors by angle for consistent CCW traversal
    for (let v = 0; v < vertices.length; v++) {
      const nbrs = adj.get(v);
      const pos = vertices[v];
      nbrs.sort((a, b) => {
        const angleA = Math.atan2(vertices[a].y - pos.y, vertices[a].x - pos.x);
        const angleB = Math.atan2(vertices[b].y - pos.y, vertices[b].x - pos.x);
        return angleA - angleB;
      });
    }

    // Track used edges (directed)
    const usedEdges = new Set();

    // Extract cycles via CCW traversal
    for (let startV = 0; startV < vertices.length; startV++) {
      const nbrs = adj.get(startV);
      for (const nextV of nbrs) {
        const edgeKey = `${startV}-${nextV}`;
        if (usedEdges.has(edgeKey)) continue;

        // Trace cycle starting from this directed edge
        const cycle = [startV];
        let currentV = nextV;
        let prevV = startV;

        for (let steps = 0; steps < vertices.length + 10; steps++) {
          if (currentV === startV) {
            // Cycle closed
            if (cycle.length >= 3) {
              // Convert vertex indices to coordinates
              const faceCoords = cycle.map(v => vertices[v]);
              // Compute signed area to check CCW orientation
              let area = 0;
              for (let i = 0; i < faceCoords.length; i++) {
                const p0 = faceCoords[i];
                const p1 = faceCoords[(i + 1) % faceCoords.length];
                area += (p1.x - p0.x) * (p1.y + p0.y);
              }
              if (Math.abs(area) > 1) {  // Only keep non-degenerate faces
                faces.push(faceCoords);
              }
            }
            break;
          }

          cycle.push(currentV);
          usedEdges.add(`${prevV}-${currentV}`);

          // Get next edge via CCW traversal
          const nbrs = adj.get(currentV);
          const prevIdx = nbrs.indexOf(prevV);
          if (prevIdx === -1) break;
          const nextIdx = (prevIdx + 1) % nbrs.length;
          const nextV = nbrs[nextIdx];

          prevV = currentV;
          currentV = nextV;
        }
      }
    }

    // Filter degenerate and tiny faces
    return faces.filter(face => {
      let area = 0;
      for (let i = 0; i < face.length; i++) {
        const p0 = face[i];
        const p1 = face[(i + 1) % face.length];
        area += (p1.x - p0.x) * (p1.y + p0.y);
      }
      area = Math.abs(area) / 2;
      return area > 50;  // Minimum block area threshold
    });
  }
};

// ================================================================
// CANVAS SETUP
// ================================================================
const cv = document.getElementById('pattern-canvas');
const cx = cv.getContext('2d');
const stage = document.getElementById('stage');
let W, H;

function resize() {
  if (S.recording) return;   // never interrupt an active video export
  W = cv.width  = window.innerWidth;
  H = cv.height = window.innerHeight;
  rebuild();
}
window.addEventListener('resize', resize);

// ================================================================
// PATTERN GENERATORS — MODULAR ARCHITECTURE
// ================================================================
let paths = [];
let canonicalOff = null; // Offsets captured right after rebuild — shared frame-0 reference for all export clips

/**
 * TERRAIN GENERATOR
 * Generates topographic contour patterns using scalar field + marching squares
 */
function buildTerrain(r, n) {
  // ── PHASE 2 IMPROVEMENT: Replace Gaussian features with fBm scalar field ──
  // Structure layer: fractal Brownian motion creates natural multi-scale variation
  // Design goal: Large continuous regions with nested hierarchy, minimal micro-noise

  const seed = Math.floor(r() * 10000);
  const tiltX = (r() - 0.5) * 1.6;  // Global directional bias
  const tiltY = (r() - 0.5) * 1.2;

  // Adaptive octave count based on density (more detail at higher density)
  const octaves = Math.max(2, Math.min(4, Math.floor(1.5 + n * 1.5)));
  const persistence = 0.5 + r() * 0.2;  // Vary amplitude falloff per seed
  const lacunarity = 1.8 + r() * 0.4;   // Vary frequency scaling

  // Height function: seamlessly tileable via cross-fade blend.
  // Evaluates the original fBm at four periodic neighbours and blends with smoothstep
  // weights so the field is identical at x=0/x=W and y=0/y=H — zero seam for sphere
  // wrapping and tiled exports. Density is unchanged from the original.
  function hAt(x, y) {
    const mx = ((x % W) + W) % W;
    const my = ((y % H) + H) % H;
    const ax = (u => u * u * (3 - 2 * u))(mx / W);  // smoothstep → 0 at edges
    const ay = (u => u * u * (3 - 2 * u))(my / H);

    function base(rx, ry) {
      const nx = rx / Math.max(W, H), ny = ry / Math.max(W, H);
      let v = GEO.fBm(nx * 100, ny * 100, seed, octaves, persistence, lacunarity);
      v = v * 0.8 + 0.3 * Math.sin(nx * Math.PI * 2) * Math.cos(ny * Math.PI * 2) * 0.2;
      return v + tiltX * (nx - 0.5) + tiltY * (ny - 0.5);
    }

    return base(mx,     my    ) * (1 - ax) * (1 - ay)
         + base(mx - W, my    ) * ax       * (1 - ay)
         + base(mx,     my - H) * (1 - ax) * ay
         + base(mx - W, my - H) * ax       * ay;
  }

  // ── 2. Sample grid at resolution tuned for fBm complexity ─────
  // Extend grid 200 px beyond every canvas edge so spatial drift never
  // reveals an empty border.  marchingSquares outputs coords starting at
  // (0,0), so we offset each segment back by BLEED after generation.
  const BLEED_T = 200;
  const COLS = 130, ROWS = Math.round(COLS * (H + BLEED_T * 2) / (W + BLEED_T * 2)) | 0;
  const cw = (W + BLEED_T * 2) / COLS, ch = (H + BLEED_T * 2) / ROWS;
  const grid = [];
  let hMin = Infinity, hMax = -Infinity;

  for (let row = 0; row <= ROWS; row++) {
    grid[row] = new Float32Array(COLS + 1);
    for (let col = 0; col <= COLS; col++) {
      const v = hAt(-BLEED_T + col * cw, -BLEED_T + row * ch);
      grid[row][col] = v;
      if (v < hMin) hMin = v; if (v > hMax) hMax = v;
    }
  }

  // ── 3. Marching squares: Extract contour hierarchy ───────────
  const numLevels = Math.floor(6 + n * 0.6);
  const mg = (hMax - hMin) * 0.05;

  for (let li = 1; li <= numLevels; li++) {
    const level = hMin + mg + (li / (numLevels + 1)) * (hMax - hMin - mg * 2);
    const segs = GEO.marchingSquares(grid, COLS, ROWS, cw, ch, level);
    // Shift from grid-space [0..W+2*BLEED_T] back to world-space [-BLEED_T..W+BLEED_T]
    segs.forEach(s => { s.x1 -= BLEED_T; s.y1 -= BLEED_T; s.x2 -= BLEED_T; s.y2 -= BLEED_T; });
    const chains = GEO.chainSegments(segs);

    for (const chain of chains) {
      if (chain.length >= 8) {
        // Store raw chain as pts (used by splitPathAtShapes when shapes are present).
        // Pre-compute flattenPath output as flat for direct rendering — flattenPath's
        // conservative midpoint-bezier avoids the overshoots Catmull-Rom can produce
        // at tight bends, which caused the bar ribbon to break visually.
        const flat = flattenPath(chain);
        // radialVal: innermost/highest contour (li=numLevels) → 0 (blue),
        //            outermost/lowest (li=1) → 1 (light). Matches topo-map convention.
        const terrainVal = numLevels > 1 ? 1 - (li - 1) / (numLevels - 1) : 0;
        paths.push({ pts: chain, flat, off: r() * UNIT * 4, sp: 0.15 + r() * 0.15, terrainVal });
      }
    }
  }
}

/**
 * PATHWAYS GENERATOR — ENHANCED WITH FLOW FIELD
 * Generates circulation routes steered by flow field + non-crossing orthogonal structure
 * DESIGN: Flow field provides direction influence; segment registry prevents crossing
 */
function buildPathways(r, n) {
  /**
   * PATHWAYS GENERATOR — PARALLEL LINE BUNDLES WITH EXACT ARC GEOMETRY
   *
   * Each corridor is an orthogonal route (straight or L-shaped).
   * Each route spawns a bundle of parallel lines.
   * At corners, every line in the bundle uses a proportional arc radius:
   *   inner lines → smaller radius, outer lines → larger radius.
   * All parallel arcs share the same center point (geometric property of parallel offsets).
   */

  const seed = Math.floor(r() * 10000);
  const rng  = mkRand(seed);

  const linesPerBundle = Math.max(6, Math.floor(6 + n * 0.27));  // 6–15 lines
  const lineSpacing    = 20;    // px gap between consecutive lines in a bundle
  const baseRadius     = 160;   // corner-arc radius for the trunk center line (large for smooth rounded turns)
  const bleed          = 200;   // extend well beyond canvas edges (covers spatial drift)
  const ARC_STEPS      = 24;    // arc sample resolution

  // ── Trunk route factory ─────────────────────────────────────────────────
  // Four L-shaped corridors, one per canvas corner, with bundle repulsion.

  // ── Line intersection helper ────────────────────────────────────────────
  function lineIsect(p1x, p1y, d1x, d1y, p2x, p2y, d2x, d2y) {
    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < 1e-8) return { x: p1x, y: p1y };
    const t = ((p2x - p1x) * d2y - (p2y - p1y) * d2x) / cross;
    return { x: p1x + d1x * t, y: p1y + d1y * t };
  }

  // ── Trace one offset line along a trunk path ────────────────────────────
  // lineOffset: signed perpendicular distance from trunk center.
  // Positive = left of direction of travel; negative = right.
  function traceOffsetLine(waypoints, lineOffset) {
    if (waypoints.length < 2) return [];

    // Build normalised segment descriptors
    const segs = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i], b = waypoints[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const ux = dx / len, uy = dy / len;
      const nx = -uy, ny = ux;   // left-perpendicular
      segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, ux, uy, nx, ny });
    }
    if (!segs.length) return [];

    // Pre-compute arc info at each interior corner
    const arcInfos = [];
    for (let i = 0; i < segs.length - 1; i++) {
      const s1 = segs[i], s2 = segs[i + 1];
      const cross = s1.ux * s2.uy - s1.uy * s2.ux;

      // Arc-center direction (perpendicular to incoming segment, inward)
      const px = cross > 0 ? -s1.uy : s1.uy;
      const py = cross > 0 ?  s1.ux : -s1.ux;

      // Dot of left-perp with arc-center direction determines inner/outer
      const dotPA     = s1.nx * px + s1.ny * py;
      const effectiveR = Math.max(4, baseRadius + lineOffset * (dotPA > 0 ? -1 : 1));

      // For 90° turns tan(45°)=1 → tangentLen = effectiveR; general case:
      const dot12      = Math.max(-1, Math.min(1, s1.ux * s2.ux + s1.uy * s2.uy));
      const tangentLen = effectiveR * Math.tan(Math.acos(dot12) / 2);

      arcInfos.push({ px, py, effectiveR, tangentLen, cross });
    }

    // Pre-compute offset corners (intersection of adjacent offset segments)
    const offsetCorners = [];
    for (let i = 0; i < segs.length - 1; i++) {
      const s1 = segs[i], s2 = segs[i + 1];
      const p1x = s1.bx + s1.nx * lineOffset, p1y = s1.by + s1.ny * lineOffset;
      const p2x = s2.ax + s2.nx * lineOffset, p2y = s2.ay + s2.ny * lineOffset;
      offsetCorners.push(lineIsect(p1x, p1y, s1.ux, s1.uy, p2x, p2y, s2.ux, s2.uy));
    }

    // Emit points: straight segment → arc at corner
    const pts = [];

    for (let i = 0; i < segs.length; i++) {
      const s        = segs[i];
      const trimS    = (i > 0)              ? arcInfos[i - 1].tangentLen : 0;
      const trimE    = (i < segs.length - 1) ? arcInfos[i].tangentLen    : 0;

      // Start of this offset segment
      let sx, sy;
      if (i === 0) {
        sx = s.ax + s.nx * lineOffset;
        sy = s.ay + s.ny * lineOffset;
      } else {
        const oc = offsetCorners[i - 1];
        sx = oc.x + s.ux * trimS;
        sy = oc.y + s.uy * trimS;
      }

      // End of this offset segment
      let ex, ey;
      if (i < segs.length - 1) {
        const oc = offsetCorners[i];
        ex = oc.x - s.ux * trimE;
        ey = oc.y - s.uy * trimE;
      } else {
        ex = s.bx + s.nx * lineOffset;
        ey = s.by + s.ny * lineOffset;
      }

      if (pts.length === 0) pts.push({ x: sx, y: sy });

      // Straight portion
      const segLen = Math.hypot(ex - sx, ey - sy);
      if (segLen > 0.5) {
        const steps = Math.max(1, Math.ceil(segLen / 5));
        for (let j = 1; j <= steps; j++) {
          const t = j / steps;
          pts.push({ x: sx + (ex - sx) * t, y: sy + (ey - sy) * t });
        }
      }

      // Arc at end corner
      if (i < segs.length - 1) {
        const { px, py, effectiveR, tangentLen, cross } = arcInfos[i];

        // Arc center: trimmed end of offset segment + inward direction * effectiveR
        const arcCx = ex + px * effectiveR;
        const arcCy = ey + py * effectiveR;

        // Next segment's trimmed start (from its offset corner)
        const oc     = offsetCorners[i];
        const ns     = segs[i + 1];
        const nextSx = oc.x + ns.ux * tangentLen;
        const nextSy = oc.y + ns.uy * tangentLen;

        let fromA = Math.atan2(ey - arcCy, ex - arcCx);
        let toA   = Math.atan2(nextSy - arcCy, nextSx - arcCx);
        let da    = toA - fromA;
        if (cross > 0  && da < 0) da += Math.PI * 2;  // CCW
        if (cross <= 0 && da > 0) da -= Math.PI * 2;  // CW

        for (let j = 1; j <= ARC_STEPS; j++) {
          const a = fromA + da * j / ARC_STEPS;
          pts.push({ x: arcCx + effectiveR * Math.cos(a), y: arcCy + effectiveR * Math.sin(a) });
        }
      }
    }

    return pts;
  }

  // ── Seed → 5-trunk directional composition ──────────────────────────────
  //
  // Every seed produces exactly 5 L-shaped bundles, each entering from a
  // different edge.  All 11 seeds share the same density, line count and
  // spacing — they differ only in which directions the paths travel.
  //
  // Layouts are derived from two verified base arrangements (A, B) via
  // horizontal / vertical mirror transforms, plus two hand-crafted combos.
  // Mirror transforms preserve the non-crossing property by construction.
  //
  // Non-crossing invariants:
  //   • Each trunk occupies a unique grid column AND row (spacing = step).
  //   • Templates open toward different corners of the canvas.
  //   • Edge-to-edge gap between bundles = lineSpacing (matches intra-bundle).
  //   • Higher density → wider bundles → larger step → bundles push apart.

  const bundleW = (linesPerBundle - 1) * lineSpacing;
  const step    = bundleW + lineSpacing;
  const halfW   = W * 0.5, halfH = H * 0.5;

  // ── 8 L-shaped template directions ────────────────────────────────────────
  const T = [
    (bx,by)=>[{x:bx,     y:-bleed}, {x:bx,y:by},{x:W+bleed,y:by}],       // 0 top→right
    (bx,by)=>[{x:-bleed, y:by},     {x:bx,y:by},{x:bx,     y:H+bleed}],  // 1 left→bottom
    (bx,by)=>[{x:bx,     y:-bleed}, {x:bx,y:by},{x:-bleed, y:by}],       // 2 top→left
    (bx,by)=>[{x:W+bleed,y:by},     {x:bx,y:by},{x:bx,     y:H+bleed}],  // 3 right→bottom
    (bx,by)=>[{x:bx,     y:H+bleed},{x:bx,y:by},{x:W+bleed,y:by}],       // 4 bottom→right
    (bx,by)=>[{x:-bleed, y:by},     {x:bx,y:by},{x:bx,     y:-bleed}],   // 5 left→top
    (bx,by)=>[{x:bx,     y:H+bleed},{x:bx,y:by},{x:-bleed, y:by}],       // 6 bottom→left
    (bx,by)=>[{x:W+bleed,y:by},     {x:bx,y:by},{x:bx,     y:-bleed}],   // 7 right→top
  ];

  // ── 11 non-crossing 5-trunk layouts (one per seed) ────────────────────────
  //
  // Each layout places 5 L-shaped trunks on unique grid (col, row) positions.
  // Templates (t) determine which two edges the L connects.
  // Designed for maximum visual variety — NOT simple mirrors of each other.
  //
  //  seed  character           dominant flow
  //  ────  ──────────────────  ──────────────────────────────
  //   0    diagonal sweep NW   top-left corners, paths fan SE
  //   1    horizontal cross    left/right dominant, vertical center
  //   2    vertical cascade    top/bottom dominant, horizontal center
  //   3    pinwheel CW         each path rotates clockwise around center
  //   4    scattered radial    paths radiate outward from different zones
  //   5    balanced cross  ★   left↔top / right↔bottom cross pattern
  //   6    asymmetric cluster  tight upper group + wide lower spread
  //   7    diagonal sweep SE   bottom-right corners, paths fan NW
  //   8    staggered columns   vertical paths offset like brickwork
  //   9    converging arrows   paths aim toward center from edges
  //  10    wide frame          paths trace the outer perimeter zone

  const LAYOUTS = [
    // 0  — diagonal NW sweep: paths fan from top-left quadrant
    [{t:0,c:-2,r:-2},{t:2,c:-1,r:-1},{t:5,c: 1,r: 0},{t:1,c: 0,r: 1},{t:4,c: 2,r: 2}],
    // 1  — horizontal cross: left/right entries with vertical bridge
    [{t:1,c:-2,r:-1},{t:7,c: 2,r:-2},{t:0,c: 0,r: 0},{t:3,c: 2,r: 1},{t:6,c:-1,r: 2}],
    // 2  — vertical cascade: top/bottom dominant flow
    [{t:0,c:-1,r:-2},{t:4,c: 1,r: 2},{t:2,c: 0,r: 0},{t:3,c: 2,r:-1},{t:5,c:-2,r: 1}],
    // 3  — pinwheel CW: each path rotates around center
    [{t:0,c: 1,r:-2},{t:3,c: 2,r: 1},{t:4,c:-1,r: 2},{t:5,c:-2,r:-1},{t:7,c: 0,r: 0}],
    // 4  — scattered radial: paths from different zones
    [{t:2,c:-2,r:-2},{t:7,c: 2,r:-1},{t:1,c:-1,r: 1},{t:4,c: 1,r: 2},{t:0,c: 0,r: 0}],
    // 5  — base B  ★ user's favourite
    [{t:5,c:-1,r:-2},{t:3,c: 1,r: 2},{t:7,c: 2,r:-1},{t:6,c:-2,r: 1},{t:1,c:0,r:0}],
    // 6  — asymmetric cluster: tight top + wide bottom spread
    [{t:5,c: 0,r:-2},{t:2,c:-1,r:-1},{t:7,c: 2,r: 0},{t:6,c:-2,r: 1},{t:4,c: 1,r: 2}],
    // 7  — diagonal SE sweep: paths fan from bottom-right quadrant
    [{t:4,c: 2,r: 2},{t:6,c: 1,r: 1},{t:7,c:-1,r: 0},{t:3,c: 0,r:-1},{t:0,c:-2,r:-2}],
    // 8  — staggered columns: vertical paths offset like bricks
    [{t:0,c:-2,r:-1},{t:4,c:-1,r: 2},{t:2,c: 0,r:-2},{t:0,c: 1,r: 1},{t:6,c: 2,r: 0}],
    // 9  — converging arrows: paths aim toward center from edges
    [{t:0,c:-1,r:-2},{t:1,c:-2,r: 1},{t:7,c: 2,r:-1},{t:4,c: 1,r: 2},{t:3,c: 0,r: 0}],
    // 10 — wide frame: paths trace the outer perimeter zone
    [{t:0,c:-2,r:-2},{t:3,c: 2,r:-1},{t:4,c: 2,r: 2},{t:6,c:-2,r: 2},{t:5,c:-1,r: 0}],
  ];

  // ── Build trunks from selected layout ─────────────────────────────────────
  const layout = LAYOUTS[Math.min(S.seed, 10)];

  for (let ti = 0; ti < layout.length; ti++) {
    const L  = layout[ti];
    const bx = halfW + L.c * step + (rng() - 0.5) * step * 0.06;
    const by = halfH + L.r * step + (rng() - 0.5) * step * 0.06;
    const trunk = T[L.t](bx, by);

    for (let li = 0; li < linesPerBundle; li++) {
      const lineOffset = (li - (linesPerBundle - 1) / 2) * lineSpacing;
      const pts = traceOffsetLine(trunk, lineOffset);
      if (pts.length > 2) {
        // bundleVal: center line → 0 (blue), outermost lines → 1 (light)
        const centerIdx = (linesPerBundle - 1) / 2;
        const bundleVal = linesPerBundle > 1 ? Math.abs(li - centerIdx) / centerIdx : 0;
        paths.push({ pts, off: rng() * UNIT * 2, sp: 0.15 + rng() * 0.15, bundleVal });
      }
    }
  }
}

function rebuild() {
  const r = mkRand(S.seed * 7919 + 13);
  paths = []; S.networkNodes = null; S.networkNodes3D = null;
  const d = S.density;
  if (S.movement === 'spatial3') {
    // Terrain sphere: current 0% visual → 40% slider. Remap [0.4,1]→[0,1], below 0.4 = minimum.
    // Network sphere: old 100% at 50% slider, continues increasing beyond.
    // City sphere: scaled down to match flat version visual weight.
    if      (S.pattern === 'pathways') buildPathwaysSphere(r, Math.floor(5 + d * 30));
    else if (S.pattern === 'terrain')  buildTerrainSphere(r, Math.floor(5 + Math.max(0, d - 0.4) / 0.6 * 30));
    else if (S.pattern === 'city')     buildCitySphere(r, Math.floor(5 + d * 30));
    else                               buildNetworksSphere(r, Math.floor(5 + d * 2 * 30));
  } else {
    // Terrain flat: current 30% visual → 50% slider. Scale down: d*0.6.
    // Network flat: old 100% at 50% slider, continues increasing beyond.
    if      (S.pattern === 'pathways') buildPathways(r, Math.floor(5 + d * 30));
    else if (S.pattern === 'terrain')  buildTerrain(r, Math.floor(5 + d * 0.6 * 30));
    else if (S.pattern === 'city')     buildCity(r, Math.floor(5 + d * 30));
    else                               buildNetworks(r, Math.floor(5 + d * 2 * 30));
  }
  // Snapshot initial offsets so all export clips share the same loop frame-0 reference
  canonicalOff = paths.map(p => p.off);
}


/**
 * CITY GENERATOR — ALIGNED GRID WITH DIAGONAL ROAD CORRIDORS
 *
 * Design:
 * - All blocks have equal road spacing around them (never touch)
 * - Diagonals are invisible — they erase blocks to create road gaps
 * - Seed controls how many and where diagonal road corridors appear (0–3 pairs)
 * - Block size varies between 1×1, 2×1, and 1×2 units
 */
function buildCity(r, n) {
  const seed = Math.floor(r() * 10000);
  const rng = mkRand(seed);

  // Grid parameters — density controls block size (low density = few large, high density = many small)
  // n ranges 5..35 from the density slider
  const t = Math.max(0, Math.min(0.8, (n - 5) / 30));  // 0 = min density, capped at 0.8
  const blockUnit = Math.round(200 - t * 155);        // 200px → 45px
  const roadWidth = Math.round(40 - t * 12);          // 40px → 28px
  const cellSize = blockUnit + roadWidth;

  const bleed = Math.max(cellSize * 2, 200);  // Always at least 200 px for spatial drift
  const gridCols = Math.max(3, Math.ceil((W + bleed * 2) / cellSize) + 1);

  // Y-axis: snap cell height so grid divides evenly into canvas height → seamless top/bottom tiling
  const snapRows  = Math.max(1, Math.round(H / cellSize));
  const cellSizeY = H / snapRows;
  const gridRows  = Math.max(3, Math.ceil((H + bleed * 2) / cellSizeY) + 1);

  const gridStartX = -bleed;
  const gridStartY = -Math.ceil(bleed / cellSizeY) * cellSizeY;

  // --- Diagonal road corridors ---
  // Each corridor has a width and two parallel edges.
  // Blocks are clipped so only parts OUTSIDE the corridor are drawn.
  // The corridor itself is empty space — an open avenue.
  // Diagonal count: seed 0 → 0 diagonals, seed 10 → 4 diagonals max.
  // The 11 seeds round-map onto 0–4 so repeated counts produce compositional
  // variations (diagRng is seeded by S.seed, so same count ≠ same layout).
  //   seeds 0,1 → 0  |  seeds 2,3 → 1  |  seeds 4,5,6 → 2
  //   seeds 7,8 → 3  |  seeds 9,10 → 4
  const numDiag = Math.round(S.seed / 10 * 4);
  const corridors = [];
  const diagRng = mkRand(S.seed * 31337 + 99991);

  // Four angle zones — each assigned a distinct compass direction so no two
  // corridors can ever be parallel.  Zones cycle: shallow-NE → shallow-NW →
  // steep-NE → steep-NW.  Minimum angular separation between any pair is ~16°
  // even at maximum random variation (±6.9° per zone).
  //   Zone 0: +45°   shallow NE
  //   Zone 1: -45°   shallow NW  (90° from zone 0 as undirected lines)
  //   Zone 2: +75°   steep   NE  (30° from zone 0)
  //   Zone 3: -75°   steep   NW  (30° from zone 1, 90° from zone 2)
  const ZONE_ANGLES = [
     Math.PI * 0.250,   // +45°
    -Math.PI * 0.250,   // -45°
     Math.PI * 0.417,   // +75°
    -Math.PI * 0.417,   // -75°
  ];
  const ZONE_VAR = 0.12;  // ±6.9° variation within each zone

  for (let p = 0; p < numDiag; p++) {
    const angle   = ZONE_ANGLES[p % ZONE_ANGLES.length] + (diagRng() - 0.5) * ZONE_VAR;
    const sinA    = Math.sin(angle);
    const cosA    = Math.cos(angle);
    const perpOff = (diagRng() - 0.5) * Math.min(W, H) * 0.55;
    const halfW   = roadWidth * 1.2;

    corridors.push({
      cx: W / 2 - perpOff * sinA,
      cy: H / 2 + perpOff * cosA,
      px: -sinA, py: cosA,
      halfW
    });
  }

  // Clip a polygon against a corridor — keep parts OUTSIDE (left + right sides)
  function clipByCorridors(pts) {
    if (corridors.length === 0) return [pts];

    let current = [pts];
    for (const c of corridors) {
      const next = [];
      for (const poly of current) {
        // Left side: perpDist < -halfW  → clip to dist < -halfW
        //   means: keep where -(px,py) dot > halfW → flip normal
        const leftSide = clipPolyHP(poly, c.cx, c.cy, -c.px, -c.py, c.halfW);
        // Right side: perpDist > +halfW → keep where (px,py) dot > halfW
        const rightSide = clipPolyHP(poly, c.cx, c.cy, c.px, c.py, c.halfW);
        if (leftSide.length > 2)  next.push(leftSide);
        if (rightSide.length > 2) next.push(rightSide);
      }
      current = next.length > 0 ? next : current;
    }
    return current;
  }

  // --- Block generation ---
  // Track occupied cells so 2-unit blocks don't overlap
  const occupied = new Set();

  for (let col = 0; col < gridCols; col++) {
    let row = 0;
    while (row < gridRows) {
      if (occupied.has(`${col},${row}`)) { row++; continue; }

      // Balanced size: equal chance of 1×1, 2×1 (wide), 1×2 (tall)
      const rv = rng();
      let bw = 1, bh = 1;
      if      (rv < 0.33 && col + 2 <= gridCols) bw = 2;
      else if (rv < 0.66 && row + 2 <= gridRows) bh = 2;
      if (col + bw > gridCols) bw = 1;
      if (row + bh > gridRows) bh = 1;

      // Pixel rect — formula guarantees exactly roadWidth gap on every side
      const x0 = gridStartX + col * cellSize;
      const y0 = gridStartY + row * cellSizeY;
      const x1 = x0 + bw * cellSize  - roadWidth;
      const y1 = y0 + bh * cellSizeY - roadWidth;

      // Mark cells as occupied
      for (let dc = 0; dc < bw; dc++)
        for (let dr = 0; dr < bh; dr++)
          occupied.add(`${col + dc},${row + dr}`);

      // Clip block rect against diagonal corridors AND shape rectangles
      const rectPts = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      const corridorClipped = clipByCorridors(rectPts);

      // Always store corridor-clipped polygons as blockPoly on each path.
      // Shape-rect clipping is deferred to draw-time so it works smoothly
      // whether added in fixed or spatial mode (no discrete rebuild jumps).
      for (const poly of corridorClipped) {
        // Skip fragments that are too thin in either dimension
        const MIN_BLOCK = roadWidth * 0.8;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of poly) {
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        if (maxX - minX < MIN_BLOCK || maxY - minY < MIN_BLOCK) continue;

        const ring = [...poly, poly[0]];
        const pts = [];
        for (let i = 0; i < ring.length - 1; i++) {
          const a = ring[i], b = ring[i + 1];
          const ex = b.x - a.x, ey = b.y - a.y;
          const steps = Math.ceil(Math.hypot(ex, ey) / 8);
          for (let j = 0; j < steps; j++) {
            const t = j / steps;
            pts.push({ x: a.x + ex * t, y: a.y + ey * t });
          }
        }
        pts.push(pts[0]);

        if (pts.length > 4) {
          paths.push({ pts, off: rng() * UNIT * 2, sp: 0.15 + rng() * 0.15, rigid: true,
                        blockPoly: poly.map(p => ({ x: p.x, y: p.y })),
                        blockRoadW: roadWidth,
                        cityColorVal: rng() });  // random radial value per block
        }
      }

      row += bh;
    }
  }

}

/**
 * NETWORKS GENERATOR — Delaunay triangulation filling full canvas
 * DESIGN: Dense node scatter → full Delaunay triangulation → straight edges + visible node dots
 */
function buildNetworks(r, n) {
  const nc = Math.max(20, Math.floor(18 + n * 1.25));
  const nodes = [];
  const offRng = mkRand(S.seed * 99991 + 7);

  // Bleed beyond canvas edges so triangulation mesh extends off all sides
  const bleed = 150;
  const areaW = W + bleed * 2;
  const areaH = H + bleed * 2;

  // Poisson-disk scatter with tighter packing for better edge coverage
  const minDist = Math.sqrt((areaW * areaH) / nc) * 0.50;
  let attempts = 0;
  while (nodes.length < nc && attempts < nc * 20) {
    const x = -bleed + r() * areaW;
    const y = -bleed + r() * areaH;
    let tooClose = false;
    for (const node of nodes) {
      if (Math.hypot(x - node.x, y - node.y) < minDist) { tooClose = true; break; }
    }
    if (!tooClose) nodes.push({ x, y });
    attempts++;
  }

  // Full Delaunay triangulation — bleed-area nodes ensure edges reach all 4 borders
  const delaunayEdges = GEO.delaunayTriangulate(nodes);

  for (const [p0, p1] of delaunayEdges) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const steps = Math.ceil(Math.hypot(dx, dy) / 6);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push({ x: p0.x + dx * t, y: p0.y + dy * t });
    }
    paths.push({ pts, off: offRng() * UNIT * 2, sp: 0.15 + offRng() * 0.15, rigid: true,
                  networkColorVal: offRng() });  // random radial value per edge
  }

  // Only store canvas-visible nodes for dot rendering
  S.networkNodes = nodes.filter(nd => nd.x >= 0 && nd.x <= W && nd.y >= 0 && nd.y <= H);
}

// ================================================================
// RENDERING & INTERACTION (Shared across all patterns)
// ================================================================
// Line-unit dimensions — matching Lines.svg style (filled circle + filled bar)
const CR=5, BW=33, BH=Math.round(CR*2*.865), GAP=4, UNIT_GAP=8, UNIT=CR*2+GAP+BW+UNIT_GAP;

/**
 * Sutherland-Hodgman half-plane clip (top-level for reuse in draw loop).
 * Keeps the side of polygon where signed dist >= threshold.
 */
function clipPolyHP(pts, cx, cy, nx, ny, threshold) {
  if (pts.length === 0) return [];
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const da = (a.x - cx) * nx + (a.y - cy) * ny - threshold;
    const db = (b.x - cx) * nx + (b.y - cy) * ny - threshold;
    if (da >= 0) out.push(a);
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/**
 * Clip a polygon against a rectangular exclusion zone.
 * Returns array of polygon fragments OUTSIDE the rectangle.
 */
function clipPolyByRect(poly, rx, ry, rw, rh) {
  const above = clipPolyHP(poly, rx, ry, 0, -1, 0);
  const below = clipPolyHP(poly, rx, ry + rh, 0, 1, 0);
  const hMiddle = clipPolyHP(
    clipPolyHP(poly, rx, ry, 0, 1, 0),
    rx, ry + rh, 0, -1, 0
  );
  const result = [];
  if (above.length > 2)  result.push(above);
  if (below.length > 2)  result.push(below);
  if (hMiddle.length > 2) {
    const left  = clipPolyHP(hMiddle, rx, ry, -1, 0, 0);
    const right = clipPolyHP(hMiddle, rx + rw, ry, 1, 0, 0);
    if (left.length > 2)  result.push(left);
    if (right.length > 2) result.push(right);
  }
  return result;
}

/**
 * Repulsion force: cursor and rectangle shapes push nearby points outward.
 * Both use the same soft-falloff principle — rectangles use SDF (signed
 * distance field) so points are pushed away from the nearest surface point.
 */
function repulse(x, y, drift = 0) {
  const sx = x + drift;
  let ox = 0, oy = 0;

  // Rectangle shape repulsion — SDF push from nearest surface point
  const R_RECT = 150;
  const F_RECT = 80;
  for (const sh of S.shapes) {
    // Rectangle in screen space
    const rx = sh.x, ry = sh.y, rw = sh.w, rh = sh.h;

    // Nearest point on rectangle surface to the screen-space point
    const nearX = Math.max(rx, Math.min(sx, rx + rw));
    const nearY = Math.max(ry, Math.min(y,  ry + rh));

    const ddx = sx - nearX;
    const ddy = y  - nearY;
    const d   = Math.sqrt(ddx * ddx + ddy * ddy);

    // Is the point inside the rectangle?
    const inside = sx >= rx && sx <= rx + rw && y >= ry && y <= ry + rh;

    if (inside) {
      // Inside: push toward the nearest edge with force proportional to
      // how deep the point is — points near the centre get pushed harder
      // so they clear the rectangle completely.
      const dLeft   = sx - rx;
      const dRight  = rx + rw - sx;
      const dTop    = y - ry;
      const dBottom = ry + rh - y;
      const minD    = Math.min(dLeft, dRight, dTop, dBottom);
      // Force = at least F_RECT, plus extra for deeply embedded points
      const push = F_RECT + minD * 0.8;

      if      (minD === dLeft)   ox -= push;
      else if (minD === dRight)  ox += push;
      else if (minD === dTop)    oy -= push;
      else                       oy += push;
    } else if (d < R_RECT && d > 0) {
      // Outside but within influence: soft falloff push away from surface
      const f = (1 - d / R_RECT) * F_RECT;
      ox += (ddx / d) * f;
      oy += (ddy / d) * f;
    }
  }

  return { ox, oy };
}

/**
 * Bend a flattened path so it flows AROUND rectangle obstacles rather than
 * stopping abruptly at their edges. Applied to Terrain and Pathways only.
 *
 * For each point near a rectangle, the push is perpendicular to the local
 * path direction — so lines arc left/right to avoid the obstacle instead of
 * piling up against its face. The canvas clip (already active when this runs)
 * handles the hard cutoff inside the rectangle; this function creates the
 * natural flowing arc outside it.
 *
 * pts   — world-space points (already inside cx.translate(drift,0))
 * drift — current spatial drift so we convert screen-space shape coords
 *         to the same world space: wx = sh.x - drift
 */
function applyRectFlowDeform(pts, drift, radial = false) {
  if (S.shapes.length === 0 || pts.length < 2) return pts;
  const MARGIN = radial ? 90 : 120;
  const result = new Array(pts.length);

  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i];
    let ox = 0, oy = 0;

    for (const sh of S.shapes) {
      const wx = sh.x - drift, wy = sh.y, ww = sh.w, wh = sh.h;
      if (pt.x < wx - MARGIN || pt.x > wx + ww + MARGIN ||
          pt.y < wy - MARGIN || pt.y > wy + wh + MARGIN) continue;

      const nearX = Math.max(wx, Math.min(pt.x, wx + ww));
      const nearY = Math.max(wy, Math.min(pt.y, wy + wh));
      const ddx = pt.x - nearX, ddy = pt.y - nearY;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      const inside = pt.x >= wx && pt.x <= wx + ww && pt.y >= wy && pt.y <= wy + wh;

      if (radial) {
        // ── Terrain: radial SDF push — away from nearest rect surface point.
        // Each point is pushed directly outward from the rectangle boundary,
        // so curved terrain contours bow smoothly without crossing.
        if (inside || d < MARGIN) {
          let nx, ny;
          if (d > 0.01) {
            nx = ddx / d; ny = ddy / d;
          } else {
            // Exactly at surface — push from rect centre outward
            const rcx = wx + ww * 0.5, rcy = wy + wh * 0.5;
            const cx = pt.x - rcx, cy = pt.y - rcy;
            const cLen = Math.sqrt(cx * cx + cy * cy);
            if (cLen < 0.01) { nx = 0; ny = -1; } else { nx = cx / cLen; ny = cy / cLen; }
          }
          const f = inside ? MARGIN * 1.1 : (1 - d / MARGIN) * MARGIN * 0.8;
          ox += nx * f;
          oy += ny * f;
        }
      } else {
        // ── Pathways: perpendicular-to-path push — lines arc sideways around rect.
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        let dirX = next.x - prev.x, dirY = next.y - prev.y;
        const dLen = Math.sqrt(dirX * dirX + dirY * dirY);
        if (dLen < 0.01) continue;
        dirX /= dLen; dirY /= dLen;
        const perpX = -dirY, perpY = dirX;
        const rcx = wx + ww * 0.5, rcy = wy + wh * 0.5;
        const dot = (pt.x - rcx) * perpX + (pt.y - rcy) * perpY;
        const side = dot >= 0 ? 1 : -1;
        if (inside || d < MARGIN) {
          const f = inside ? MARGIN * 1.15 : (1 - d / MARGIN) * MARGIN * 0.85;
          ox += side * perpX * f;
          oy += side * perpY * f;
        }
      }
    }

    result[i] = { x: pt.x + ox, y: pt.y + oy };
  }
  return result;
}

// ================================================================
// SHAPE OBSTACLE UTILITIES
// ================================================================

/** True if point (px,py) is inside any shape rectangle (with optional margin) */
function ptInAnyShape(px, py, margin = 0) {
  for (const sh of S.shapes) {
    if (px >= sh.x - margin && px <= sh.x + sh.w + margin &&
        py >= sh.y - margin && py <= sh.y + sh.h + margin) return true;
  }
  return false;
}

/** True if AABB (rx,ry,rw,rh) overlaps any shape rectangle */
function rectOverlapsAnyShape(rx, ry, rw, rh) {
  for (const sh of S.shapes) {
    if (rx < sh.x + sh.w && rx + rw > sh.x &&
        ry < sh.y + sh.h && ry + rh > sh.y) return true;
  }
  return false;
}

/** True if segment p0→p1 intersects rectangle rect={x,y,w,h} */
function segCrossesRect(p0, p1, rect) {
  const {x, y, w, h} = rect;
  // Endpoint inside?
  const inR = (p) => p.x >= x && p.x <= x+w && p.y >= y && p.y <= y+h;
  if (inR(p0) || inR(p1)) return true;
  // Segment vs each rect edge
  function edgeIsect(ax,ay, bx,by, cx,cy, dx,dy) {
    const d1x=bx-ax,d1y=by-ay,d2x=dx-cx,d2y=dy-cy;
    const cr = d1x*d2y - d1y*d2x;
    if (Math.abs(cr) < 1e-9) return false;
    const t = ((cx-ax)*d2y - (cy-ay)*d2x) / cr;
    const u = ((cx-ax)*d1y - (cy-ay)*d1x) / cr;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  }
  return edgeIsect(p0.x,p0.y, p1.x,p1.y, x,y,   x+w,y  ) ||
         edgeIsect(p0.x,p0.y, p1.x,p1.y, x+w,y,   x+w,y+h) ||
         edgeIsect(p0.x,p0.y, p1.x,p1.y, x+w,y+h, x,y+h  ) ||
         edgeIsect(p0.x,p0.y, p1.x,p1.y, x,y+h,   x,y    );
}

/** True if segment p0→p1 crosses any shape rectangle */
function segCrossesAnyShape(p0, p1) {
  for (const sh of S.shapes) { if (segCrossesRect(p0, p1, sh)) return true; }
  return false;
}

/**
 * Binary-search for the exact shape-boundary crossing point between p0 and p1.
 * One endpoint must be inside (ptInAnyShape true), the other outside.
 * Returns the point just outside the shape boundary.
 */
function findBoundaryPt(p0, p1, margin) {
  let lo = ptInAnyShape(p0.x, p0.y, margin) ? p1 : p0;  // outside
  let hi = ptInAnyShape(p0.x, p0.y, margin) ? p0 : p1;  // inside
  for (let i = 0; i < 10; i++) {
    const mid = { x: (lo.x + hi.x) * 0.5, y: (lo.y + hi.y) * 0.5 };
    if (ptInAnyShape(mid.x, mid.y, margin)) hi = mid; else lo = mid;
  }
  return lo;
}

/**
 * Split a path into sub-paths wherever it would cross a shape rectangle.
 * Points inside shapes (with margin) are removed; boundary crossing points
 * are inserted so every sub-path starts and stops cleanly at the shape edge.
 * Returns an array of sub-path point arrays (may be empty if fully inside).
 */
function splitPathAtShapes(pts, margin = 12) {
  if (S.shapes.length === 0 || pts.length < 2) return [pts];
  const result = [];
  let chain = null;

  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i];
    const inside = ptInAnyShape(pt.x, pt.y, margin);

    if (!inside) {
      if (i > 0 && ptInAnyShape(pts[i - 1].x, pts[i - 1].y, margin)) {
        // Exiting a shape → find exact boundary point and start new chain
        const bp = findBoundaryPt(pts[i - 1], pt, margin);
        chain = [bp, pt];
      } else {
        if (!chain) chain = [pt]; else chain.push(pt);
      }
    } else {
      // Entering a shape
      if (i > 0 && !ptInAnyShape(pts[i - 1].x, pts[i - 1].y, margin)) {
        // Was outside → find entry boundary point and close current chain
        const bp = findBoundaryPt(pts[i - 1], pt, margin);
        if (chain) chain.push(bp);
      }
      if (chain && chain.length >= 2) result.push(chain);
      chain = null;
    }
  }

  if (chain && chain.length >= 2) result.push(chain);
  return result.length > 0 ? result : [];
}

/** Return the 4 corner handles for a shape rectangle */
function getShapeHandles(sh) {
  return [
    { x: sh.x,       y: sh.y,       corner: 'tl' },
    { x: sh.x+sh.w,  y: sh.y,       corner: 'tr' },
    { x: sh.x,       y: sh.y+sh.h,  corner: 'bl' },
    { x: sh.x+sh.w,  y: sh.y+sh.h,  corner: 'br' },
  ];
}

/** Hit-test cursor position against all shapes. Returns {type,idx,corner} or null */
function hitTestShapes(mx, my) {
  const HR = 10; // handle hit radius in px
  for (let i = S.shapes.length - 1; i >= 0; i--) {
    const sh = S.shapes[i];
    for (const h of getShapeHandles(sh)) {
      if (Math.hypot(mx - h.x, my - h.y) < HR) return { type: 'handle', idx: i, corner: h.corner };
    }
    if (mx >= sh.x && mx <= sh.x+sh.w && my >= sh.y && my <= sh.y+sh.h)
      return { type: 'body', idx: i };
  }
  return null;
}

/** Debounced rebuild trigger (used while drag is in progress) */
let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuild(), 60);
}

/**
 * Route a single trunk segment p0→p1 around any shape obstacles.
 * Returns an array of waypoints [p0, ...bypasses, p1] forming a rectilinear path.
 * Horizontal segments detour vertically; vertical segments detour horizontally.
 */
function detourSegment(p0, p1) {
  const waypoints = [p0];
  const margin = 32;

  for (const sh of S.shapes) {
    const ex = { x: sh.x - margin, y: sh.y - margin, w: sh.w + margin*2, h: sh.h + margin*2 };
    // Quick AABB reject
    const sMinX = Math.min(p0.x,p1.x), sMaxX = Math.max(p0.x,p1.x);
    const sMinY = Math.min(p0.y,p1.y), sMaxY = Math.max(p0.y,p1.y);
    if (sMaxX < ex.x || sMinX > ex.x+ex.w || sMaxY < ex.y || sMinY > ex.y+ex.h) continue;
    if (!segCrossesRect(p0, p1, ex)) continue;

    const dx = Math.abs(p1.x - p0.x), dy = Math.abs(p1.y - p0.y);
    if (dx > dy) {
      // Horizontal segment — bypass above or below
      const goAbove = p0.y <= sh.y + sh.h * 0.5;
      const byY = goAbove ? ex.y : ex.y + ex.h;
      const enterX = Math.min(Math.max(ex.x,       sMinX), sMaxX);
      const exitX  = Math.min(Math.max(ex.x+ex.w,  sMinX), sMaxX);
      waypoints.push({ x: enterX, y: byY });
      waypoints.push({ x: exitX,  y: byY });
    } else {
      // Vertical segment — bypass left or right
      const goLeft = p0.x <= sh.x + sh.w * 0.5;
      const byX = goLeft ? ex.x : ex.x + ex.w;
      const enterY = Math.min(Math.max(ex.y,       sMinY), sMaxY);
      const exitY  = Math.min(Math.max(ex.y+ex.h,  sMinY), sMaxY);
      waypoints.push({ x: byX, y: enterY });
      waypoints.push({ x: byX, y: exitY  });
    }
  }
  waypoints.push(p1);
  return waypoints;
}

/** Expand a trunk polyline with rectilinear detours around all shape obstacles */
function buildTrunkWithDetours(trunk) {
  const result = [];
  for (let i = 0; i < trunk.length - 1; i++) {
    const seg = detourSegment(trunk[i], trunk[i+1]);
    if (i === 0) result.push(...seg);
    else result.push(...seg.slice(1));
  }
  return result;
}

/** Split a chain of points wherever any point is inside a shape rectangle.
 *  Returns array of sub-chains (each min minLen points). */
function splitChainAtShapes(chain, minLen = 6) {
  if (S.shapes.length === 0) return [chain];
  const result = [];
  let current = [];
  for (const pt of chain) {
    if (!ptInAnyShape(pt.x, pt.y)) {
      current.push(pt);
    } else {
      if (current.length >= minLen) result.push(current);
      current = [];
    }
  }
  if (current.length >= minLen) result.push(current);
  return result;
}

/**
 * Flatten a generic path using quadratic Bezier with midpoint interpolation
 * Used for City and Network patterns
 */
function flattenPath(pts) {
  if (pts.length < 2) return [];
  const flat = [{x: pts[0].x, y: pts[0].y}];
  const STEP = 4;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i+1].x) / 2, my = (pts[i].y + pts[i+1].y) / 2;
    const p0 = flat[flat.length - 1];
    const approxLen = Math.hypot(pts[i].x - p0.x, pts[i].y - p0.y) + Math.hypot(mx - pts[i].x, my - pts[i].y);
    const steps = Math.max(1, Math.ceil(approxLen / STEP));
    for (let t = 1; t <= steps; t++) {
      const u = t / steps;
      flat.push({
        x: (1-u)*(1-u)*p0.x + 2*(1-u)*u*pts[i].x + u*u*mx,
        y: (1-u)*(1-u)*p0.y + 2*(1-u)*u*pts[i].y + u*u*my
      });
    }
  }
  const p0 = flat[flat.length - 1], pEnd = pts[pts.length - 1];
  const steps = Math.max(1, Math.ceil(Math.hypot(pEnd.x - p0.x, pEnd.y - p0.y) / STEP));
  for (let t = 1; t <= steps; t++) {
    const u = t / steps;
    flat.push({ x: p0.x + (pEnd.x - p0.x)*u, y: p0.y + (pEnd.y - p0.y)*u });
  }
  return flat;
}

// Insert guide points near each corner of a polygon so flattenPath's midpoint-bezier
// rounds them into smooth curves instead of sharp kinks.
// r = chamfer distance along each edge; auto-clamped to half the shorter adjacent edge.
function chamferPoly(verts, r) {
  const n = verts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n];
    const cur  = verts[i];
    const next = verts[(i + 1) % n];
    const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const d2 = Math.hypot(next.x - cur.x,  next.y - cur.y);
    const cr = Math.min(r, d1 * 0.4, d2 * 0.4);
    if (cr > 1 && d1 > 0 && d2 > 0) {
      out.push({ x: cur.x + (prev.x - cur.x) / d1 * cr, y: cur.y + (prev.y - cur.y) / d1 * cr });
      out.push({ x: cur.x + (next.x - cur.x) / d2 * cr, y: cur.y + (next.y - cur.y) / d2 * cr });
    } else {
      out.push(cur);
    }
  }
  return out;
}

// Binary-search a cumulative-distance array to find position + angle at arc length d.
// Shared by drawUnits (canvas) and the SVG export.
function pointAtDistance(flat, dists, totalLen, d) {
  d = Math.max(0, Math.min(totalLen, d));
  let lo = 0, hi = dists.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (dists[mid] <= d) lo = mid; else hi = mid; }
  const segLen = dists[hi] - dists[lo], t = segLen > 0 ? (d - dists[lo]) / segLen : 0;
  return { x: flat[lo].x + (flat[hi].x - flat[lo].x) * t,
           y: flat[lo].y + (flat[hi].y - flat[lo].y) * t,
           angle: Math.atan2(flat[hi].y - flat[lo].y, flat[hi].x - flat[lo].x) };
}

// Draw filled circle+bar units along a flattened path (matches Lines.svg style).
// radialVal (0..1): if provided and colorMode==='radial', overrides color with a
// solid per-line color lerped from S.radialColorA (0) to S.radialColorB (1).
function drawUnits(ctx, flat, off, color, drawProgress, radialVal) {
  if (flat.length < 2) return;
  const dists = [0];
  for (let i = 1; i < flat.length; i++)
    dists.push(dists[i-1] + Math.hypot(flat[i].x-flat[i-1].x, flat[i].y-flat[i-1].y));
  const totalLen = dists[dists.length-1];
  const effectiveLen = (drawProgress != null && drawProgress < 1) ? totalLen * drawProgress : totalLen;
  if (effectiveLen < 1) return;
  const atDist = d => pointAtDistance(flat, dists, totalLen, d);
  // Each path gets one solid color for the entire line — no per-dash color change.
  const lineColor = (S.colorMode === 'radial' && radialVal != null)
    ? lerpColor(S.radialColorA, S.radialColorB, radialVal)
    : color;
  ctx.fillStyle = lineColor;
  for (let d = -(off%UNIT); d < effectiveLen; d += UNIT) {
    // Filled circle
    const cD = d+CR;
    if (cD >= -CR && cD <= totalLen+CR) {
      const p = atDist(cD);
      ctx.beginPath(); ctx.arc(p.x, p.y, CR, 0, Math.PI*2); ctx.fill();
    }
    // Curved bar — polygon ribbon that bends along the path
    const bStart = d + CR*2 + GAP;
    const bEnd   = bStart + BW;
    if (bEnd >= 0 && bStart <= effectiveLen) {
      const cs = Math.max(0, bStart), ce = Math.min(effectiveLen, bEnd);
      const steps = Math.max(2, Math.ceil((ce - cs) / 3));
      const top = [], bot = [];
      for (let si = 0; si <= steps; si++) {
        const p = atDist(cs + (ce - cs) * si / steps);
        const nx = -Math.sin(p.angle), ny = Math.cos(p.angle);
        top.push({ x: p.x + nx*BH/2, y: p.y + ny*BH/2 });
        bot.push({ x: p.x - nx*BH/2, y: p.y - ny*BH/2 });
      }
      ctx.beginPath();
      ctx.moveTo(top[0].x, top[0].y);
      for (let si = 1; si <= steps; si++) ctx.lineTo(top[si].x, top[si].y);
      for (let si = steps; si >= 0; si--) ctx.lineTo(bot[si].x, bot[si].y);
      ctx.closePath(); ctx.fill();
    }
  }
}

// ================================================================
// SPHERE-NATIVE PATTERN BUILDERS  (Spatial 3 mode only)
// Paths are stored as {pts3D:[{x,y,z},...]} unit-sphere vectors.
// No equirectangular projection — geometry lives directly on the sphere.
// ================================================================

// Terrain: seamlessly-tiling scalar field on sphere → marching squares → 3D contours
function buildTerrainSphere(r, n) {
  const seed = Math.floor(r() * 10000);
  // Fewer octaves than flat — sphere shows all contours (none clip off edges), so less detail needed
  const octaves = Math.max(2, Math.min(3, Math.floor(1 + n * 0.8)));
  const COLS = 120, ROWS = 60;  // 2:1 matches longitude:latitude angular range

  // Spherical noise: tiles in longitude (phi), free in colatitude (theta)
  function sphereField(col, row) {
    const phi   = (col % COLS) / COLS;   // [0,1) — wraps at COLS
    const theta = row / ROWS;            // [0,1]  — pole-to-pole, no wrap
    const CELLS = 4;
    let amp = 1, freq = 1, val = 0, maxAmp = 0;
    for (let oi = 0; oi < octaves; oi++) {
      const c = Math.round(CELLS * freq);
      val += amp * GEO.perlinNoiseTileable(phi * c, theta * c, c, c * 2, seed + oi * 1000);
      maxAmp += amp; amp *= 0.5; freq *= 2.0;
    }
    return maxAmp > 0 ? val / maxAmp : 0;
  }

  const grid = [];
  let hMin = Infinity, hMax = -Infinity;
  for (let row = 0; row <= ROWS; row++) {
    grid[row] = new Float32Array(COLS + 1);
    for (let col = 0; col <= COLS; col++) {
      const v = sphereField(col, row);
      grid[row][col] = v;
      if (v < hMin) hMin = v; if (v > hMax) hMax = v;
    }
  }

  // (col_frac, row_frac) in logical grid space → 3D unit vector
  const toSphere = (col, row) => {
    const phi = (col / COLS) * 2 * Math.PI, theta = (row / ROWS) * Math.PI;
    return { x: Math.sin(theta)*Math.cos(phi), y: Math.sin(theta)*Math.sin(phi), z: Math.cos(theta) };
  };

  // Smooth a 3D chain: average neighbours then renormalize to unit sphere
  function smooth3D(pts, passes) {
    let a = pts.slice();
    for (let p = 0; p < passes; p++) {
      const out = [a[0]];
      for (let i = 1; i < a.length - 1; i++) {
        const ax = (a[i-1].x + a[i].x + a[i+1].x) / 3;
        const ay = (a[i-1].y + a[i].y + a[i+1].y) / 3;
        const az = (a[i-1].z + a[i].z + a[i+1].z) / 3;
        const l  = Math.sqrt(ax*ax + ay*ay + az*az) || 1;
        out.push({ x: ax/l, y: ay/l, z: az/l });
      }
      out.push(a[a.length - 1]);
      a = out;
    }
    return a;
  }

  // Halve level count vs flat — every contour loop is fully visible on sphere
  const numLevels = Math.max(3, Math.floor(3 + n * 0.3));
  const mg = (hMax - hMin) * 0.05;
  for (let li = 1; li <= numLevels; li++) {
    const level = hMin + mg + (li / (numLevels + 1)) * (hMax - hMin - mg * 2);
    const segs   = GEO.marchingSquares(grid, COLS, ROWS, 1, 1, level);
    const chains = GEO.chainSegments(segs);
    for (const chain of chains) {
      if (chain.length >= 4) {
        const pts3D = smooth3D(chain.map(pt => toSphere(pt.x, pt.y)), 3);
        const terrainVal = numLevels > 1 ? 1 - (li - 1) / (numLevels - 1) : 0;
        paths.push({ pts3D, off: r() * UNIT * 4, sp: 0.15 + r() * 0.15, terrainVal });
      }
    }
  }
}

// Pathways: L-shaped geodesic corridor bundles — proportionate scale, full sphere coverage
// Each leg is a fixed angular length relative to the trunk's base point (not absolute poles/edges).
// Two trunk sets (front + back hemisphere) ensure paths are visible throughout the full rotation.
function buildPathwaysSphere(r, n) {
  const rng            = mkRand(Math.floor(r() * 10000));
  const linesPerBundle = Math.max(8, Math.floor(8 + n * 0.35));
  // Convert flat-mode pixel spacing (20px) to radians so the sphere bundle looks
  // identical in density to the flat version: gap ≈ line width (BH ≈ 9px).
  const lineSpacing    = 20 / (Math.min(W, H) * 0.44);
  const baseRadius     = 0.55;     // corner arc radius in (phi,theta) radians — wide sweeping curves
  const ARC_STEPS      = 36;

  const phi0 = S.seed * (2 * Math.PI / 11);
  const seed  = Math.min(S.seed, 10);

  // ── Line intersection helper ──────────────────────────────────────────
  function lineIsect(p1x, p1y, d1x, d1y, p2x, p2y, d2x, d2y) {
    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < 1e-8) return { x: p1x, y: p1y };
    const t = ((p2x - p1x) * d2y - (p2y - p1y) * d2x) / cross;
    return { x: p1x + d1x * t, y: p1y + d1y * t };
  }

  // ── Trace one offset line in flat (phi, theta) space ──────────────────
  // Exact same algorithm as the proven flat traceOffsetLine, but operating
  // in radian coordinates. Produces perfect parallel lines + circular arcs.
  function traceOffsetLine(waypoints, lineOffset) {
    if (waypoints.length < 2) return [];

    const segs = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i], b = waypoints[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const ux = dx / len, uy = dy / len;
      const nx = -uy, ny = ux;
      segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, ux, uy, nx, ny });
    }
    if (!segs.length) return [];

    // Pre-compute arc info at each interior corner
    const arcInfos = [];
    for (let i = 0; i < segs.length - 1; i++) {
      const s1 = segs[i], s2 = segs[i + 1];
      const cross = s1.ux * s2.uy - s1.uy * s2.ux;
      const px = cross > 0 ? -s1.uy :  s1.uy;
      const py = cross > 0 ?  s1.ux : -s1.ux;
      const dotPA = s1.nx * px + s1.ny * py;
      const effectiveR = Math.max(0.01, baseRadius + lineOffset * (dotPA > 0 ? -1 : 1));
      const dot12 = Math.max(-1, Math.min(1, s1.ux * s2.ux + s1.uy * s2.uy));
      const tangentLen = effectiveR * Math.tan(Math.acos(dot12) / 2);
      arcInfos.push({ px, py, effectiveR, tangentLen, cross });
    }

    // Pre-compute offset corners
    const offsetCorners = [];
    for (let i = 0; i < segs.length - 1; i++) {
      const s1 = segs[i], s2 = segs[i + 1];
      const p1x = s1.bx + s1.nx * lineOffset, p1y = s1.by + s1.ny * lineOffset;
      const p2x = s2.ax + s2.nx * lineOffset, p2y = s2.ay + s2.ny * lineOffset;
      offsetCorners.push(lineIsect(p1x, p1y, s1.ux, s1.uy, p2x, p2y, s2.ux, s2.uy));
    }

    // Emit points: straight → arc → straight → …
    const pts = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const trimS = (i > 0)              ? arcInfos[i - 1].tangentLen : 0;
      const trimE = (i < segs.length - 1) ? arcInfos[i].tangentLen    : 0;

      let sx, sy;
      if (i === 0) {
        sx = s.ax + s.nx * lineOffset;
        sy = s.ay + s.ny * lineOffset;
      } else {
        const oc = offsetCorners[i - 1];
        sx = oc.x + s.ux * trimS;
        sy = oc.y + s.uy * trimS;
      }

      let ex, ey;
      if (i < segs.length - 1) {
        const oc = offsetCorners[i];
        ex = oc.x - s.ux * trimE;
        ey = oc.y - s.uy * trimE;
      } else {
        ex = s.bx + s.nx * lineOffset;
        ey = s.by + s.ny * lineOffset;
      }

      if (pts.length === 0) pts.push({ x: sx, y: sy });

      // Straight portion — sample every ~0.02 rad
      const segLen = Math.hypot(ex - sx, ey - sy);
      if (segLen > 0.001) {
        const steps = Math.max(1, Math.ceil(segLen / 0.02));
        for (let j = 1; j <= steps; j++) {
          const t = j / steps;
          pts.push({ x: sx + (ex - sx) * t, y: sy + (ey - sy) * t });
        }
      }

      // Arc at corner
      if (i < segs.length - 1) {
        const { px, py, effectiveR, tangentLen, cross } = arcInfos[i];
        const arcCx = ex + px * effectiveR;
        const arcCy = ey + py * effectiveR;
        const oc = offsetCorners[i];
        const ns = segs[i + 1];
        const nextSx = oc.x + ns.ux * tangentLen;
        const nextSy = oc.y + ns.uy * tangentLen;

        let fromA = Math.atan2(ey - arcCy, ex - arcCx);
        let toA   = Math.atan2(nextSy - arcCy, nextSx - arcCx);
        let da    = toA - fromA;
        if (cross > 0  && da < 0) da += Math.PI * 2;
        if (cross <= 0 && da > 0) da -= Math.PI * 2;

        for (let j = 1; j <= ARC_STEPS; j++) {
          const a = fromA + da * j / ARC_STEPS;
          pts.push({ x: arcCx + effectiveR * Math.cos(a), y: arcCy + effectiveR * Math.sin(a) });
        }
      }
    }
    return pts;
  }

  // ── Convert flat (phi, theta) point to 3D unit vector ─────────────────
  function toSphere(pt) {
    const theta = Math.max(0.06, Math.min(Math.PI - 0.06, pt.y));
    return {
      x: Math.sin(theta) * Math.cos(pt.x),
      y: Math.sin(theta) * Math.sin(pt.x),
      z: Math.cos(theta)
    };
  }

  // ── Seed-driven path variations in flat (phi, theta) space ─────────────
  // All paths are continuous pole-to-pole lines. Three trunk types:
  //   S-curve: vertical → horizontal wrap → vertical (2 smooth corners)
  //   Vertical: straight meridian from top to bottom
  //   Horizontal: latitude circle wrapping around the sphere
  // Each layout combines 2–4 of these, all running from south edge to north edge.
  const HP = Math.PI / 2;
  const p = phi0;
  const N = HP - 1.3, S_ = HP + 1.3;  // north/south pole edges

  // Bundle half-width determines safe latitude gap between horizontal segments
  const bundleHalfW = (linesPerBundle - 1) / 2 * lineSpacing;
  const gap = bundleHalfW * 2 + 0.25;  // full bundle width + visible buffer between bundles

  // S-curve helper: south(φ₁) → equator(φ₁,lat) → wrap → equator(φ₂,lat) → north(φ₂)
  function sCurve(ph, wrap, lat) {
    return [{x:ph,y:S_},{x:ph,y:lat},{x:ph+wrap,y:lat},{x:ph+wrap,y:N}];
  }
  // Counter S-curve: offsets phi endpoints inward by g so verticals don't overlap
  // Primary sCurve(ph, w, lat) has verticals at ph and ph+w.
  // Counter starts g inside the primary's end, wraps back to g inside the primary's start.
  // Result: verticals at ph+w∓g and ph±g — safely spaced from primary.
  function counterS(ph, wrap, lat) {
    const s = Math.sign(wrap);
    return sCurve(ph + wrap - s * g, -(wrap - 2 * s * g), lat);
  }
  // Vertical helper: straight meridian top to bottom
  function vert(ph) { return [{x:ph,y:N},{x:ph,y:S_}]; }
  // π/3 ≈ 60° offset for distributing verticals around the sphere
  const T = Math.PI / 3;
  const g = gap;  // shorthand for latitude offsets
  const LAYOUTS = [
    // 0 — S right + counter S left + vertical
    [ sCurve(p, 5.5, HP), counterS(p, 5.5, HP-g), vert(p+Math.PI) ],
    // 1 — S left + counter S right + vertical
    [ sCurve(p, -5.5, HP), counterS(p, -5.5, HP+g), vert(p+Math.PI) ],
    // 2 — two S-curves opposite wraps at different latitudes
    [ sCurve(p, 5.5, HP+g*0.5), counterS(p, 5.5, HP-g*0.5), vert(p+T*2), vert(p+T*4) ],
    // 3 — S 270° right + counter S + vertical
    [ sCurve(p, 4.7, HP), counterS(p, 4.7, HP+g), vert(p+Math.PI) ],
    // 4 — S 270° left + counter S + vertical
    [ sCurve(p, -4.7, HP), counterS(p, -4.7, HP-g), vert(p+Math.PI) ],
    // 5 — S above equator + counter S below + safe vert at midpoint
    [ sCurve(p, 5.0, HP-g*0.5), counterS(p, 5.0, HP+g*0.5), vert(p+2.5) ],
    // 6 — two opposing S-curves at different latitudes + vertical
    [ sCurve(p, 5.5, HP+g*0.5), counterS(p, 5.5, HP-g*0.5), vert(p+Math.PI) ],
    // 7 — S left above + counter S right below + vertical
    [ sCurve(p, -5.5, HP-g*0.5), counterS(p, -5.5, HP+g*0.5), vert(p+Math.PI) ],
    // 8 — wide S 340° + counter S + vertical
    [ sCurve(p, 5.9, HP), counterS(p, 5.9, HP+g), vert(p+Math.PI) ],
    // 9 — S right + counter S + two safe verts
    [ sCurve(p, 5.0, HP), counterS(p, 5.0, HP+g), vert(p+1.8), vert(p+3.2) ],
    // 10 — S right + counter S + safe vert at midpoint
    [ sCurve(p, 4.5, HP), counterS(p, 4.5, HP+g), vert(p+2.25) ],
  ];

  const trunks = LAYOUTS[seed];

  // ── Generate bundles for each trunk ───────────────────────────────────
  for (let ti = 0; ti < trunks.length; ti++) {
    const trunkPath = trunks[ti];
    for (let li = 0; li < linesPerBundle; li++) {
      const lineOffset = (li - (linesPerBundle - 1) / 2) * lineSpacing;
      const pts = traceOffsetLine(trunkPath, lineOffset);
      if (pts.length > 2) {
        const centerIdx = (linesPerBundle - 1) / 2;
        const bundleVal = linesPerBundle > 1 ? Math.abs(li - centerIdx) / centerIdx : 0;
        paths.push({ pts3D: pts.map(toSphere), off: rng() * UNIT * 4, sp: 0.15 + rng() * 0.15, bundleVal });
      }
    }
  }
}

// City: rectangular block grid on sphere with diagonal corridor clipping — mirrors flat mode
function buildCitySphere(r, n) {
  const seed = Math.floor(r() * 10000);
  const rng    = mkRand(seed);
  const offRng = mkRand(S.seed * 99991 + 7);

  const t        = Math.max(0, Math.min(0.8, (n - 5) / 30));
  const blockAng = 0.45 - t * 0.28;   // 0.45 → 0.226 rad per block (larger → fewer blocks, matching flat density)
  const roadAng  = 0.10 - t * 0.06;   // 0.10 → 0.052 rad per road
  const cellAng  = blockAng + roadAng;

  const thetaStart = 0.10;
  const thetaEnd   = Math.PI - 0.10;
  const numRows    = Math.max(2, Math.floor((thetaEnd - thetaStart) / cellAng));
  const numCols    = Math.max(3, Math.floor(2 * Math.PI / cellAng));
  const cellTheta  = (thetaEnd - thetaStart) / numRows;
  const cellPhi    = 2 * Math.PI / numCols;
  const blkTheta   = cellTheta * (blockAng / cellAng);
  const blkPhi     = cellPhi   * (blockAng / cellAng);
  const rdTheta    = cellTheta - blkTheta;
  const rdPhi      = cellPhi   - blkPhi;

  // Diagonal corridors — width matches roadAng (like flat roadWidth * 1.2)
  const numDiag  = Math.round(S.seed / 10 * 4);
  const corridors = [];
  for (let d = 0; d < numDiag; d++) {
    const phi  = rng() * 2 * Math.PI;
    const cosT = (rng() * 2 - 1) * 0.65;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    corridors.push({ nx: sinT*Math.cos(phi), ny: sinT*Math.sin(phi), nz: cosT,
                     hw: roadAng * 1.2 });  // narrow band, not cell-wide
  }

  // Spherical Sutherland-Hodgman half-plane clip.
  // Keeps points where dot(p, n) >= threshold (i.e. on the "outside" half-sphere).
  function clipSpherePoly(pts, nx, ny, nz, threshold) {
    if (pts.length < 3) return [];
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const da = a.x*nx + a.y*ny + a.z*nz;
      const db = b.x*nx + b.y*ny + b.z*nz;
      if (da >= threshold) out.push(a);
      if ((da > threshold && db < threshold) || (da < threshold && db > threshold)) {
        const tc = (da - threshold) / (da - db);
        const cx = a.x + (b.x - a.x) * tc;
        const cy = a.y + (b.y - a.y) * tc;
        const cz = a.z + (b.z - a.z) * tc;
        const l  = Math.sqrt(cx*cx + cy*cy + cz*cz) || 1;
        out.push({ x: cx/l, y: cy/l, z: cz/l });
      }
    }
    return out;
  }

  // Clip a block polygon against all corridors; return surviving fragments (outside corridor bands).
  function clipByCorridors3D(corners) {
    let current = [corners];
    for (const c of corridors) {
      const sinHW = Math.sin(c.hw);
      const next  = [];
      for (const poly of current) {
        // Left side of corridor band: dot(p, -n) >= sinHW  → dot(p, n) <= -sinHW
        const left  = clipSpherePoly(poly, -c.nx, -c.ny, -c.nz, sinHW);
        // Right side: dot(p, n) >= sinHW
        const right = clipSpherePoly(poly,  c.nx,  c.ny,  c.nz, sinHW);
        if (left.length  >= 3) next.push(left);
        if (right.length >= 3) next.push(right);
      }
      if (next.length > 0) current = next;
    }
    return current;
  }

  // 3D unit-vector corners of a lat-lon block rectangle (4 corners, CCW order)
  function blockCorners(th0, th1, ph0, ph1) {
    return [
      { x: Math.sin(th0)*Math.cos(ph0), y: Math.sin(th0)*Math.sin(ph0), z: Math.cos(th0) },
      { x: Math.sin(th0)*Math.cos(ph1), y: Math.sin(th0)*Math.sin(ph1), z: Math.cos(th0) },
      { x: Math.sin(th1)*Math.cos(ph1), y: Math.sin(th1)*Math.sin(ph1), z: Math.cos(th1) },
      { x: Math.sin(th1)*Math.cos(ph0), y: Math.sin(th1)*Math.sin(ph0), z: Math.cos(th1) },
    ];
  }

  // Convert a polygon of 3D corners to a dense closed pts3D path (geodesic arcs on each edge).
  function polyToPath3D(corners) {
    const pts3D = [];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], b = corners[(i + 1) % corners.length];
      const dot   = Math.max(-1, Math.min(1, a.x*b.x + a.y*b.y + a.z*b.z));
      const ang   = Math.acos(dot);
      const steps = Math.max(2, Math.ceil(ang / (cellAng / 8)));
      const sinA  = ang > 0.001 ? Math.sin(ang) : 0;
      const start = i === 0 ? 0 : 1;  // skip first point on subsequent edges (shared with prev)
      for (let j = start; j <= steps; j++) {
        const tt = j / steps;
        if (sinA < 0.001) {
          pts3D.push(tt < 0.5 ? { ...a } : { ...b });
        } else {
          const f0 = Math.sin((1-tt)*ang)/sinA, f1 = Math.sin(tt*ang)/sinA;
          pts3D.push({ x: f0*a.x+f1*b.x, y: f0*a.y+f1*b.y, z: f0*a.z+f1*b.z });
        }
      }
    }
    if (pts3D.length > 0) pts3D.push({ ...pts3D[0] });  // close loop
    return pts3D;
  }

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const th0 = thetaStart + row * cellTheta + rdTheta * 0.5;
      const th1 = th0 + blkTheta;
      const ph0 = col * cellPhi + rdPhi * 0.5;
      const ph1 = ph0 + blkPhi;

      const corners   = blockCorners(th0, th1, ph0, ph1);
      const fragments = clipByCorridors3D(corners);

      for (const frag of fragments) {
        if (frag.length < 3) continue;
        // Skip fragments smaller than half a road width
        let minDot = 1;
        for (let i = 0; i < frag.length; i++)
          for (let j = i + 1; j < frag.length; j++) {
            const d = frag[i].x*frag[j].x + frag[i].y*frag[j].y + frag[i].z*frag[j].z;
            if (d < minDot) minDot = d;
          }
        if (Math.acos(Math.max(-1, Math.min(1, minDot))) < roadAng * 0.8) continue;

        const pts3D = polyToPath3D(frag);
        if (pts3D.length > 4)
          paths.push({ pts3D, off: offRng() * UNIT * 2, sp: 0.15 + offRng() * 0.15, cityColorVal: offRng() });
      }
    }
  }
}

// Networks: seeded random Poisson-disk scatter + K-nearest geodesic arcs
// Each seed produces genuinely different node topology (not just a rotation of the same graph)
function buildNetworksSphere(r, n) {
  const nc     = Math.max(20, Math.floor(18 + n * 1.25));
  const offRng = mkRand(S.seed * 99991 + 7);

  // Fibonacci sphere base: perfectly uniform coverage, guaranteed no holes.
  // Per-node seed-based perturbation shifts each node slightly so every seed
  // produces a distinct topology while maintaining even distribution.
  const phi0    = (1 + Math.sqrt(5)) / 2;
  const nodes3D = [];
  for (let i = 0; i < nc; i++) {
    const phi      = 2 * Math.PI * i / phi0;
    const cosTheta = 1 - 2 * (i + 0.5) / nc;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    nodes3D.push({ x: sinTheta*Math.cos(phi), y: sinTheta*Math.sin(phi), z: cosTheta });
  }

  // Per-node perturbation: rotate each node by a small seed-dependent angle
  // in a random tangent-plane direction. Max offset = 30% of average node spacing.
  const rng2       = mkRand(S.seed * 7907 + 3);
  const perturbAng = Math.sqrt(4 * Math.PI / nc) * 0.30;
  for (let i = 0; i < nodes3D.length; i++) {
    const p       = nodes3D[i];
    const randPhi = rng2() * 2 * Math.PI;
    const offset  = rng2() * perturbAng;
    // Build an orthonormal tangent frame at p
    const refX = Math.abs(p.z) < 0.9 ? 1 : 0, refY = Math.abs(p.z) < 0.9 ? 0 : 1;
    const d1   = refX*p.x + refY*p.y;              // dot(ref, p)
    let t1x = refX - d1*p.x, t1y = refY - d1*p.y, t1z = -d1*p.z;
    const t1l = Math.sqrt(t1x*t1x + t1y*t1y + t1z*t1z) || 1;
    t1x/=t1l; t1y/=t1l; t1z/=t1l;
    const t2x = p.y*t1z - p.z*t1y, t2y = p.z*t1x - p.x*t1z, t2z = p.x*t1y - p.y*t1x;
    // Displacement direction in tangent plane
    const dx = Math.cos(randPhi)*t1x + Math.sin(randPhi)*t2x;
    const dy = Math.cos(randPhi)*t1y + Math.sin(randPhi)*t2y;
    const dz = Math.cos(randPhi)*t1z + Math.sin(randPhi)*t2z;
    // Rotate p by `offset` radians toward (dx,dy,dz)
    const cosO = Math.cos(offset), sinO = Math.sin(offset);
    const nx = cosO*p.x + sinO*dx, ny = cosO*p.y + sinO*dy, nz = cosO*p.z + sinO*dz;
    const l  = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    nodes3D[i] = { x: nx/l, y: ny/l, z: nz/l };
  }

  // Connect each node to its K nearest neighbours via geodesic arcs
  const K = 5, edgeSet = new Set();
  for (let i = 0; i < nodes3D.length; i++) {
    const p0 = nodes3D[i];
    const nbrs = nodes3D
      .map((p1, j) => ({ j, d: Math.acos(Math.max(-1, Math.min(1, p0.x*p1.x + p0.y*p1.y + p0.z*p1.z))) }))
      .filter(e => e.j !== i).sort((a, b) => a.d - b.d).slice(0, K);

    for (const { j, d: angle } of nbrs) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      const p1 = nodes3D[j];
      const ARC_STEPS = Math.max(3, Math.ceil(angle * 18));
      const pts3D = [];
      if (angle < 0.001) {
        pts3D.push({ ...p0 }, { ...p1 });
      } else {
        const sinA = Math.sin(angle);
        for (let si = 0; si <= ARC_STEPS; si++) {
          const tt = si / ARC_STEPS;
          const f0 = Math.sin((1-tt)*angle)/sinA, f1 = Math.sin(tt*angle)/sinA;
          pts3D.push({ x: f0*p0.x+f1*p1.x, y: f0*p0.y+f1*p1.y, z: f0*p0.z+f1*p1.z });
        }
      }
      paths.push({ pts3D, off: offRng() * UNIT * 2, sp: 0.15 + offRng() * 0.15, rigid: true, networkColorVal: offRng() });
    }
  }
  S.networkNodes3D = nodes3D;
}





// Draw dot-bar units along a 2D path using sphere projection for Spatial 3.
// Arc-length parameterization on the ORIGINAL 2D path ensures animation speed
// is uniform — the dot advance rate is constant in canvas-space, so there are
// no speed jumps as the sphere rotates or path segments appear/disappear.
function drawUnitsOnSphere(ctx, srcPts, off, color, rotAngle, drawProgress, radialVal) {
  if (srcPts.length < 2) return;
  // Cumulative arc lengths along original 2D path
  const dists = [0];
  for (let i = 1; i < srcPts.length; i++)
    dists.push(dists[i-1] + Math.hypot(srcPts[i].x-srcPts[i-1].x, srcPts[i].y-srcPts[i-1].y));
  const totalLen = dists[dists.length-1];
  const effectiveLen = (drawProgress != null && drawProgress < 1) ? totalLen * drawProgress : totalLen;
  if (effectiveLen < 1) return;

  // 2D canvas point at arc-length d
  function pt2dAtD(d) {
    d = Math.max(0, Math.min(totalLen, d));
    let lo = 0, hi = dists.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (dists[mid] <= d) lo = mid; else hi = mid; }
    const t = dists[hi] > dists[lo] ? (d - dists[lo]) / (dists[hi] - dists[lo]) : 0;
    return { x: srcPts[lo].x + (srcPts[hi].x - srcPts[lo].x) * t,
             y: srcPts[lo].y + (srcPts[hi].y - srcPts[lo].y) * t };
  }

  const lineColor = (S.colorMode === 'radial' && radialVal != null)
    ? lerpColor(S.radialColorA, S.radialColorB, radialVal) : color;
  ctx.fillStyle = lineColor;
  for (let d = -(off % UNIT); d < effectiveLen; d += UNIT) {
    // ── Circle ──────────────────────────────────────────────────────
    const cD = d + CR;
    if (cD >= 0 && cD <= effectiveLen) {
      const p2d = pt2dAtD(cD);
      const pp = sphereProject(p2d.x, p2d.y, rotAngle);
      if (pp) { ctx.beginPath(); ctx.arc(pp.x, pp.y, CR, 0, Math.PI * 2); ctx.fill(); }
    }
    // ── Bar — sample arc positions, project each, draw ribbon ───────
    const bStart = d + CR * 2 + GAP, bEnd = bStart + BW;
    if (bEnd >= 0 && bStart <= effectiveLen) {
      const cs = Math.max(0, bStart), ce = Math.min(effectiveLen, bEnd);
      const steps = Math.max(2, Math.ceil((ce - cs) / 5));
      const ppPts = [];
      for (let si = 0; si <= steps; si++) {
        const p2d = pt2dAtD(cs + (ce - cs) * si / steps);
        const pp = sphereProject(p2d.x, p2d.y, rotAngle);
        if (pp) ppPts.push(pp);
        else if (ppPts.length > 0) break; // hit back hemisphere — stop bar here
      }
      if (ppPts.length >= 2) {
        const top = [], bot = [];
        for (let si = 0; si < ppPts.length; si++) {
          const prev = ppPts[Math.max(0, si - 1)];
          const next = ppPts[Math.min(ppPts.length - 1, si + 1)];
          const angle = Math.atan2(next.y - prev.y, next.x - prev.x);
          const nx = -Math.sin(angle), ny = Math.cos(angle);
          top.push({ x: ppPts[si].x + nx * BH/2, y: ppPts[si].y + ny * BH/2 });
          bot.push({ x: ppPts[si].x - nx * BH/2, y: ppPts[si].y - ny * BH/2 });
        }
        ctx.beginPath();
        ctx.moveTo(top[0].x, top[0].y);
        for (let si = 1; si < top.length; si++) ctx.lineTo(top[si].x, top[si].y);
        for (let si = top.length - 1; si >= 0; si--) ctx.lineTo(bot[si].x, bot[si].y);
        ctx.closePath(); ctx.fill();
      }
    }
  }
}

// Project a 3D unit-sphere point to screen via rotation + orthographic camera.
// Rotation is around the world Z axis (globe spin). Returns null for back hemisphere.
function project3D(p3, rotAngle) {
  const cos_r = Math.cos(rotAngle), sin_r = Math.sin(rotAngle);
  const xr = p3.x * cos_r - p3.y * sin_r;
  const yr = p3.x * sin_r + p3.y * cos_r;
  const zr = p3.z;
  if (xr <= 0.02) return null;
  const SR = Math.min(W, H) * 0.44;
  return { x: W * 0.5 + yr * SR, y: H * 0.5 - zr * SR };
}

// Draw dot-bar units along a native 3D sphere path (pts3D = [{x,y,z}] unit vectors).
// Arc lengths are scaled by SR to screen-pixel equivalents for speed parity with flat mode.
function drawUnitsOnSphere3D(ctx, pts3D, off, color, rotAngle, drawProgress, radialVal) {
  if (pts3D.length < 2) return;
  const SR = Math.min(W, H) * 0.44;
  const dists = [0];
  for (let i = 1; i < pts3D.length; i++) {
    const dx = pts3D[i].x - pts3D[i-1].x, dy = pts3D[i].y - pts3D[i-1].y, dz = pts3D[i].z - pts3D[i-1].z;
    dists.push(dists[i-1] + Math.sqrt(dx*dx + dy*dy + dz*dz) * SR);
  }
  const totalLen = dists[dists.length-1];
  const effectiveLen = (drawProgress != null && drawProgress < 1) ? totalLen * drawProgress : totalLen;
  if (effectiveLen < 1) return;

  function pt3DAtD(d) {
    d = Math.max(0, Math.min(totalLen, d));
    let lo = 0, hi = dists.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (dists[mid] <= d) lo = mid; else hi = mid; }
    const t = dists[hi] > dists[lo] ? (d - dists[lo]) / (dists[hi] - dists[lo]) : 0;
    return { x: pts3D[lo].x + (pts3D[hi].x - pts3D[lo].x) * t,
             y: pts3D[lo].y + (pts3D[hi].y - pts3D[lo].y) * t,
             z: pts3D[lo].z + (pts3D[hi].z - pts3D[lo].z) * t };
  }

  const lineColor = (S.colorMode === 'radial' && radialVal != null)
    ? lerpColor(S.radialColorA, S.radialColorB, radialVal) : color;
  ctx.fillStyle = lineColor;
  for (let d = -(off % UNIT); d < effectiveLen; d += UNIT) {
    const cD = d + CR;
    if (cD >= 0 && cD <= effectiveLen) {
      const pp = project3D(pt3DAtD(cD), rotAngle);
      if (pp) { ctx.beginPath(); ctx.arc(pp.x, pp.y, CR, 0, Math.PI * 2); ctx.fill(); }
    }
    const bStart = d + CR * 2 + GAP, bEnd = bStart + BW;
    if (bEnd >= 0 && bStart <= effectiveLen) {
      const cs = Math.max(0, bStart), ce = Math.min(effectiveLen, bEnd);
      const steps = Math.max(2, Math.ceil((ce - cs) / 5));
      const ppPts = [];
      for (let si = 0; si <= steps; si++) {
        const pp = project3D(pt3DAtD(cs + (ce - cs) * si / steps), rotAngle);
        if (pp) ppPts.push(pp);
        else if (ppPts.length > 0) break;
      }
      if (ppPts.length >= 2) {
        const top = [], bot = [];
        for (let si = 0; si < ppPts.length; si++) {
          const prev = ppPts[Math.max(0, si-1)], next = ppPts[Math.min(ppPts.length-1, si+1)];
          const ang = Math.atan2(next.y - prev.y, next.x - prev.x);
          const nx = -Math.sin(ang), ny = Math.cos(ang);
          top.push({ x: ppPts[si].x + nx*BH/2, y: ppPts[si].y + ny*BH/2 });
          bot.push({ x: ppPts[si].x - nx*BH/2, y: ppPts[si].y - ny*BH/2 });
        }
        ctx.beginPath();
        ctx.moveTo(top[0].x, top[0].y);
        for (let si = 1; si < top.length; si++) ctx.lineTo(top[si].x, top[si].y);
        for (let si = top.length - 1; si >= 0; si--) ctx.lineTo(bot[si].x, bot[si].y);
        ctx.closePath(); ctx.fill();
      }
    }
  }
}

/**
 * Deform/split a path for rectangle interaction. Different per pattern:
 *
 * TERRAIN: Split path at rectangle boundaries using splitPathAtShapes.
 *   Returns array of sub-path flattenings drawn independently.
 *
 * CITY / NETWORKS (rigid paths): No deformation — block re-clipping and
 *   canvas void punch are handled separately in the draw and export loops.
 *
 * PATHWAYS / DEFAULT: Returns the flat path unchanged.
 */
function deformPath(p, drift) {
  // ── CITY / NETWORKS: no deformation — clip + rebuild handles the void ──
  if (p.rigid) {
    return [flattenPath(p.pts)];
  }

  // ── TERRAIN: geometric split at rectangle boundaries ──
  // Contour lines are cleanly cut where they cross the rectangle edge.
  // No repulsion — lines end precisely at the boundary. The canvas clip
  // provides a safety net for any edge artifacts.
  if (S.pattern === 'terrain' && S.shapes.length > 0) {
    const savedShapes = S.shapes;
    S.shapes = S.shapes.map(sh => ({ x: sh.x - drift, y: sh.y - S.driftY, w: sh.w, h: sh.h }));
    const subPaths = splitPathAtShapes(p.pts, 4);
    S.shapes = savedShapes;
    if (subPaths.length === 0) return [];
    return subPaths.map(sp => flattenPath(sp));
  }

  // ── PATHWAYS / DEFAULT: no deformation ──
  // Pathways use precise parallel-offset arc geometry; per-point repulsion
  // would break the non-crossing guarantee, causing lines to touch/overlap.
  return [flattenPath(p.pts)];
}

/**
 * Main render loop: animate and draw all pattern paths
 * Handles path flattening with interaction deformation
 */
// ── Sphere projection for Spatial 3 ──────────────────────────────────────────
// Maps a flat canvas point (x, y) onto a rotating globe using equirectangular
// projection and orthographic camera along the +X axis.
// X wraps periodically ([0,W] = one full longitude period) — bleed-area points
// tile seamlessly onto the sphere surface without seam artifacts.
// Y is clipped to [0,H] — latitude is NOT circular (poles at top and bottom),
// so wrapping Y would map top-bleed points to wrong latitudes.
// Returns {x, y} screen position, or null if back-hemisphere or out of y range.
function sphereProject(x, y, rotAngle) {
  if (y < 0 || y > H) return null;            // latitude axis — clip, do not wrap
  const scx = W * 0.5, scy = H * 0.5;
  const SR  = Math.min(W, H) * 0.44;
  const wx  = ((x % W) + W) % W;              // longitude axis — wrap seamlessly
  const lon = (wx / W - 0.5) * 2 * Math.PI;  // [-π, π]
  const lat = (0.5 - y / H) * Math.PI * 0.99; // [±89°] — full sphere coverage, no polar cap
  const cosLat = Math.cos(lat);
  const x3 = cosLat * Math.cos(lon);
  const y3 = cosLat * Math.sin(lon);
  const z3 = Math.sin(lat);
  const cos_r = Math.cos(rotAngle), sin_r = Math.sin(rotAngle);
  const xr = x3 * cos_r - y3 * sin_r;
  const yr = x3 * sin_r + y3 * cos_r;
  const zr = z3;
  if (xr <= 0.02) return null;
  return { x: scx + yr * SR, y: scy - zr * SR };
}

function draw(ts = performance.now()) {
  // ── Advance dash offsets once per frame ──────────────────────────
  const sm = S.motionOn ? 0.5 + S.speed * 3 : 0;
  for (const p of paths) {
    if (S.motionOn) p.off += p.sp * sm * 0.4;
  }

  // ── Spatial drift: sine-wave oscillation within the bleed zone ───
  // Spatial 1: horizontal only (±120px X)
  // Spatial 2: figure-8 Lissajous (±85px X, ±50px Y at double-freq) — gentle organic undulation
  // Spatial 3: sphere globe projection — full rotation every 10s, passive mode only
  const isSpatial = S.movement === 'spatial'  || S.movement === 'spatial2'
                 || S.movement === 'spatial3';
  // Delta-time advancement: spatialX advances at fixed rad/s regardless of display Hz.
  // Spatial 1 & 2: 2π/10s (one drift cycle = 10s). Spatial 3: 2π/30s (one globe rotation = 30s).
  const dt = Math.min((ts - lastDrawTime) / 1000, 0.1);  // seconds, capped to avoid jumps
  // Rolling display-FPS measurement (used by video export to match live speed)
  if (lastDrawTime > 0 && dt > 0.005 && dt < 0.1) {
    _dfpsAcc += 1 / dt; _dfpsN++;
    if (_dfpsN >= 60) { _displayFPS = _dfpsAcc / _dfpsN; _dfpsAcc = 0; _dfpsN = 0; }
  }
  lastDrawTime = ts;
  if (isSpatial) {
    const radPerSec = (S.movement === 'spatial3') ? (2 * Math.PI / 30) : (2 * Math.PI / 10);
    S.spatialX += radPerSec * dt;
  }
  const drift  = S.movement === 'spatial'  ? Math.sin(S.spatialX) * 120
               : S.movement === 'spatial2' ? Math.sin(S.spatialX) * 85
               : 0;  // spatial3 uses sphere projection, no translation
  const driftY = S.movement === 'spatial2' ? Math.sin(S.spatialX * 2) * 50
               : 0;
  S.driftY = driftY;

  // Networks in spatial mode: rebuild periodically so edge clipping
  // stays aligned with the drifting rectangle position.
  if (isSpatial && S.shapes.length > 0 && S.pattern === 'networks') {
    if (draw._lastDrift === undefined) { draw._lastDrift = drift; draw._lastDriftY = driftY; }
    if (Math.abs(drift - draw._lastDrift) > 8 || Math.abs(driftY - draw._lastDriftY) > 8) {
      draw._lastDrift = drift; draw._lastDriftY = driftY;
      rebuild();
    }
  }

  // ── Clear + fill background ───────────────────────────────────────
  cx.clearRect(0, 0, W, H);
  cx.fillStyle = S.canvasBg;
  cx.fillRect(0, 0, W, H);

  // ── Draw paths + nodes ────────────────────────────────────────────
  if (S.movement === 'spatial3') {
    // ── Spatial 3: sphere-native geometry — no equirectangular projection ──
    // All paths built natively on the unit sphere (pts3D arrays).
    const s4rot = S.spatialX;
    const SR = Math.min(W, H) * 0.44;

    cx.save();
    cx.beginPath();
    cx.arc(W * 0.5, H * 0.5, SR, 0, Math.PI * 2);
    cx.clip();

    for (const p of paths) {
      if (!p.pts3D || p.pts3D.length < 2) continue;
      drawUnitsOnSphere3D(cx, p.pts3D, p.off, S.lineColor, s4rot, undefined, pathRadialVal(p));
    }

    // Network node dots — projected from native 3D positions
    if (S.pattern === 'networks' && S.networkNodes3D) {
      cx.fillStyle = S.lineColor;
      for (const nd of S.networkNodes3D) {
        const pp = project3D(nd, s4rot);
        if (pp) { cx.beginPath(); cx.arc(pp.x, pp.y, CR, 0, Math.PI * 2); cx.fill(); }
      }
    }

    cx.restore();

  } else {
    // ── All other modes: translate + draw ────────────────────────────
    cx.save();
    cx.translate(drift, driftY);

    // Clip a screen-fixed rectangular void so the gap stays anchored to the
    // rectangle even when patterns drift in spatial mode.
    if (S.shapes.length > 0 && (S.pattern === 'city' || S.pattern === 'networks' || S.pattern === 'terrain')) {
      const CBLEED = 400;
      cx.beginPath();
      cx.rect(-CBLEED - Math.abs(drift), -CBLEED - Math.abs(driftY),
              W + CBLEED * 2 + Math.abs(drift) * 2, H + CBLEED * 2 + Math.abs(driftY) * 2);
      for (const sh of S.shapes) {
        cx.rect(sh.x - drift, sh.y - driftY, sh.w, sh.h);
      }
      cx.clip('evenodd');
    }

    for (const p of paths) {
      if (p.screenFixed) continue;

      // City blocks: re-clip blockPoly against shapes every frame
      if (p.blockPoly && S.shapes.length > 0) {
        const halfRd = p.blockRoadW * 0.5;
        const MIN_BLK = p.blockRoadW * 0.8;
        let fragments = [p.blockPoly];
        for (const sh of S.shapes) {
          const rx = sh.x - drift - halfRd, ry = sh.y - halfRd;
          const rw = sh.w + p.blockRoadW, rh = sh.h + p.blockRoadW;
          const next = [];
          for (const poly of fragments) {
            const clipped = clipPolyByRect(poly, rx, ry, rw, rh);
            for (const frag of clipped) next.push(frag);
          }
          fragments = next;
        }
        for (const frag of fragments) {
          let fMinX = Infinity, fMaxX = -Infinity, fMinY = Infinity, fMaxY = -Infinity;
          for (const pt of frag) {
            if (pt.x < fMinX) fMinX = pt.x; if (pt.x > fMaxX) fMaxX = pt.x;
            if (pt.y < fMinY) fMinY = pt.y; if (pt.y > fMaxY) fMaxY = pt.y;
          }
          if (fMaxX - fMinX < MIN_BLK || fMaxY - fMinY < MIN_BLK) continue;
          // Chamfer corners before sampling so flattenPath rounds them into smooth arcs
          const chamfered = chamferPoly(frag, p.blockRoadW * 0.55);
          const ring = [...chamfered, chamfered[0]];
          const fragPts = [];
          for (let i = 0; i < ring.length - 1; i++) {
            const a = ring[i], b = ring[i + 1];
            const ex = b.x - a.x, ey = b.y - a.y;
            const steps = Math.ceil(Math.hypot(ex, ey) / 8);
            for (let j = 0; j < steps; j++) {
              const t = j / steps;
              fragPts.push({ x: a.x + ex * t, y: a.y + ey * t });
            }
          }
          fragPts.push(fragPts[0]);
          if (fragPts.length > 4) drawUnits(cx, flattenPath(fragPts), p.off, S.lineColor, undefined, pathRadialVal(p));
        }
        continue;
      }

      // Use pre-computed flat when available (e.g. terrain), UNLESS terrain has shapes —
      // in that case deformPath must run to split paths at shape boundaries (uses p.pts).
      const needsDeform = S.pattern === 'terrain' && S.shapes.length > 0;
      if (p.flat && !needsDeform) {
        drawUnits(cx, p.flat, p.off, S.lineColor, undefined, pathRadialVal(p));
      } else {
        const subs = deformPath(p, drift);
        for (const flat_r of subs) drawUnits(cx, flat_r, p.off, S.lineColor, undefined, pathRadialVal(p));
      }
    }

    if (S.pattern === 'networks' && S.networkNodes) {
      cx.fillStyle = S.lineColor;
      for (const n of S.networkNodes) {
        cx.beginPath();
        cx.arc(n.x, n.y, CR, 0, Math.PI * 2);
        cx.fill();
      }
    }

    cx.restore();
  }

  // Fill rectangle voids before drawing perimeter lines so the fill sits behind them
  if (S.shapes.length > 0) {
    for (const sh of S.shapes) {
      cx.fillStyle = S.canvasBg;
      cx.fillRect(sh.x, sh.y, sh.w, sh.h);
    }
  }

  // ── Screen-fixed paths (e.g. network rectangle perimeter) ──────────
  for (const p of paths) {
    if (!p.screenFixed) continue;
    const flat_r = flattenPath(p.pts);
    drawUnits(cx, flat_r, p.off, S.lineColor, undefined, pathRadialVal(p));
  }

  // ── Network: dynamic corner-to-node connections + corner dots ──
  // Drawn every frame so connections track the nearest node as the
  // pattern drifts in spatial mode. Each corner connects to the closest
  // node in screen space.
  if (S.pattern === 'networks' && S.networkNodes && S.shapes.length > 0) {
    for (const sh of S.shapes) {
      const corners = [
        { x: sh.x, y: sh.y }, { x: sh.x + sh.w, y: sh.y },
        { x: sh.x + sh.w, y: sh.y + sh.h }, { x: sh.x, y: sh.y + sh.h }
      ];
      for (const c of corners) {
        // Find nearest node in screen space
        let bestD = Infinity, bestN = null;
        for (const n of S.networkNodes) {
          const d = Math.hypot(c.x - (n.x + drift), c.y - (n.y + driftY));
          if (d < bestD) { bestD = d; bestN = n; }
        }
        if (bestN && bestD < 600) {
          // Draw connection line from corner (screen) to node (screen)
          const nx = bestN.x + drift, ny = bestN.y + driftY;
          const dx = nx - c.x, dy = ny - c.y;
          const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 6));
          const pts = [];
          for (let j = 0; j <= steps; j++) {
            const t = j / steps;
            pts.push({ x: c.x + dx * t, y: c.y + dy * t });
          }
          drawUnits(cx, flattenPath(pts), 0, S.lineColor);
        }
        // Corner dot
        cx.fillStyle = S.lineColor;
        cx.beginPath();
        cx.arc(c.x, c.y, CR, 0, Math.PI * 2);
        cx.fill();
      }
    }
  }

  // ── Rectangle obstacles — always at fixed canvas coords ──
  for (const sh of S.shapes) {
    cx.save();
    cx.strokeStyle = S.lineColor;
    cx.lineWidth = 1.5;
    cx.setLineDash([5, 5]);
    cx.globalAlpha = 0.45;
    cx.strokeRect(sh.x, sh.y, sh.w, sh.h);
    cx.restore();
    // Corner resize handles
    cx.save();
    cx.fillStyle = S.lineColor;
    cx.globalAlpha = 0.7;
    for (const h of getShapeHandles(sh)) {
      cx.beginPath();
      cx.arc(h.x, h.y, 5, 0, Math.PI * 2);
      cx.fill();
    }
    cx.restore();
  }
}

let animId;
let lastDrawTime = 0;
let _displayFPS = 60;  // rolling average of screen refresh rate, used by video export
let _dfpsAcc = 0, _dfpsN = 0;
(function loop(ts) { lastDrawTime = lastDrawTime || ts; draw(ts); animId = requestAnimationFrame(loop); })(performance.now());

// ================================================================
// CANVAS INTERACTION
// ================================================================
cv.addEventListener('mousemove', e => {
  const r = cv.getBoundingClientRect();
  S.mx = e.clientX - r.left; S.my = e.clientY - r.top;
});

cv.addEventListener('mouseleave', () => { S.mx=-9999; S.my=-9999; });

// ================================================================
// MENU TOGGLE (panel open/close — Art of Noise style)
// ================================================================
const menuToggle = document.getElementById('menuToggle');
const panelEl    = document.getElementById('panel');
const layout     = document.getElementById('layout');

menuToggle.addEventListener('click', () => {
  // close any open dropdowns first
  document.querySelectorAll('.select-menu.is-open').forEach(m => {
    m.classList.remove('is-open');
    m.closest('.select-wrap').classList.remove('is-open');
  });
  const isOpen = menuToggle.dataset.state === 'open';
  if (isOpen) {
    panelEl.classList.add('panel--closed');
    layout.classList.add('layout--panel-closed');
    menuToggle.dataset.state = 'closed';
    menuToggle.setAttribute('aria-label', 'Open menu');
  } else {
    panelEl.classList.remove('panel--closed');
    layout.classList.remove('layout--panel-closed');
    menuToggle.dataset.state = 'open';
    menuToggle.setAttribute('aria-label', 'Close menu');
  }
});

// ================================================================
// INFO PANEL TOGGLE
// ================================================================
const infoToggle = document.getElementById('infoToggle');
const infoPanel  = document.getElementById('infoPanel');

infoToggle.addEventListener('click', () => {
  const isOpen = infoToggle.dataset.state === 'open';
  if (isOpen) {
    infoPanel.classList.add('info-panel--closed');
    infoToggle.dataset.state = 'closed';
    infoToggle.setAttribute('aria-label', 'Open instructions');
    document.body.classList.remove('info-open');
  } else {
    infoPanel.classList.remove('info-panel--closed');
    infoToggle.dataset.state = 'open';
    infoToggle.setAttribute('aria-label', 'Close instructions');
    document.body.classList.add('info-open');
  }
});

// ================================================================
// CUSTOM SELECT DROPDOWNS (Art of Noise style)
// ================================================================
function buildSelect(wrapperId, triggerId, menuId, labelId, onChange) {
  const wrap    = document.getElementById(wrapperId);
  const trigger = document.getElementById(triggerId);
  const menu    = document.getElementById(menuId);
  const label   = document.getElementById(labelId);

  // Move menu to body so position:fixed is viewport-relative.
  // backdrop-filter on the panel creates a new containing block that shifts
  // fixed children — moving to body avoids this entirely.
  menu._wrap    = wrap;
  menu._trigger = trigger;
  document.body.appendChild(menu);

  function positionMenu() {
    const r = trigger.getBoundingClientRect();
    menu.style.top   = (r.bottom + 6) + 'px';
    menu.style.left  = r.left + 'px';
    menu.style.width = r.width + 'px';
  }

  function closeMenu() {
    menu.classList.remove('is-open');
    wrap.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
  }

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const opening = !menu.classList.contains('is-open');
    // close all other menus first (use stored refs instead of closest())
    document.querySelectorAll('.select-menu.is-open').forEach(m => {
      m.classList.remove('is-open');
      if (m._wrap)    m._wrap.classList.remove('is-open');
      if (m._trigger) m._trigger.setAttribute('aria-expanded', 'false');
    });
    if (opening) {
      positionMenu();
      menu.classList.add('is-open');
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
    }
  });

  // Close on outside click
  document.addEventListener('click', closeMenu);

  // Reposition if panel scrolls
  document.querySelector('.panel__scroll').addEventListener('scroll', () => {
    if (menu.classList.contains('is-open')) positionMenu();
  });

  menu.querySelectorAll('.select-option').forEach(opt => {
    opt.addEventListener('click', e => {
      e.stopPropagation();
      menu.querySelectorAll('.select-option').forEach(o => o.setAttribute('aria-selected', 'false'));
      opt.setAttribute('aria-selected', 'true');
      label.textContent = opt.textContent;
      closeMenu();
      onChange(opt.dataset.val);
    });
  });
}

buildSelect('patternWrap','patternTrigger','patternMenu','patternLabel', val => {
  S.pattern = val; rebuild();
});

buildSelect('themeWrap','themeTrigger','themeMenu','themeLabel', val => {
  // Keep current inversion state when switching themes
  applyTheme(val, S.inverted);
});

document.getElementById('invertBtn').addEventListener('click', () => {
  S.inverted = !S.inverted;
  document.getElementById('invertBtn').classList.toggle('is-active', S.inverted);
  applyTheme(S.theme, S.inverted);
});

// ================================================================
// MOTION BUTTONS (btn / is-active pattern)
// ================================================================
function exclusive(aId, bId, onA, onB) {
  const a = document.getElementById(aId);
  const b = document.getElementById(bId);
  a.addEventListener('click', () => { a.classList.add('is-active'); b.classList.remove('is-active'); onA(); });
  b.addEventListener('click', () => { b.classList.add('is-active'); a.classList.remove('is-active'); onB(); });
}

document.getElementById('mMotion').addEventListener('click', () => {
  S.motionOn = !S.motionOn;
  document.getElementById('mMotion').classList.toggle('is-active', S.motionOn);
});
// 4-way movement toggle: Fixed / Spatial 1 / Spatial 2 (figure-8) / Spatial 3 (sphere)
const movementIds = ['mFixed','mSpatial','mSpatial2','mSpatial3'];
const movementVals = { mFixed:'fixed', mSpatial:'spatial', mSpatial2:'spatial2', mSpatial3:'spatial3' };
movementIds.forEach(id => {
  document.getElementById(id).addEventListener('click', () => {
    movementIds.forEach(i => document.getElementById(i).classList.remove('is-active'));
    document.getElementById(id).classList.add('is-active');
    const prevMovement = S.movement;
    S.movement = movementVals[id];
    S.spatialX = 0; S.driftY = 0;
    // Rebuild whenever entering or leaving spatial3 — geometry is fundamentally different
    const is3D = S.movement === 'spatial3';
    const was3D = prevMovement === 'spatial3';
    if (is3D || was3D) {
      S.networkNodes = null; S.networkNodes3D = null;
      rebuild();
    }
  });
});

// ================================================================
// SLIDERS (native range)
// ================================================================
function rebuildWithTransition() {
  rebuild(); // instant step — no fade, no flash
}

function setupSlider(rangeId, badgeId, isInt, cb) {
  const range = document.getElementById(rangeId);
  const badge = document.getElementById(badgeId);
  range.addEventListener('input', () => {
    const v = isInt ? parseInt(range.value) : parseInt(range.value)/100;
    badge.textContent = isInt ? v : range.value+'%';
    cb(v);
  });
}

setupSlider('speedRange',   'speedBadge',   false, v => S.speed = v);
setupSlider('densityRange', 'densityBadge', false, v => { S.density = v; rebuildWithTransition(); });
setupSlider('seedRange',    'seedBadge',    true,  v => { S.seed = v; rebuildWithTransition(); });

document.getElementById('resetBtn').addEventListener('click', () => {
  // Reset only sliders — motion mode, spatial state preserved
  S.speed=.5; S.density=.5; S.seed=5;
  document.getElementById('speedRange').value   = 50;
  document.getElementById('densityRange').value = 50;
  document.getElementById('seedRange').value    = 5;
  document.getElementById('speedBadge').textContent   = '50%';
  document.getElementById('densityBadge').textContent = '50%';
  document.getElementById('seedBadge').textContent    = '5';
  S.motionOn = true;
  document.getElementById('mMotion').classList.add('is-active');
  // Reset invert
  document.getElementById('invertBtn').classList.remove('is-active');
  applyTheme(S.theme, false);
  rebuildWithTransition(); toast('Reset');
});

// ================================================================
// TOAST
// ================================================================
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

// ================================================================
// EXPORTS
// ================================================================

// CRC32 for PNG pHYs DPI injection
const _crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function _crc32(buf, start, end) {
  let crc = 0xFFFFFFFF;
  for (let i = start; i < end; i++) crc = _crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function injectPNGpHYs(arrayBuf, dpi) {
  const ppm = Math.round(dpi / 0.0254); // pixels per meter
  const src = new Uint8Array(arrayBuf);
  // pHYs chunk: 4(len)+4(type)+9(data)+4(crc) = 21 bytes
  const phys = new Uint8Array(21);
  phys[3] = 9; // length = 9
  phys[4]=0x70; phys[5]=0x48; phys[6]=0x59; phys[7]=0x73; // "pHYs"
  phys[8]=(ppm>>24)&0xFF; phys[9]=(ppm>>16)&0xFF; phys[10]=(ppm>>8)&0xFF; phys[11]=ppm&0xFF; // X ppm
  phys[12]=(ppm>>24)&0xFF; phys[13]=(ppm>>16)&0xFF; phys[14]=(ppm>>8)&0xFF; phys[15]=ppm&0xFF; // Y ppm
  phys[16] = 1; // unit = meter
  const c = _crc32(phys, 4, 17);
  phys[17]=(c>>24)&0xFF; phys[18]=(c>>16)&0xFF; phys[19]=(c>>8)&0xFF; phys[20]=c&0xFF;
  // Insert after IHDR (8 sig + 25 IHDR = byte 33)
  const out = new Uint8Array(src.length + 21);
  out.set(src.slice(0, 33)); out.set(phys, 33); out.set(src.slice(33), 54);
  return out;
}

// Draw network corner-to-node connections in the CURRENT context coordinate space.
// Call this inside an already-scaled context (same level as paths), with drift in screen-space.
function drawNetworkCornerConnections(ctx, drift, driftY = 0) {
  if (S.pattern !== 'networks' || !S.networkNodes || !S.shapes.length) return;
  for (const sh of S.shapes) {
    const corners = [
      { x: sh.x, y: sh.y }, { x: sh.x + sh.w, y: sh.y },
      { x: sh.x + sh.w, y: sh.y + sh.h }, { x: sh.x, y: sh.y + sh.h }
    ];
    for (const c of corners) {
      let bestD = Infinity, bestN = null;
      for (const n of S.networkNodes) {
        const d = Math.hypot(c.x - (n.x + drift), c.y - (n.y + driftY));
        if (d < bestD) { bestD = d; bestN = n; }
      }
      if (bestN && bestD < 600) {
        const nx = bestN.x + drift, ny = bestN.y + driftY;
        const dx = nx - c.x, dy = ny - c.y;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 6));
        const pts = [];
        for (let j = 0; j <= steps; j++) {
          const t = j / steps;
          pts.push({ x: c.x + dx * t, y: c.y + dy * t });
        }
        drawUnits(ctx, flattenPath(pts), 0, S.lineColor);
      }
      ctx.fillStyle = S.lineColor;
      ctx.beginPath();
      ctx.arc(c.x, c.y, CR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Draw rectangle perimeter edges with drawUnits treatment (same as pattern lines).
// ctx must be in scaled world-space coordinates. Used after void punch so outlines
// appear on top of the empty void area.
function drawExportPerimeters(ctx) {
  // Network: screenFixed perimeter paths already built in paths array
  for (const p of paths) {
    if (!p.screenFixed) continue;
    drawUnits(ctx, flattenPath(p.pts), p.off, S.lineColor, undefined, pathRadialVal(p));
  }
  // City: no perimeter lines in export — the void gap speaks for itself
}

// Draw all paths into ctx (already in scaled + drift-translated space).
// City blocks are re-clipped against shapes with road spacing. No canvas clip used here —
// the caller must punch the void with clearRect/fillRect after this returns.
function drawExportPaths(ctx, drift, drawProgress) {
  for (const p of paths) {
    if (p.screenFixed) continue;
    // City blocks: re-clip against shapes each frame (mirrors live draw logic)
    if (p.blockPoly && S.shapes.length > 0) {
      const halfRd = p.blockRoadW * 0.5;
      const MIN_BLK = p.blockRoadW * 0.8;
      let fragments = [p.blockPoly];
      for (const sh of S.shapes) {
        const rx = sh.x - drift - halfRd, ry = sh.y - halfRd;
        const rw = sh.w + p.blockRoadW, rh = sh.h + p.blockRoadW;
        const next = [];
        for (const poly of fragments) {
          for (const frag of clipPolyByRect(poly, rx, ry, rw, rh)) next.push(frag);
        }
        fragments = next;
      }
      for (const frag of fragments) {
        let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
        for (const pt of frag) {
          if (pt.x<minX) minX=pt.x; if (pt.x>maxX) maxX=pt.x;
          if (pt.y<minY) minY=pt.y; if (pt.y>maxY) maxY=pt.y;
        }
        if (maxX-minX < MIN_BLK || maxY-minY < MIN_BLK) continue;
        const chamfered = chamferPoly(frag, p.blockRoadW * 0.55);
        const ring = [...chamfered, chamfered[0]];
        const pts = [];
        for (let i=0; i<ring.length-1; i++) {
          const a=ring[i], b=ring[i+1];
          const steps = Math.ceil(Math.hypot(b.x-a.x, b.y-a.y) / 8);
          for (let j=0; j<steps; j++) { const t=j/steps; pts.push({x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t}); }
        }
        pts.push(pts[0]);
        drawUnits(ctx, flattenPath(pts), p.off, S.lineColor, drawProgress, pathRadialVal(p));
      }
    } else {
      const subs = deformPath(p, drift);
      for (const flat_r of subs) drawUnits(ctx, flat_r, p.off, S.lineColor, drawProgress, pathRadialVal(p));
    }
  }
}

// Draw sphere projection into ctx (ctx must already be scaled to export dimensions).
// rotAngle drives the globe spin. The caller fills the background before calling this.
function drawExportSphere(ctx, rotAngle, drawProgress) {
  const SR = Math.min(W, H) * 0.44;
  ctx.save();
  ctx.beginPath();
  ctx.arc(W * 0.5, H * 0.5, SR, 0, Math.PI * 2);
  ctx.clip();

  // For intro/outro, stagger each path so they cascade in/out rather than all drawing
  // simultaneously. Without staggering the effect is invisible on the sphere because
  // individual sphere paths are short — each reveals only a few dash units per step.
  // With STAGGER=0.5, path 0 leads the draw-in; the last path lags by half the range.
  // The per-path remapping preserves the easing already applied to the global drawProgress.
  const validPaths = paths.filter(p => p.pts3D && p.pts3D.length >= 2);
  const N = validPaths.length;
  const STAGGER = 0.5;

  for (let i = 0; i < N; i++) {
    const p = validPaths[i];
    let pathDP = drawProgress;
    if (drawProgress > 0 && drawProgress < 1 && N > 1) {
      const startAt = (i / (N - 1)) * STAGGER;
      pathDP = Math.max(0, Math.min(1, (drawProgress - startAt) / (1 - STAGGER)));
    }
    drawUnitsOnSphere3D(ctx, p.pts3D, p.off, S.lineColor, rotAngle, pathDP, pathRadialVal(p));
  }

  if (S.pattern === 'networks' && S.networkNodes3D) {
    ctx.fillStyle = S.lineColor;
    for (const nd of S.networkNodes3D) {
      const pp = project3D(nd, rotAngle);
      if (pp) { ctx.beginPath(); ctx.arc(pp.x, pp.y, CR, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  ctx.restore();
}

function renderPatternToCanvas(ew, eh) {
  // Pause the live animation and snapshot current offsets for seamless resumption
  cancelAnimationFrame(animId);
  const savedW = W, savedH = H;
  const liveOff = paths.map(p => p.off);

  // Rebuild at 16:9 reference so sx/sy are always a uniform scale regardless of viewport shape
  // (cv.width / cv.height are intentionally NOT changed — only the path-generation variables)
  W = 1920; H = 1080;
  rebuild();

  const tc = document.createElement('canvas'); tc.width=ew; tc.height=eh;
  const tx = tc.getContext('2d');
  const sx = ew / W, sy = eh / H;

  if (S.movement === 'spatial3') {
    // Sphere export: transparent background (PNG), bg added by JPG handler separately
    tx.save(); tx.scale(sx, sy);
    drawExportSphere(tx, S.spatialX);
    tx.restore();
  } else {
    // Phase 1: Draw pattern paths (city blocks re-clipped, network lines, terrain splits)
    tx.save();
    tx.scale(sx, sy);
    drawExportPaths(tx, 0);
    tx.restore();

    // Phase 2: Punch void — clearRect creates transparent hole (PNG) or lets JPG bg show through
    if (S.shapes.length > 0 && (S.pattern === 'city' || S.pattern === 'networks')) {
      for (const sh of S.shapes) {
        tx.clearRect(sh.x * sx, sh.y * sy, sh.w * sx, sh.h * sy);
      }
    }

    // Phase 3: Draw perimeters + connections ON TOP of the void boundary
    tx.save();
    tx.scale(sx, sy);
    drawExportPerimeters(tx);
    drawNetworkCornerConnections(tx, 0);
    tx.restore();
  }

  // Restore live state — cv dimensions were never touched, so no canvas clear occurs
  W = savedW; H = savedH;
  rebuild();
  paths.forEach((p, i) => { if (i < liveOff.length) p.off = liveOff[i]; });
  (function liveLoop() { draw(); animId = requestAnimationFrame(liveLoop); })();

  return tc;
}

/// PNG: 3840×2160 @ 150dpi, transparent background
document.getElementById('exPng').addEventListener('click', () => {
  const tc = renderPatternToCanvas(7680, 4320);
  tc.toBlob(blob => {
    blob.arrayBuffer().then(buf => {
      const patched = injectPNGpHYs(buf, 150);
      const url = URL.createObjectURL(new Blob([patched], { type: 'image/png' }));
      const a = document.createElement('a'); a.download='pattern.png'; a.href=url; a.click();
      URL.revokeObjectURL(url);
      toast('Exported pattern.png (7680×4320 @ 150dpi, transparent)');
    });
  }, 'image/png');
});

// JPG: 3840×2160 @ 300dpi, with background
document.getElementById('exJpg').addEventListener('click', () => {
  const EW = 7680, EH = 4320;
  const pattern = renderPatternToCanvas(EW, EH);
  const tc = document.createElement('canvas'); tc.width=EW; tc.height=EH;
  const tx = tc.getContext('2d');
  tx.fillStyle = S.canvasBg; tx.fillRect(0, 0, EW, EH);
  tx.drawImage(pattern, 0, 0);
  tc.toBlob(blob => {
    blob.arrayBuffer().then(buf => {
      // Patch JFIF APP0 header to set 300dpi
      // Structure: FF D8 | FF E0 | len(2) | "JFIF\0"(5) | ver(2) | units(1) | xdpi(2) | ydpi(2)
      const arr = new Uint8Array(buf);
      arr[13] = 1;          // units = DPI
      arr[14] = 1; arr[15] = 0x2C; // X density = 300
      arr[16] = 1; arr[17] = 0x2C; // Y density = 300
      const url = URL.createObjectURL(new Blob([arr], { type: 'image/jpeg' }));
      const a = document.createElement('a'); a.download='pattern.jpg'; a.href=url; a.click();
      URL.revokeObjectURL(url);
      toast('Exported pattern.jpg (7680×4320 @ 300dpi)');
    });
  }, 'image/jpeg', 0.95);
});
document.getElementById('exSvg').addEventListener('click', () => {
  // Pause animation, snapshot offsets for seamless resumption
  cancelAnimationFrame(animId);
  const savedW = W, savedH = H;
  const liveOff = paths.map(p => p.off);

  // Rebuild at 1920×1080 so SVG geometry is always viewport-independent
  // (cv dimensions intentionally not changed to avoid clearing the live canvas)
  W = 1920; H = 1080;
  rebuild();

  let body = '';
  // Build unit positions for each path and emit SVG circles + rects
  for (const p of paths) {
    const rv = pathRadialVal(p);
    const col = (S.colorMode === 'radial' && rv != null)
      ? lerpColor(S.radialColorA, S.radialColorB, rv)
      : S.lineColor;
    const subs = deformPath(p, 0);
    for (const flat of subs) {
    if (flat.length < 2) continue;
    const dists = [0];
    for (let i=1;i<flat.length;i++) dists.push(dists[i-1]+Math.hypot(flat[i].x-flat[i-1].x,flat[i].y-flat[i-1].y));
    const totalLen = dists[dists.length-1];
    const atDFn = d => pointAtDistance(flat, dists, totalLen, d);
    for (let d=-(p.off%UNIT);d<totalLen;d+=UNIT) {
      // Circle unit
      const cD=d+CR;
      if(cD>=-CR&&cD<=totalLen+CR){const pt=atDFn(cD);body+=`<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${CR}" fill="${col}"/>\n`;}
      // Bar unit — polygon ribbon that bends along the path (matches canvas drawUnits exactly)
      const bStart=d+CR*2+GAP, bEnd=bStart+BW;
      if(bEnd>=0&&bStart<=totalLen){
        const cs=Math.max(0,bStart), ce=Math.min(totalLen,bEnd);
        const steps=Math.max(2,Math.ceil((ce-cs)/3));
        const top=[], bot=[];
        for(let si=0;si<=steps;si++){
          const pt=atDFn(cs+(ce-cs)*si/steps);
          const nx=-Math.sin(pt.angle), ny=Math.cos(pt.angle);
          top.push(`${(pt.x+nx*BH/2).toFixed(1)},${(pt.y+ny*BH/2).toFixed(1)}`);
          bot.push(`${(pt.x-nx*BH/2).toFixed(1)},${(pt.y-ny*BH/2).toFixed(1)}`);
        }
        body+=`<polygon points="${[...top,...bot.reverse()].join(' ')}" fill="${col}"/>\n`;
      }
    }
    }
  }
  const nodeCol = S.colorMode === 'radial' ? lerpColor(S.radialColorA, S.radialColorB, 0) : S.lineColor;
  if(S.networkNodes){for(const n of S.networkNodes){const d=repulse(n.x,n.y,0);body+=`<circle cx="${(n.x+d.ox).toFixed(1)}" cy="${(n.y+d.oy).toFixed(1)}" r="${CR}" fill="${nodeCol}"/>\n`;}}

  const bgRect = `<rect width="${W}" height="${H}" fill="${S.canvasBg}"/>\n`;
  const svg=`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">\n${bgRect}<g>\n${body}</g>\n</svg>`;

  // Restore live state — cv dimensions were never changed, so no canvas clear occurs
  W = savedW; H = savedH;
  rebuild();
  paths.forEach((p, i) => { if (i < liveOff.length) p.off = liveOff[i]; });
  (function liveLoop() { draw(); animId = requestAnimationFrame(liveLoop); })();

  const a=document.createElement('a'); a.download='pattern.svg';
  a.href=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'})); a.click();
  toast('Exported SVG');
});

// ================================================================
// SHARED VIDEO RECORDING — supports loop, intro, outro modes
// ================================================================
function recordVideo(mode) {
  if (S.recording) return;

  const FPS = 30;
  const sm = 0.5 + S.speed * 3;
  // fpsFactor compensates for the display refresh rate vs 30fps export.
  // Live preview advances p.off at displayFPS per second; export runs at 30fps.
  // We scale the target advance per export-frame accordingly so the visual speed matches.
  const fpsFactor = Math.max(1, _displayFPS / FPS);
  // FRAMES_BASE: chosen so that 1 UNIT of advance at minimum p.sp exactly fits in one loop.
  // Formula: UNIT / (SP_MIN * sm * 0.4 * fpsFactor). Clamped to [60, 900].
  // This automatically shortens the loop at high speed and lengthens it at low speed,
  // always keeping quantization error small so adjustedStep ≈ natural screen speed.
  const SP_MIN = 0.15;  // minimum p.sp used by all pattern builders
  const FRAMES_BASE = S.movement === 'spatial3' ? 900
    : Math.max(60, Math.min(900, Math.round(UNIT / (SP_MIN * sm * 0.4 * fpsFactor))));
  const INTRO_FRAMES = 45;  // 1.5s at 30fps
  const SPATIAL_STEP = (2 * Math.PI) / FRAMES_BASE;
  // canonicalOff is captured right after rebuild so every clip (intro, loop, outro)
  // shares the same frame-0 reference — the only way clips tile seamlessly when
  // exported at different times.
  const liveOff  = paths.map(p => p.off);           // capture before rebuild so live preview can resume
  // Rebuild at fixed 1920×1080 so all video frames are always correctly proportioned
  const savedW = W, savedH = H;
  W = 1920; H = 1080;
  rebuild();
  const savedOff = canonicalOff ? [...canonicalOff] : paths.map(p => p.off);

  // easeOut for intro (lines rush in), easeIn for outro (lines fade out slowly)
  const easeOut  = (t) => 1 - Math.pow(1 - t, 3);
  const easeIn   = (t) => t * t * t;

  let TOTAL_FRAMES, OUTRO_START, exportFileName, toastMsg;
  if (mode === 'loop') {
    TOTAL_FRAMES = FRAMES_BASE;
    exportFileName = 'pattern-loop.mp4';
    toastMsg = `Exported pattern-loop.mp4 (${Math.round(FRAMES_BASE / FPS)}s)`;
  } else if (mode === 'intro') {
    TOTAL_FRAMES = INTRO_FRAMES + FRAMES_BASE;
    exportFileName = 'pattern-intro.mp4';
    toastMsg = `Exported pattern-intro.mp4 (${Math.round(TOTAL_FRAMES / FPS)}s)`;
  } else {
    TOTAL_FRAMES = FRAMES_BASE + INTRO_FRAMES;
    OUTRO_START = FRAMES_BASE;
    exportFileName = 'pattern-outro.mp4';
    toastMsg = `Exported pattern-outro.mp4 (${Math.round(TOTAL_FRAMES / FPS)}s)`;
  }

  // Quantize dash speeds: target advance per export-frame = p.sp * sm * 0.4 * fpsFactor
  // (fpsFactor scales from display-fps to 30fps so the visual speed matches the live preview).
  // Round to nearest integer nLoops of UNIT so the loop ends exactly where it started.
  // Math.max(1,...) ensures no path is ever frozen.
  const adjustedSteps = paths.map(p => {
    const rawTotal = p.sp * sm * 0.4 * fpsFactor * FRAMES_BASE;
    const nLoops = Math.max(1, Math.round(rawTotal / UNIT));
    return (nLoops * UNIT) / FRAMES_BASE;
  });

  const btn = document.getElementById(
    mode === 'loop' ? 'exVideo' : mode === 'intro' ? 'exIntro' : 'exOutro'
  );
  const modal = document.getElementById('export-modal');
  const bar   = document.getElementById('export-modal__bar');
  const pct   = document.getElementById('export-modal__pct');
  const lbl   = document.getElementById('export-modal__label');

  const mp4Types = [
    'video/mp4; codecs="avc1.42E01E"',
    'video/mp4; codecs="avc1"',
    'video/mp4; codecs="h264"',
    'video/mp4',
  ];
  const mimeType = mp4Types.find(t => MediaRecorder.isTypeSupported(t));
  if (!mimeType) {
    toast('H.264 MP4 not supported in this browser — try Chrome or Safari');
    return;
  }

  S.recording = true; btn.classList.add('is-recording');
  btn.textContent = '● Recording…';
  lbl.textContent = mode === 'loop' ? 'Exporting Animation' : mode === 'intro' ? 'Exporting Intro' : 'Exporting Outro';
  bar.style.width = '0%'; pct.textContent = '0%';
  modal.setAttribute('aria-hidden', 'false');
  cancelAnimationFrame(animId);

  function cleanup() {
    W = savedW; H = savedH;                           // restore live canvas dimensions
    rebuild();
    paths.forEach((p, i) => { if (i < liveOff.length) p.off = liveOff[i]; });  // resume live preview
    S.recording = false; btn.classList.remove('is-recording');
    btn.textContent = mode === 'loop' ? 'Animation' : mode === 'intro' ? 'Intro' : 'Outro';
    modal.setAttribute('aria-hidden', 'true');
    (function loop() { draw(); animId = requestAnimationFrame(loop); })();
  }

  const EW = 1920, EH = 1080;
  const oc = document.createElement('canvas'); oc.width = EW; oc.height = EH;
  const octx = oc.getContext('2d');

  // animFrame is always in [0, FRAMES_BASE-1], ensuring seamless loop alignment.
  // drawVideoFrame uses animFrame (not raw f) so drift and sphere rotation also loop cleanly.
  function drawVideoFrame(animFrame, drawProgress) {
    const sx = EW / W, sy = EH / H;

    octx.fillStyle = S.canvasBg;
    octx.fillRect(0, 0, EW, EH);

    if (S.movement === 'spatial3') {
      const s4rot = (animFrame / FRAMES_BASE) * 2 * Math.PI;
      octx.save(); octx.scale(sx, sy);
      drawExportSphere(octx, s4rot, drawProgress);
      octx.restore();
      return;
    }

    const drift  = S.movement === 'spatial'  ? Math.sin(animFrame * SPATIAL_STEP) * 120
                 : S.movement === 'spatial2' ? Math.sin(animFrame * SPATIAL_STEP) * 85 : 0;
    const driftY = S.movement === 'spatial2' ? Math.sin(animFrame * SPATIAL_STEP * 2) * 50 : 0;

    octx.save();
    octx.scale(sx, sy);
    octx.save();
    octx.translate(drift, driftY);
    S.driftY = driftY;
    drawExportPaths(octx, drift, drawProgress);
    octx.restore();
    octx.restore();

    if (S.shapes.length > 0 && (S.pattern === 'city' || S.pattern === 'networks')) {
      octx.fillStyle = S.canvasBg;
      for (const sh of S.shapes) {
        octx.fillRect(sh.x * sx, sh.y * sy, sh.w * sx, sh.h * sy);
      }
    }

    octx.save();
    octx.scale(sx, sy);
    drawExportPerimeters(octx);
    drawNetworkCornerConnections(octx, drift, driftY);
    octx.restore();
  }

  const stream = oc.captureStream(FPS);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks = [];

  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.download = exportFileName; a.href = url; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(toastMsg + ' (1920×1080 H.264)');
    cleanup();
  };

  recorder.start(100);

  let f = 0;
  const MS_PER_FRAME = 1000 / FPS;
  let lastFrameTime = null;

  function renderNext(now) {
    if (lastFrameTime === null) lastFrameTime = now;
    if (now - lastFrameTime >= MS_PER_FRAME - 1) {
      lastFrameTime += MS_PER_FRAME;

      // Map global frame f to a loop-position animFrame in [0, FRAMES_BASE-1].
      //
      // LOOP:  animFrame = f   (0..FRAMES_BASE-1, straightforward)
      //
      // INTRO: draw-in phase runs over loop states [FB-INTRO_FRAMES .. FB-1],
      //        then the full loop follows at states [0 .. FB-1].
      //        This means the last intro frame (animFrame=FB-1) transitions
      //        to loop frame 0 via the normal seamless loop wrap — no jump.
      //        Formula: ((f - INTRO_FRAMES) % FB + FB) % FB
      //          f=0:            ((−45)%150+150)%150 = 105  (mid-loop, lines already moving)
      //          f=INTRO_FRAMES: ((0)%150+150)%150   = 0    (matches loop frame 0)
      //          f=last:         ((149)%150+150)%150 = 149  (matches loop frame 149)
      //
      // OUTRO: animFrame = f % FRAMES_BASE
      //        f=0..FB-1 → 0..FB-1 (identical to loop, seamless after loop clip)
      //        f=FB..FB+INTRO_FRAMES-1 wraps: 0..INTRO_FRAMES-1 (lines keep moving)
      let animFrame;
      if (mode === 'intro') {
        animFrame = ((f - INTRO_FRAMES) % FRAMES_BASE + FRAMES_BASE) % FRAMES_BASE;
      } else {
        // loop and outro both work with simple modulo
        animFrame = f % FRAMES_BASE;
      }

      // Draw progress: 1 normally, eases 0→1 during intro draw-in, 1→0 during outro draw-out
      let drawProgress = 1;
      if (mode === 'intro' && f < INTRO_FRAMES) {
        drawProgress = easeOut(f / INTRO_FRAMES);
      } else if (mode === 'outro' && f >= OUTRO_START) {
        drawProgress = 1 - easeIn((f - OUTRO_START) / INTRO_FRAMES);
      }

      // Advance dash offsets using the loop-mapped animFrame so they always move
      paths.forEach((p, i) => {
        p.off = savedOff[i] + animFrame * adjustedSteps[i];
      });

      drawVideoFrame(animFrame, drawProgress);
      const progress = Math.round((f + 1) / TOTAL_FRAMES * 100);
      bar.style.width = progress + '%';
      pct.textContent = progress + '%';
      f++;
      if (f >= TOTAL_FRAMES) {
        setTimeout(() => recorder.stop(), 300);
        return;
      }
    }
    requestAnimationFrame(renderNext);
  }

  requestAnimationFrame(renderNext);
}

document.getElementById('exVideo').addEventListener('click', () => recordVideo('loop'));
document.getElementById('exIntro').addEventListener('click', () => recordVideo('intro'));
document.getElementById('exOutro').addEventListener('click', () => recordVideo('outro'));

// ================================================================
// INIT — apply default theme and pattern on load
// ================================================================
(function initDefaults() {
  applyTheme('light', false);
})();

resize();

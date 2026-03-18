// ================================================================
// STATE
// ================================================================
const S = {
  pattern: 'terrain', theme: 'light',
  inverted: false,
  motionOn: true, mode: 'active',
  movement: 'fixed', spatialX: 0,
  speed: 0.5, density: 0.5, seed: 5,
  lineColor: '#FFFFFF', canvasBg: '#DFDFDF',
  shapes: [],
  mx: -9999, my: -9999, recording: false,
  networkNodes: null
};

// 4 base themes — Invert button swaps lc ↔ bg at runtime
const THEMES = {
  'light':   { lc: '#FFFFFF', bg: '#DFDFDF' },   // Light Gray bg / White pattern
  'color-1': { lc: '#063BE9', bg: '#FFFFFF' },   // White bg / Blue pattern
  'color-2': { lc: '#112AAC', bg: '#063BE9' },   // Blue bg / Darker-blue pattern
  'dark':    { lc: '#292929', bg: '#000000' },   // Black bg / Dark Gray pattern
};

// Returns true if a hex colour is perceptually light (needs dark panel text)
function isLight(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return (r*299 + g*587 + b*114) / 1000 > 128;
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

  const isMenuLight = (key === 'light');
  const isMenuBlue  = (key === 'color-1' && !inverted);
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
   * Generate deterministic permutation table from seed
   * Same seed → same permutation → reproducible noise
   */
  _permute: function(seed) {
    const perm = [];
    for (let i = 0; i < 256; i++) perm[i] = i;
    const rng = mkRand(seed);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    return perm;
  },

  /**
   * Core Perlin noise: 2D lattice gradient noise with Hermite interpolation
   * Returns normalized value in [-1, 1] range (clamped at ±0.95 to avoid spikes)
   */
  perlinNoise: function(x, y, seed) {
    const perm = this._permute(seed);
    const grads = this._gradients;

    // Lattice coordinates
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);

    // Hermite fade function (smooth interpolation)
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const u = fade(xf);
    const v = fade(yf);

    // Gradient indices at four corners
    const gi00 = perm[(perm[xi] + yi) & 255] & 15;
    const gi10 = perm[(perm[(xi + 1) & 255] + yi) & 255] & 15;
    const gi01 = perm[(perm[xi] + (yi + 1) & 255) & 255] & 15;
    const gi11 = perm[(perm[(xi + 1) & 255] + (yi + 1) & 255) & 255] & 15;

    // Gradient dot products
    const g00 = grads[gi00].x * xf + grads[gi00].y * yf;
    const g10 = grads[gi10].x * (xf - 1) + grads[gi10].y * yf;
    const g01 = grads[gi01].x * xf + grads[gi01].y * (yf - 1);
    const g11 = grads[gi11].x * (xf - 1) + grads[gi11].y * (yf - 1);

    // Interpolation
    const lerp = (t, a, b) => a + t * (b - a);
    const nx0 = lerp(u, g00, g10);
    const nx1 = lerp(u, g01, g11);
    const result = lerp(v, nx0, nx1);

    // Clamp to avoid harsh spikes; normalize for stable contours
    return Math.max(-0.95, Math.min(0.95, result)) * (1 / 0.95);
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
   * Smooth a polyline using Catmull-Rom spline interpolation
   */
  smoothCatmullRom: function(pts, tension = 0.5) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    const steps = 8;
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
   * Simple convex hull for network relaxation (Graham scan)
   */
  convexHull: function(pts) {
    if (pts.length < 3) return pts;
    const sorted = [...pts].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
    const lower = [];
    for (let p of sorted) {
      while (lower.length >= 2) {
        const last = lower[lower.length - 1];
        const prev = lower[lower.length - 2];
        if ((last.x - prev.x) * (p.y - prev.y) - (last.y - prev.y) * (p.x - prev.x) <= 0) {
          lower.pop();
        } else break;
      }
      lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2) {
        const last = upper[upper.length - 1];
        const prev = upper[upper.length - 2];
        if ((last.x - prev.x) * (p.y - prev.y) - (last.y - prev.y) * (p.x - prev.x) <= 0) {
          upper.pop();
        } else break;
      }
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  },

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
   * NEW: Smooth polyline using Catmull-Rom (reusable)
   */
  smoothPolylineSimple: function(pts, tension = 0.5) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    const steps = 4;  // Lower than Catmull-Rom for performance

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
  W = cv.width  = window.innerWidth;
  H = cv.height = window.innerHeight;
  rebuild();
}
window.addEventListener('resize', resize);

// ================================================================
// PATTERN GENERATORS — MODULAR ARCHITECTURE
// ================================================================
let paths = [];

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

  // Height function: fBm + tilt for directional variation
  function hAt(x, y) {
    const nx = x / Math.max(W, H);
    const ny = y / Math.max(W, H);

    // Core fBm: creates nested contour hierarchy with natural spacing
    let v = GEO.fBm(nx * 100, ny * 100, seed, octaves, persistence, lacunarity);

    // Optional amplitude modulation: subtle peaks to add visual interest
    // This replaces the Gaussian features with a more cohesive approach
    const modulation = 0.3 * Math.sin(nx * Math.PI * 2) * Math.cos(ny * Math.PI * 2);
    v = v * 0.8 + modulation * 0.2;

    // Global tilt: creates directional flow across terrain
    v += tiltX * (nx - 0.5) + tiltY * (ny - 0.5);

    return v;
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
        const pts = GEO.smoothCatmullRom(chain, 0.5);
        paths.push({ pts, off: r() * UNIT * 4, sp: 0.15 + r() * 0.25 });
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
        paths.push({ pts, off: rng() * UNIT * 2, sp: 0.15 + rng() * 0.15 });
      }
    }
  }
}

function rebuild() {
  const r = mkRand(S.seed * 7919 + 13);
  paths = []; S.networkNodes = null;
  const n = Math.floor(5 + S.density * 30);
  if      (S.pattern === 'pathways') buildPathways(r, n);
  else if (S.pattern === 'terrain')  buildTerrain(r, n);
  else if (S.pattern === 'city')     buildCity(r, n);
  else                               buildNetworks(r, n);
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
  const gridRows = Math.max(3, Math.ceil((H + bleed * 2) / cellSize) + 1);
  const gridStartX = -bleed;
  const gridStartY = -bleed;

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

  // Sutherland-Hodgman clip polygon against a half-plane (keep side where signed dist > threshold)
  function clipPolyHalfPlane(pts, cx, cy, nx, ny, threshold) {
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

  // Clip a polygon against a corridor — keep parts OUTSIDE (left + right sides)
  function clipByCorridors(pts) {
    if (corridors.length === 0) return [pts];

    let current = [pts];
    for (const c of corridors) {
      const next = [];
      for (const poly of current) {
        // Left side: perpDist < -halfW  → clip to dist < -halfW
        //   means: keep where -(px,py) dot > halfW → flip normal
        const leftSide = clipPolyHalfPlane(poly, c.cx, c.cy, -c.px, -c.py, c.halfW);
        // Right side: perpDist > +halfW → keep where (px,py) dot > halfW
        const rightSide = clipPolyHalfPlane(poly, c.cx, c.cy, c.px, c.py, c.halfW);
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
      const y0 = gridStartY + row * cellSize;
      const x1 = x0 + bw * cellSize - roadWidth;
      const y1 = y0 + bh * cellSize - roadWidth;

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

        // Store polygon corners as structural vertices for rigid repulsion
        const verts = poly.map(p => ({ x: p.x, y: p.y }));

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
          paths.push({ pts, off: rng() * UNIT * 2, sp: 0.15 + rng() * 0.2, rigid: true, verts,
                        blockPoly: poly.map(p => ({ x: p.x, y: p.y })),
                        blockRoadW: roadWidth });
        }
      }

      row += bh;
    }
  }

}

/**
 * NETWORKS GENERATOR — Delaunay triangulation filling full canvas
 * DESIGN: Dense node scatter → full Delaunay triangulation → straight edges + visible node dots
 * Reference: uniform triangulated mesh filling edge-to-edge
 */
function buildNetworks(r, n) {
  // Node count: min density denser than before, max density has real weight
  // n ranges 5..35 → nc ranges ~24..62
  const nc = Math.max(20, Math.floor(18 + n * 1.25));
  const nodes = [];

  // Bleed beyond canvas edges so triangulation mesh extends off all sides
  const bleed = 200;
  const areaW = W + bleed * 2;
  const areaH = H + bleed * 2;

  // Convert screen-space shapes to world-space for node/edge rejection
  const curDrift = S.movement === 'spatial' ? Math.sin(S.spatialX) * 120 : 0;
  const savedShapes = S.shapes;
  if (curDrift !== 0) {
    S.shapes = S.shapes.map(sh => ({ x: sh.x - curDrift, y: sh.y, w: sh.w, h: sh.h }));
  }

  // Poisson-disk scatter filling canvas + bleed area
  const minDist = Math.sqrt((areaW * areaH) / nc) * 0.55;
  let attempts = 0;
  while (nodes.length < nc && attempts < nc * 20) {
    const x = -bleed + r() * areaW;
    const y = -bleed + r() * areaH;
    let tooClose = false;
    for (const node of nodes) {
      if (Math.hypot(x - node.x, y - node.y) < minDist) { tooClose = true; break; }
    }
    // Reject nodes inside (or too close to) shape rectangles
    if (!tooClose && S.shapes.length > 0 && ptInAnyShape(x, y, 18)) { attempts++; continue; }
    if (!tooClose) nodes.push({ x, y });
    attempts++;
  }

  // Full Delaunay triangulation — all edges, straight lines
  const delaunayEdges = GEO.delaunayTriangulate(nodes);

  for (const [p0, p1] of delaunayEdges) {
    // Skip edges that pass through a shape rectangle
    if (S.shapes.length > 0 && segCrossesAnyShape(p0, p1)) continue;
    // Store structural endpoints — interpolation happens at draw time
    // so repulsion can move endpoints and re-interpolate a straight line
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const steps = Math.ceil(Math.hypot(dx, dy) / 6);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push({ x: p0.x + dx * t, y: p0.y + dy * t });
    }
    paths.push({ pts, off: r() * UNIT * 2, sp: 0.5 + r() * 0.8, rigid: true,
                  verts: [{ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }] });
  }

  // Restore original screen-space shapes
  S.shapes = savedShapes;

  // ── Rectangle integration: perimeter edges + dynamic corner connections ──
  for (const sh of S.shapes) {
    const corners = [
      { x: sh.x, y: sh.y },
      { x: sh.x + sh.w, y: sh.y },
      { x: sh.x + sh.w, y: sh.y + sh.h },
      { x: sh.x, y: sh.y + sh.h },
    ];

    // 4 perimeter edges connecting the corners
    for (let ci = 0; ci < 4; ci++) {
      const a = corners[ci], b = corners[(ci + 1) % 4];
      const dx = b.x - a.x, dy = b.y - a.y;
      const steps = Math.ceil(Math.hypot(dx, dy) / 6);
      const pts = [];
      for (let j = 0; j <= steps; j++) {
        const t = j / steps;
        pts.push({ x: a.x + dx * t, y: a.y + dy * t });
      }
      if (pts.length > 2) {
        paths.push({ pts, off: r() * UNIT * 2, sp: 0.5 + r() * 0.8, rigid: true, screenFixed: true });
      }
    }

    // Corner-to-node connections are drawn dynamically at draw time
    // so they stay connected as the pattern drifts in spatial mode.
  }

  S.networkNodes = nodes;
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

// Draw filled circle+bar units along a flattened path (matches Lines.svg style)
function drawUnits(ctx, flat, off, color) {
  if (flat.length < 2) return;
  const dists = [0];
  for (let i = 1; i < flat.length; i++)
    dists.push(dists[i-1] + Math.hypot(flat[i].x-flat[i-1].x, flat[i].y-flat[i-1].y));
  const totalLen = dists[dists.length-1];
  function atDist(d) {
    d = Math.max(0, Math.min(totalLen, d));
    let lo = 0, hi = dists.length-1;
    while (hi-lo > 1) { const mid=(lo+hi)>>1; if (dists[mid]<=d) lo=mid; else hi=mid; }
    const segLen = dists[hi]-dists[lo], t = segLen>0 ? (d-dists[lo])/segLen : 0;
    return { x:flat[lo].x+(flat[hi].x-flat[lo].x)*t, y:flat[lo].y+(flat[hi].y-flat[lo].y)*t,
             angle:Math.atan2(flat[hi].y-flat[lo].y, flat[hi].x-flat[lo].x) };
  }
  ctx.fillStyle = color;
  for (let d = -(off%UNIT); d < totalLen; d += UNIT) {
    // Filled circle
    const cD = d+CR;
    if (cD >= -CR && cD <= totalLen+CR) {
      const p = atDist(cD);
      ctx.beginPath(); ctx.arc(p.x, p.y, CR, 0, Math.PI*2); ctx.fill();
    }
    // Curved bar — polygon ribbon that bends along the path
    const bStart = d + CR*2 + GAP;
    const bEnd   = bStart + BW;
    if (bEnd >= 0 && bStart <= totalLen) {
      const cs = Math.max(0, bStart), ce = Math.min(totalLen, bEnd);
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

/**
 * Deform/split a path for rectangle interaction. Different per pattern:
 *
 * TERRAIN: Split path at rectangle boundaries → clean rectangular void.
 *   Uses splitPathAtShapes for precise geometric cutting. Returns array of
 *   sub-path flattenings that get drawn independently.
 *
 * PATHWAYS: Per-point SDF repulsion. Each individual point near the rectangle
 *   gets pushed outward so the path curves/wraps around the obstacle. The path
 *   stays in its general position but locally deforms.
 *
 * CITY: Centroid-based uniform translation (keeps rectangles axis-aligned).
 *   Blocks stay horizontal/vertical. Road spacing is preserved.
 *
 * NETWORKS: Endpoint-only repulsion with straight re-interpolation.
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
    S.shapes = S.shapes.map(sh => ({ x: sh.x - drift, y: sh.y, w: sh.w, h: sh.h }));
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
function draw() {
  // ── Advance dash offsets once per frame ──────────────────────────
  const sm = S.motionOn ? 0.5 + S.speed * 3 : 0;
  for (const p of paths) {
    if (S.motionOn) p.off += p.sp * sm * 0.4;
  }

  // ── Spatial drift: sine-wave oscillation within the bleed zone ───
  // All patterns extend 200 px beyond every canvas edge, so a ±120 px
  // horizontal sine drift never exposes an empty border — zero seam,
  // truly infinite, no tiling required.
  if (S.movement === 'spatial') S.spatialX += 0.004;
  const drift = S.movement === 'spatial' ? Math.sin(S.spatialX) * 120 : 0;

  // Networks in spatial mode: rebuild periodically so edge clipping
  // stays aligned with the drifting rectangle position.
  if (S.movement === 'spatial' && S.shapes.length > 0 && S.pattern === 'networks') {
    if (draw._lastDrift === undefined) draw._lastDrift = drift;
    if (Math.abs(drift - draw._lastDrift) > 8) {
      draw._lastDrift = drift;
      rebuild();
    }
  }

  // ── Clear + fill background ───────────────────────────────────────
  cx.clearRect(0, 0, W, H);
  cx.fillStyle = S.canvasBg;
  cx.fillRect(0, 0, W, H);

  // ── Draw paths + nodes, shifted by spatial drift ─────────────────
  cx.save();
  cx.translate(drift, 0);

  // Clip a screen-fixed rectangular void so the gap stays anchored to the
  // rectangle even when patterns drift in spatial mode.
  if (S.shapes.length > 0 && (S.pattern === 'city' || S.pattern === 'networks' || S.pattern === 'terrain')) {
    const CBLEED = 400;
    cx.beginPath();
    cx.rect(-CBLEED - Math.abs(drift), -CBLEED,
            W + CBLEED * 2 + Math.abs(drift) * 2, H + CBLEED * 2);
    for (const sh of S.shapes) {
      cx.rect(sh.x - drift, sh.y, sh.w, sh.h);
    }
    cx.clip('evenodd');
  }

  for (const p of paths) {
    // Skip screen-fixed paths here — drawn outside drift translate below
    if (p.screenFixed) continue;

    // City blocks in spatial mode: re-clip blockPoly against shapes every frame
    // so block edges track the rectangle smoothly as the pattern drifts.
    if (p.blockPoly && S.shapes.length > 0) {
      const halfRd = p.blockRoadW * 0.5;
      const MIN_BLK = p.blockRoadW * 0.8;
      let fragments = [p.blockPoly];
      for (const sh of S.shapes) {
        // Shape is screen-fixed; convert to world-space by subtracting drift
        const rx = sh.x - drift - halfRd, ry = sh.y - halfRd;
        const rw = sh.w + p.blockRoadW, rh = sh.h + p.blockRoadW;
        const next = [];
        for (const poly of fragments) {
          const clipped = clipPolyByRect(poly, rx, ry, rw, rh);
          for (const frag of clipped) next.push(frag);
        }
        fragments = next;
      }
      // Draw each surviving fragment
      for (const frag of fragments) {
        let fMinX = Infinity, fMaxX = -Infinity, fMinY = Infinity, fMaxY = -Infinity;
        for (const pt of frag) {
          if (pt.x < fMinX) fMinX = pt.x; if (pt.x > fMaxX) fMaxX = pt.x;
          if (pt.y < fMinY) fMinY = pt.y; if (pt.y > fMaxY) fMaxY = pt.y;
        }
        if (fMaxX - fMinX < MIN_BLK || fMaxY - fMinY < MIN_BLK) continue;
        const ring = [...frag, frag[0]];
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
        if (fragPts.length > 4) {
          drawUnits(cx, flattenPath(fragPts), p.off, S.lineColor);
        }
      }
      continue;
    }

    if (p.flat) {
      drawUnits(cx, p.flat, p.off, S.lineColor);
    } else {
      const subs = deformPath(p, drift);
      for (const flat_r of subs) {
        drawUnits(cx, flat_r, p.off, S.lineColor);
      }
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

  // ── Screen-fixed paths (e.g. network rectangle perimeter) ──────────
  for (const p of paths) {
    if (!p.screenFixed) continue;
    const flat_r = flattenPath(p.pts);
    drawUnits(cx, flat_r, p.off, S.lineColor);
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
          const screenX = n.x + drift;
          const d = Math.hypot(c.x - screenX, c.y - n.y);
          if (d < bestD) { bestD = d; bestN = n; }
        }
        if (bestN && bestD < 600) {
          // Draw connection line from corner (screen) to node (screen)
          const nx = bestN.x + drift, ny = bestN.y;
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
(function loop() { draw(); animId = requestAnimationFrame(loop); })();

// ================================================================
// CANVAS INTERACTION
// ================================================================
const cursorRing = document.getElementById('cursor-ring');
let shapeDrag = null;   // null | {type:'body'|'handle', idx, corner, startMx, startMy, startX, startY, startW, startH}

cv.addEventListener('mousemove', e => {
  const r = cv.getBoundingClientRect();
  S.mx = e.clientX - r.left; S.my = e.clientY - r.top;
  cursorRing.style.left = S.mx+'px'; cursorRing.style.top = S.my+'px';

  // Update cursor style based on what's under the mouse
  if (!shapeDrag && S.mode === 'active' && S.shapes.length > 0) {
    const hit = hitTestShapes(S.mx, S.my);
    if (hit) {
      cv.style.cursor = hit.type === 'handle' ? 'nwse-resize' : 'move';
    } else {
      cv.style.cursor = 'crosshair';
    }
  } else if (!shapeDrag) {
    cv.style.cursor = '';
  }

  if (!shapeDrag) return;
  const dx = S.mx - shapeDrag.startMx, dy = S.my - shapeDrag.startMy;
  const sh = S.shapes[shapeDrag.idx];
  const MIN_W = 40, MIN_H = 30;

  if (shapeDrag.type === 'body') {
    sh.x = shapeDrag.startX + dx;
    sh.y = shapeDrag.startY + dy;
  } else {
    const c = shapeDrag.corner;
    if (c === 'tl') {
      sh.x = Math.min(shapeDrag.startX + dx, shapeDrag.startX + shapeDrag.startW - MIN_W);
      sh.y = Math.min(shapeDrag.startY + dy, shapeDrag.startY + shapeDrag.startH - MIN_H);
      sh.w = shapeDrag.startW - (sh.x - shapeDrag.startX);
      sh.h = shapeDrag.startH - (sh.y - shapeDrag.startY);
    } else if (c === 'tr') {
      sh.y = Math.min(shapeDrag.startY + dy, shapeDrag.startY + shapeDrag.startH - MIN_H);
      sh.w = Math.max(MIN_W, shapeDrag.startW + dx);
      sh.h = shapeDrag.startH - (sh.y - shapeDrag.startY);
    } else if (c === 'bl') {
      sh.x = Math.min(shapeDrag.startX + dx, shapeDrag.startX + shapeDrag.startW - MIN_W);
      sh.w = shapeDrag.startW - (sh.x - shapeDrag.startX);
      sh.h = Math.max(MIN_H, shapeDrag.startH + dy);
    } else { // br
      sh.w = Math.max(MIN_W, shapeDrag.startW + dx);
      sh.h = Math.max(MIN_H, shapeDrag.startH + dy);
    }
  }
  // Rectangle repulsion is applied per-frame via repulse() — no rebuild needed during drag.
});

cv.addEventListener('mouseleave', () => { S.mx=-9999; S.my=-9999; });

cv.addEventListener('mousedown', e => {
  if (S.mode !== 'active') return;
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;

  const hit = hitTestShapes(mx, my);
  if (hit) {
    const sh = S.shapes[hit.idx];
    shapeDrag = { ...hit, startMx: mx, startMy: my, startX: sh.x, startY: sh.y, startW: sh.w, startH: sh.h };
    e.preventDefault();
  }
  // Click-to-place is handled by the toolbar button
});

cv.addEventListener('mouseup', () => {
  if (shapeDrag) {
    shapeDrag = null;
    clearTimeout(rebuildTimer);
    rebuild(); // Bake final rect position into city/network geometry
  }
  shapeDrag = null;
});

document.getElementById('addRectBtn').addEventListener('click', () => {
  if (S.shapes.length >= 3) { toast('Maximum 3 rectangles'); return; }
  // Place rectangle in a staggered position near center
  const idx = S.shapes.length;
  const W0 = 200, H0 = 130;
  const offsets = [{dx:0,dy:0},{dx:80,dy:60},{dx:-70,dy:80}];
  const cx0 = W * 0.5 + offsets[idx].dx, cy0 = H * 0.5 + offsets[idx].dy;
  S.shapes.push({ x: cx0 - W0/2, y: cy0 - H0/2, w: W0, h: H0 });
  rebuild();
});

document.getElementById('clrBtn').addEventListener('click', () => {
  S.shapes = [];
  shapeDrag = null;
  rebuild();
});

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

exclusive('mActive','mPassive',
  () => { S.mode='active';  stage.classList.add('active-mode');    document.getElementById('shape-toolbar').classList.add('visible'); },
  () => { S.mode='passive'; stage.classList.remove('active-mode'); document.getElementById('shape-toolbar').classList.remove('visible'); }
);
document.getElementById('mMotion').addEventListener('click', () => {
  S.motionOn = !S.motionOn;
  document.getElementById('mMotion').classList.toggle('is-active', S.motionOn);
});
exclusive('mFixed','mSpatial',
  () => { S.movement='fixed';   S.spatialX=0; },
  () => { S.movement='spatial'; S.spatialX=0; }
);

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
  S.speed=.5; S.density=.5; S.seed=5; S.shapes=[]; S.movement='fixed'; S.spatialX=0; shapeDrag=null;
  document.getElementById('speedRange').value   = 50;
  document.getElementById('densityRange').value = 50;
  document.getElementById('seedRange').value    = 5;
  document.getElementById('speedBadge').textContent   = '50%';
  document.getElementById('densityBadge').textContent = '50%';
  document.getElementById('seedBadge').textContent    = '5';
  document.getElementById('mFixed').classList.add('is-active');
  document.getElementById('mSpatial').classList.remove('is-active');
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
function exportImg(fname, type, transp) {
  const EW = 1920, EH = 1080;
  const tc = document.createElement('canvas'); tc.width=EW; tc.height=EH;
  const tx = tc.getContext('2d');
  if (!transp) { tx.fillStyle=S.canvasBg; tx.fillRect(0,0,EW,EH); }
  tx.save(); tx.scale(EW/W, EH/H);
  for (const p of paths) {
    const subs = deformPath(p, 0);
    for (const flat_r of subs) {
      drawUnits(tx, flat_r, p.off, S.lineColor);
    }
  }
  if(S.networkNodes){tx.fillStyle=S.lineColor;for(const n of S.networkNodes){const d=repulse(n.x,n.y,0);tx.beginPath();tx.arc(n.x+d.ox,n.y+d.oy,CR,0,Math.PI*2);tx.fill();}}
  tx.restore();
  const a=document.createElement('a'); a.download=fname;
  a.href=type==='jpg'?tc.toDataURL('image/jpeg',.95):tc.toDataURL('image/png');
  a.click(); toast('Exported '+fname+' (1920×1080)');
}

document.getElementById('exPng').addEventListener('click', () => exportImg('pattern.png','png',true));   // transparent bg
document.getElementById('exJpg').addEventListener('click', () => exportImg('pattern.jpg','jpg',false));  // with bg
document.getElementById('exSvg').addEventListener('click', () => {
  const col = S.lineColor;
  let body = '';
  // Build unit positions for each path and emit SVG circles + rects
  for (const p of paths) {
    const subs = deformPath(p, 0);
    for (const flat of subs) {
    if (flat.length < 2) continue;
    const dists = [0];
    for (let i=1;i<flat.length;i++) dists.push(dists[i-1]+Math.hypot(flat[i].x-flat[i-1].x,flat[i].y-flat[i-1].y));
    const totalLen = dists[dists.length-1];
    const atDFn = d => {
      d=Math.max(0,Math.min(totalLen,d));
      let lo=0,hi=dists.length-1;
      while(hi-lo>1){const mid=(lo+hi)>>1;if(dists[mid]<=d)lo=mid;else hi=mid;}
      const segLen=dists[hi]-dists[lo],t=segLen>0?(d-dists[lo])/segLen:0;
      return{x:flat[lo].x+(flat[hi].x-flat[lo].x)*t,y:flat[lo].y+(flat[hi].y-flat[lo].y)*t,
             angle:Math.atan2(flat[hi].y-flat[lo].y,flat[hi].x-flat[lo].x)};
    };
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
  if(S.networkNodes){for(const n of S.networkNodes){const d=repulse(n.x,n.y,0);body+=`<circle cx="${(n.x+d.ox).toFixed(1)}" cy="${(n.y+d.oy).toFixed(1)}" r="${CR}" fill="${col}"/>\n`;}}

  const bgRect = `<rect width="${W}" height="${H}" fill="${S.canvasBg}"/>\n`;
  const svg=`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">\n${bgRect}<g>\n${body}</g>\n</svg>`;
  const a=document.createElement('a'); a.download='pattern.svg';
  a.href=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'})); a.click();
  toast('Exported SVG');
});

document.getElementById('exVideo').addEventListener('click', async () => {
  if (S.recording) return;

  const btn = document.getElementById('exVideo');
  const prog = document.getElementById('vp'), bar = document.getElementById('vpb');

  // ── Animated GIF export ─────────────────────────────────────────────────────
  // One perfectly-seamless loop at 1920×1080 with solid background.
  // Duration = one full spatial sine cycle (starts and ends at same drift = 0).
  // Uses gifenc (MIT, ~12 KB) loaded via fetch→blob so it works from file://,
  // GitHub Pages, or any HTTPS host without import() cross-origin restrictions.

  const GIF_FPS    = 25;
  const GIF_FRAMES = 120;                    // 4.8 s loop at 25 fps
  const GIF_DELAY  = 4;                      // 4cs = 40ms — well above browser minimum, universally honoured
  const SPATIAL_STEP = (2 * Math.PI) / GIF_FRAMES;   // exactly one sine cycle
  const sm = 0.5 + S.speed * 3;
  const saved = paths.map(p => p.off);

  // Pre-compute a perfectly-looping step per path.
  paths.forEach(p => {
    const adv = GIF_FRAMES * p.sp * sm * 0.4, loops = Math.round(adv / UNIT) || 1;
    p._ls = (loops * UNIT) / (GIF_FRAMES * sm * 0.4); p._s0 = 0; p.off = 0;
  });

  S.recording = true; btn.classList.add('is-recording');
  btn.textContent = '● Loading…';
  prog.style.display = 'block'; bar.style.width = '0%';
  cancelAnimationFrame(animId);

  function cleanup() {
    paths.forEach((p, i) => { p.off = saved[i]; delete p._ls; delete p._s0; });
    S.recording = false; btn.classList.remove('is-recording');
    btn.textContent = 'Animation';
    prog.style.display = 'none'; bar.style.width = '0%';
    (function loop() { draw(); animId = requestAnimationFrame(loop); })();
  }

  // Draw one frame to any 2D context at the target resolution.
  // Includes spatial drift. No cursor deformation (clean export).
  function drawGifFrame(ctx, tw, th, drift) {
    ctx.fillStyle = S.canvasBg;
    ctx.fillRect(0, 0, tw, th);
    ctx.save();
    ctx.scale(tw / W, th / H);
    ctx.save();
    ctx.translate(drift, 0);
    for (const p of paths) {
      const subs = deformPath(p, drift);
      for (const flat_r of subs) {
        drawUnits(ctx, flat_r, p.off, S.lineColor);
      }
    }
    if (S.pattern === 'networks' && S.networkNodes) {
      ctx.fillStyle = S.lineColor;
      for (const n of S.networkNodes) {
        const d = repulse(n.x, n.y, drift);
        ctx.beginPath(); ctx.arc(n.x + d.ox, n.y + d.oy, CR, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore(); // inner (drift)
    ctx.restore(); // outer (scale)
  }

  try {
    // Load gifenc via fetch → same-origin blob URL.
    // This pattern works from file://, GitHub Pages, and any HTTPS host.
    const code = await fetch(
      'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js'
    ).then(r => {
      if (!r.ok) throw new Error(`CDN error ${r.status} — check internet connection`);
      return r.text();
    });
    const blobUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    const { GIFEncoder, quantize, applyPalette } = await import(blobUrl);
    URL.revokeObjectURL(blobUrl);

    btn.textContent = '● Encoding GIF…';

    const EW = 960, EH = 540;   // half-res: 4× fewer pixels → smooth 25 fps in all viewers/apps
    const oc = document.createElement('canvas'); oc.width = EW; oc.height = EH;
    const octx = oc.getContext('2d');

    const gif = GIFEncoder();
    let palette = null;

    for (let f = 0; f < GIF_FRAMES; f++) {
      // Advance line offsets for this frame
      paths.forEach(p => { p.off = p._s0 + f * (p._ls || p.sp) * sm * 0.4; });

      // Spatial drift: one full sine cycle across all frames → perfect seamless loop
      const drift = S.movement === 'spatial' ? Math.sin(f * SPATIAL_STEP) * 120 : 0;
      drawGifFrame(octx, EW, EH, drift);

      // Read pixels; build palette from first frame, reuse for all (consistent colours)
      const { data } = octx.getImageData(0, 0, EW, EH);
      if (!palette) palette = quantize(data, 16);
      const index = applyPalette(data, palette);

      gif.writeFrame(index, EW, EH, {
        palette,
        delay: GIF_DELAY,
        ...(f === 0 ? { repeat: 0 } : {})  // Netscape loop extension on first frame only
      });

      bar.style.width = ((f + 1) / GIF_FRAMES * 100) + '%';
      if (f % 6 === 0) await new Promise(r => setTimeout(r, 0)); // keep UI responsive
    }

    gif.finish();
    const blob = new Blob([gif.bytes()], { type: 'image/gif' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.download = 'pattern-loop.gif'; a.href = url; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Exported GIF — 960×540 HD, seamless loop');

  } catch (e) {
    console.error('GIF export error:', e);
    toast('GIF export failed: ' + (e.message || e));
  }

  cleanup();
});

// ================================================================
// INIT — apply default theme and pattern on load
// ================================================================
(function initDefaults() {
  applyTheme('light', false);
  // Sync initial UI state — mode is 'active' by default
  stage.classList.add('active-mode');
  document.getElementById('shape-toolbar').classList.add('visible');
})();

resize();

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
  shapes: [], selectedShape: 'circle',
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
      // Filter to avoid tiny isolated loops (design constraint)
      // Only include chains with substantial length
      if (chain.length >= 8) {
        const pts = GEO.smoothCatmullRom(chain, 0.5);

        // Optional: light post-smoothing to enhance contour clarity while preserving structure
        // Skip secondary smoothing by default to preserve topographic character
        paths.push({
          pts,
          off: r() * UNIT * 4,
          sp: 0.15 + r() * 0.25  // Slightly faster animation for more visible hierarchy
        });
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
  const baseRadius     = 80;    // corner-arc radius for the trunk center line
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

  // ── Generate four non-crossing L-shaped corridors — independently seeded ──
  //
  // Corridor layout:
  //   C1  top → right   (vertical entry, horizontal exit right)
  //   C3  top → left    (vertical entry, horizontal exit left)
  //   C2  left → bottom (horizontal entry, vertical exit bottom)
  //   C4  right → bottom(horizontal entry, vertical exit bottom)
  //
  // Non-crossing invariants (guaranteed by construction):
  //   bx1 > bx3   (C1 right of C3 at top)
  //   bx4 > bx2   (C4 right of C2 at bottom)
  //   by1, by3 < H*0.50   (top pair bends in upper half)
  //   by2, by4 > H*0.50   (bottom pair bends in lower half)
  //
  // Gap between same-pair bundles: minBundleDist (touching) to ~40% canvas (open)
  // All four bend heights are independent → unique layouts per seed.

  const bundleHalfW   = (linesPerBundle - 1) / 2 * lineSpacing;
  const minBundleDist = 2 * bundleHalfW + lineSpacing;  // center-to-center when touching

  // ── Top pair: C1 (right) and C3 (left) ──────────────────────────────────
  const topMidX = W * (0.30 + rng() * 0.40);              // shared midpoint: 30–70%
  const topHalf = minBundleDist / 2 + rng() * W * 0.06;   // touching → ~6% W apart
  const bx1 = topMidX + topHalf;
  const bx3 = topMidX - topHalf;

  // ── Bottom pair: C2 (left) and C4 (right) ───────────────────────────────
  const botMidX = W * (0.30 + rng() * 0.40);              // independent midpoint: 30–70%
  const botHalf = minBundleDist / 2 + rng() * W * 0.06;
  const bx2 = botMidX - botHalf;
  const bx4 = botMidX + botHalf;

  // ── Vertical bend positions — push-apart enforced ────────────────────────
  // C1 (by1) and C4 (by4) share the right side; C3 (by3) and C2 (by2) share the left.
  // Their horizontal bundles need vertical gap ≥ minBundleDist to avoid overlap.
  const by1raw = H * (0.18 + rng() * 0.26);   // C1 raw bend: 18–44%
  const by3raw = H * (0.18 + rng() * 0.26);   // C3 raw bend: 18–44%
  const by4raw = H * (0.56 + rng() * 0.26);   // C4 raw bend: 56–82%
  const by2raw = H * (0.56 + rng() * 0.26);   // C2 raw bend: 56–82%

  const by1 = by1raw;
  const by4 = Math.max(by4raw, by1 + minBundleDist);  // push C4 down if needed
  const by3 = by3raw;
  const by2 = Math.max(by2raw, by3 + minBundleDist);  // push C2 down if needed

  const trunk1 = [{ x: bx1, y: -bleed },    { x: bx1, y: by1 }, { x: W + bleed, y: by1 }];
  const trunk2 = [{ x: -bleed, y: by2 },    { x: bx2, y: by2 }, { x: bx2, y: H + bleed }];
  const trunk3 = [{ x: bx3, y: -bleed },    { x: bx3, y: by3 }, { x: -bleed,    y: by3 }];
  const trunk4 = [{ x: W + bleed, y: by4 }, { x: bx4, y: by4 }, { x: bx4, y: H + bleed }];

  for (const trunk of [trunk1, trunk2, trunk3, trunk4]) {
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
  const t = Math.max(0, Math.min(1, (n - 5) / 30));  // 0 = min density, 1 = max density
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
  const numDiag = Math.floor(rng() * 3.5);   // 0, 1, 2, or 3 avenues
  const corridors = [];

  for (let p = 0; p < numDiag; p++) {
    const dir = rng() > 0.5 ? 1 : -1;
    const angle = dir * (Math.PI / 4 + (rng() - 0.5) * 0.45);  // ±~26° variation around 45°
    const sinA = Math.sin(angle);
    const cosA = Math.cos(angle);
    const perpOff = (rng() - 0.5) * Math.min(W, H) * 0.55;
    const halfW = roadWidth * 1.2;   // Avenue width = slightly wider than a regular road

    corridors.push({
      cx: W / 2 - perpOff * sinA,
      cy: H / 2 + perpOff * cosA,
      px: -sinA, py: cosA,   // Perpendicular unit vector (across road)
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

      // Clip block rect against all diagonal corridors (keep parts outside corridors)
      const rectPts = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      const clippedPolys = clipByCorridors(rectPts);

      // Render each surviving polygon fragment
      for (const poly of clippedPolys) {
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
          paths.push({ pts, off: rng() * UNIT * 2, sp: 0.15 + rng() * 0.2 });
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
  // Node count: ~40-60 nodes at 50% density to match reference density
  const nc = Math.max(12, Math.floor(n * 2.2));
  const nodes = [];

  // Bleed beyond canvas edges so triangulation mesh extends off all sides
  const bleed = 200;
  const areaW = W + bleed * 2;
  const areaH = H + bleed * 2;

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
    if (!tooClose) nodes.push({ x, y });
    attempts++;
  }

  // Full Delaunay triangulation — all edges, straight lines
  const delaunayEdges = GEO.delaunayTriangulate(nodes);

  for (const [p0, p1] of delaunayEdges) {
    // Interpolate edge into points for dashed animation
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const steps = Math.ceil(Math.hypot(dx, dy) / 6);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      pts.push({ x: p0.x + dx * t, y: p0.y + dy * t });
    }
    paths.push({ pts, off: r() * UNIT * 2, sp: 0.5 + r() * 0.8 });
  }

  S.networkNodes = nodes;
}

// ================================================================
// RENDERING & INTERACTION (Shared across all patterns)
// ================================================================
// Line-unit dimensions — matching Lines.svg style (filled circle + filled bar)
const CR=5, BW=33, BH=Math.round(CR*2*.865), GAP=4, UNIT_GAP=8, UNIT=CR*2+GAP+BW+UNIT_GAP;

/**
 * Repulsion force: cursor and placed shapes push nearby points outward
 */
function repulse(x, y) {
  let ox = 0, oy = 0;
  if (S.mode === 'active' && S.mx > 0) {
    const dx = x - S.mx, dy = y - S.my, d = Math.sqrt(dx*dx + dy*dy), R = 80;
    if (d < R && d > 0) {
      const f = (1 - d / R) * 30;
      ox += (dx / d) * f;
      oy += (dy / d) * f;
    }
  }
  for (const sh of S.shapes) {
    const dx = x - sh.x, dy = y - sh.y, d = Math.sqrt(dx*dx + dy*dy), R = sh.sz * 0.7;
    if (d < R && d > 0) {
      const f = (1 - d / R) * sh.sz * 0.5;
      ox += (dx / d) * f;
      oy += (dy / d) * f;
    }
  }
  return { ox, oy };
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

  // ── Clear + fill background ───────────────────────────────────────
  cx.clearRect(0, 0, W, H);
  cx.fillStyle = S.canvasBg;
  cx.fillRect(0, 0, W, H);

  // ── Draw paths + nodes, shifted by spatial drift ─────────────────
  cx.save();
  cx.translate(drift, 0);

  for (const p of paths) {
    let flat_r;
    if (p.flat) {
      flat_r = p.flat;
    } else {
      const deformedPts = p.pts.map(pt => {
        const d = repulse(pt.x, pt.y);
        return { x: pt.x + d.ox, y: pt.y + d.oy };
      });
      flat_r = flattenPath(deformedPts);
    }
    drawUnits(cx, flat_r, p.off, S.lineColor);
  }

  if (S.pattern === 'networks' && S.networkNodes) {
    cx.fillStyle = S.lineColor;
    for (const n of S.networkNodes) {
      const d = repulse(n.x, n.y);
      cx.beginPath();
      cx.arc(n.x + d.ox, n.y + d.oy, CR, 0, Math.PI * 2);
      cx.fill();
    }
  }

  cx.restore();

  // ── Placed shape obstacles always at fixed canvas coords ─────────
  for (const sh of S.shapes) {
    cx.save();
    cx.strokeStyle = S.lineColor;
    cx.lineWidth = 1;
    cx.setLineDash([3, 4]);
    cx.globalAlpha = 0.22;
    cx.beginPath();
    if (sh.type === 'circle') {
      cx.arc(sh.x, sh.y, sh.sz * 0.5, 0, Math.PI * 2);
    } else if (sh.type === 'square') {
      const h = sh.sz * 0.5;
      cx.rect(sh.x - h, sh.y - h, h * 2, h * 2);
    } else if (sh.type === 'triangle') {
      const h = sh.sz * 0.55;
      cx.moveTo(sh.x, sh.y - h);
      cx.lineTo(sh.x + h * 0.87, sh.y + h * 0.5);
      cx.lineTo(sh.x - h * 0.87, sh.y + h * 0.5);
      cx.closePath();
    }
    cx.stroke();
    cx.restore();
  }
}

let animId;
(function loop() { draw(); animId = requestAnimationFrame(loop); })();

// ================================================================
// CANVAS INTERACTION
// ================================================================
const cursorRing = document.getElementById('cursor-ring');
cv.addEventListener('mousemove', e => {
  const r = cv.getBoundingClientRect();
  S.mx = e.clientX - r.left; S.my = e.clientY - r.top;
  cursorRing.style.left = S.mx+'px'; cursorRing.style.top = S.my+'px';
});
cv.addEventListener('mouseleave', () => { S.mx=-9999; S.my=-9999; });
cv.addEventListener('click', e => {
  if (S.mode !== 'active') return;
  const r = cv.getBoundingClientRect();
  S.shapes.push({ x: e.clientX-r.left, y: e.clientY-r.top, type: S.selectedShape, sz: 80+Math.random()*40 });
});
document.getElementById('clrBtn').addEventListener('click', () => S.shapes = []);
document.querySelectorAll('.shape-btn[data-shape]').forEach(b => {
  b.addEventListener('click', () => {
    S.selectedShape = b.dataset.shape;
    document.querySelectorAll('.shape-btn[data-shape]').forEach(x => x.classList.remove('is-active'));
    b.classList.add('is-active');
  });
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
  S.speed=.5; S.density=.5; S.seed=5; S.shapes=[]; S.movement='fixed'; S.spatialX=0;
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
  for (const p of paths) drawUnits(tx, p.flat || flattenPath(p.pts), p.off, S.lineColor);
  if(S.networkNodes){tx.fillStyle=S.lineColor;for(const n of S.networkNodes){tx.beginPath();tx.arc(n.x,n.y,CR,0,Math.PI*2);tx.fill();}}
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
    const flat = p.flat || flattenPath(p.pts);
    if (flat.length < 2) continue;
    const dists = [0];
    for (let i=1;i<flat.length;i++) dists.push(dists[i-1]+Math.hypot(flat[i].x-flat[i-1].x,flat[i].y-flat[i-1].y));
    const totalLen = dists[dists.length-1];
    function atD(d) {
      d=Math.max(0,Math.min(totalLen,d));
      let lo=0,hi=dists.length-1;
      while(hi-lo>1){const mid=(lo+hi)>>1;if(dists[mid]<=d)lo=mid;else hi=mid;}
      const segLen=dists[hi]-dists[lo],t=segLen>0?(d-dists[lo])/segLen:0;
      return{x:flat[lo].x+(flat[hi].x-flat[lo].x)*t,y:flat[lo].y+(flat[hi].y-flat[lo].y)*t,
             angle:Math.atan2(flat[hi].y-flat[lo].y,flat[hi].x-flat[lo].x)};
    }
    for (let d=-(p.off%UNIT);d<totalLen;d+=UNIT) {
      // Circle unit
      const cD=d+CR;
      if(cD>=-CR&&cD<=totalLen+CR){const pt=atD(cD);body+=`<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${CR}" fill="${col}"/>\n`;}
      // Bar unit — polygon ribbon that bends along the path (matches canvas drawUnits exactly)
      const bStart=d+CR*2+GAP, bEnd=bStart+BW;
      if(bEnd>=0&&bStart<=totalLen){
        const cs=Math.max(0,bStart), ce=Math.min(totalLen,bEnd);
        const steps=Math.max(2,Math.ceil((ce-cs)/3));
        const top=[], bot=[];
        for(let si=0;si<=steps;si++){
          const pt=atD(cs+(ce-cs)*si/steps);
          const nx=-Math.sin(pt.angle), ny=Math.cos(pt.angle);
          top.push(`${(pt.x+nx*BH/2).toFixed(1)},${(pt.y+ny*BH/2).toFixed(1)}`);
          bot.push(`${(pt.x-nx*BH/2).toFixed(1)},${(pt.y-ny*BH/2).toFixed(1)}`);
        }
        body+=`<polygon points="${[...top,...bot.reverse()].join(' ')}" fill="${col}"/>\n`;
      }
    }
  }
  if(S.networkNodes){for(const n of S.networkNodes){body+=`<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${CR}" fill="${col}"/>\n`;}}
  const svg=`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">\n${body}</svg>`;
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

  const GIF_FPS    = 50;
  const GIF_FRAMES = 200;                             // 4 s loop at 50 fps
  const GIF_DELAY  = Math.round(100 / GIF_FPS);      // centiseconds per frame (= 2cs = 20ms, browser min)
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
    for (const p of paths)
      drawUnits(ctx, p.flat || flattenPath(p.pts), p.off, S.lineColor);
    if (S.pattern === 'networks' && S.networkNodes) {
      ctx.fillStyle = S.lineColor;
      for (const n of S.networkNodes) { ctx.beginPath(); ctx.arc(n.x, n.y, CR, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
    for (const sh of S.shapes) {
      ctx.save();
      ctx.strokeStyle = S.lineColor; ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]); ctx.globalAlpha = 0.22;
      ctx.beginPath();
      if (sh.type === 'circle') { ctx.arc(sh.x, sh.y, sh.sz * 0.5, 0, Math.PI * 2); }
      else if (sh.type === 'square') { const h = sh.sz * 0.5; ctx.rect(sh.x - h, sh.y - h, h * 2, h * 2); }
      else if (sh.type === 'triangle') { const h = sh.sz * 0.55; ctx.moveTo(sh.x, sh.y - h); ctx.lineTo(sh.x + h * 0.87, sh.y + h * 0.5); ctx.lineTo(sh.x - h * 0.87, sh.y + h * 0.5); ctx.closePath(); }
      ctx.stroke(); ctx.restore();
    }
    ctx.restore();
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

    const EW = 1920, EH = 1080;
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
    toast('Exported GIF — 1920×1080, seamless loop');

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
})();

resize();

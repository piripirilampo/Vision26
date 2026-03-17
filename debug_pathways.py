#!/usr/bin/env python3
"""
Debug pathways pattern generation to find overlaps and spacing issues.
Mimics the JavaScript buildPathways logic to analyze geometric correctness.
"""

import math
from dataclasses import dataclass
from typing import List, Tuple

@dataclass
class Point:
    x: float
    y: float

    def __repr__(self):
        return f"({self.x:.1f}, {self.y:.1f})"

def seeded_random(seed):
    """Seeded random number generator matching JS mkRand"""
    s = seed
    def rand():
        nonlocal s
        s = (s * 1664525 + 1013904223) & 0xffffffff
        return (s & 0xffffffff) / 0xffffffff
    return rand

def flatten_orthogonal(waypoints: List[Point], rad: float, W: float, H: float) -> List[Point]:
    """Flatten orthogonal path with quarter-circle arcs"""
    flat = []
    n = len(waypoints)
    if n < 2:
        return flat

    STEP = 4
    ARC_STEPS = 24

    # Build segments with trimmed endpoints
    segs = []
    for i in range(n - 1):
        a = waypoints[i]
        b = waypoints[i + 1]
        dx = b.x - a.x
        dy = b.y - a.y
        length = math.hypot(dx, dy)

        if length < 0.001:
            continue

        ux = dx / length
        uy = dy / length
        trim_s = rad if i > 0 else 0
        trim_e = rad if i < n - 2 else 0

        segs.append({
            'sx': a.x + ux * trim_s,
            'sy': a.y + uy * trim_s,
            'ex': b.x - ux * trim_e,
            'ey': b.y - uy * trim_e,
            'ux': ux,
            'uy': uy,
            'trim_e': trim_e
        })

    if not segs:
        return flat

    flat.append(Point(segs[0]['sx'], segs[0]['sy']))

    for i, s in enumerate(segs):
        line_len = math.hypot(s['ex'] - s['sx'], s['ey'] - s['sy'])
        steps = max(1, math.ceil(line_len / STEP))

        for j in range(1, steps + 1):
            t = j / steps
            x = s['sx'] + (s['ex'] - s['sx']) * t
            y = s['sy'] + (s['ey'] - s['sy']) * t
            flat.append(Point(x, y))

        # Arc to next segment
        if i < len(segs) - 1:
            next_s = segs[i + 1]
            actual_rad = rad

            # Arc center calculation
            cross = s['ux'] * next_s['uy'] - s['uy'] * next_s['ux']
            px = -s['uy'] if cross > 0 else s['uy']
            py = s['ux'] if cross > 0 else -s['ux']

            arc_cx = s['ex'] + px * actual_rad
            arc_cy = s['ey'] + py * actual_rad

            from_a = math.atan2(s['ey'] - arc_cy, s['ex'] - arc_cx)
            to_a = math.atan2(next_s['sy'] - arc_cy, next_s['sx'] - arc_cx)

            da = to_a - from_a
            if da > math.pi:
                da -= math.pi * 2
            if da < -math.pi:
                da += math.pi * 2

            for j in range(1, ARC_STEPS + 1):
                a = from_a + da * j / ARC_STEPS
                x = arc_cx + actual_rad * math.cos(a)
                y = arc_cy + actual_rad * math.sin(a)
                flat.append(Point(x, y))

    return flat

def offset_orthogonal(waypoints: List[Point], offset: float) -> List[Point]:
    """Offset orthogonal path: horizontal segments get vertical offset, vertical get horizontal.
    This maintains perfect orthogonality and constant perpendicular spacing."""
    if offset == 0 or len(waypoints) < 2:
        return waypoints

    result = []
    for i, curr in enumerate(waypoints):
        prev = waypoints[i - 1] if i > 0 else None
        next_pt = waypoints[i + 1] if i < len(waypoints) - 1 else None

        offset_x, offset_y = 0, 0

        if prev and next_pt:
            dx_prev = curr.x - prev.x
            dy_prev = curr.y - prev.y
            dx_next = next_pt.x - curr.x
            dy_next = next_pt.y - curr.y

            # Previous segment: horizontal or vertical?
            offset_prev = 0
            if abs(dy_prev) < 0.001:
                # Horizontal: offset vertically
                offset_prev = offset
            else:
                # Vertical: offset horizontally
                offset_prev = offset

            # Next segment: horizontal or vertical?
            offset_next = 0
            if abs(dy_next) < 0.001:
                # Horizontal: offset vertically
                offset_next = offset
            else:
                # Vertical: offset horizontally
                offset_next = offset

            # Apply appropriate offset based on segment type
            if abs(dy_prev) < 0.001 or abs(dy_next) < 0.001:
                offset_y = (offset_prev + offset_next) / 2
            else:
                offset_x = (offset_prev + offset_next) / 2
        elif prev:
            dx = curr.x - prev.x
            dy = curr.y - prev.y
            if abs(dy) < 0.001:
                offset_y = offset
            else:
                offset_x = offset
        elif next_pt:
            dx = next_pt.x - curr.x
            dy = next_pt.y - curr.y
            if abs(dy) < 0.001:
                offset_y = offset
            else:
                offset_x = offset

        result.append(Point(curr.x + offset_x, curr.y + offset_y))

    return result

def build_pathways_debug(W: float, H: float, density: float, seed: int = 5) -> List[dict]:
    """Build pathways and return detailed info for debugging"""
    r = seeded_random(seed * 7919 + 13)

    SP = 28  # spacing between parallel paths
    base_rad = min(W, H) * (0.11 + r() * 0.09)

    # Density controls bundleSize: 0% density = 1 line per bundle
    n = math.floor(5 + density * 30)
    bundle_size = max(1, math.floor((n - 4) * 0.2))

    print(f"W={W}, H={H}")
    print(f"density={density}, n={n}, bundleSize={bundle_size}")
    print(f"baseRad={base_rad:.1f}, SP={SP}")
    print()

    templates = [
        {
            'name': 'BR',
            'params': lambda: {
                'bx': W * (0.82 + r() * 0.12),
                'cy': H * (0.68 + r() * 0.20)
            },
            'makeBase': lambda p: [
                Point(p['bx'], H + 2),
                Point(p['bx'], p['cy']),
                Point(W + 2, p['cy'])
            ]
        },
        {
            'name': 'BL',
            'params': lambda: {
                'bx': W * (0.06 + r() * 0.12),
                'cy': H * (0.68 + r() * 0.20)
            },
            'makeBase': lambda p: [
                Point(p['bx'], H + 2),
                Point(p['bx'], p['cy']),
                Point(-2, p['cy'])
            ]
        },
        {
            'name': 'TR',
            'params': lambda: {
                'bx': W * (0.82 + r() * 0.12),
                'cy': H * (0.06 + r() * 0.12)
            },
            'makeBase': lambda p: [
                Point(p['bx'], -2),
                Point(p['bx'], p['cy']),
                Point(W + 2, p['cy'])
            ]
        },
        {
            'name': 'TL',
            'params': lambda: {
                'bx': W * (0.06 + r() * 0.12),
                'cy': H * (0.06 + r() * 0.12)
            },
            'makeBase': lambda p: [
                Point(p['bx'], -2),
                Point(p['bx'], p['cy']),
                Point(-2, p['cy'])
            ]
        },
        {
            'name': 'BT',
            'params': lambda: {
                'bx': W * (-0.02 + r() * 0.10),
                'dx': W * (0.32 + r() * 0.08),
                'mid': H * (0.38 + r() * 0.24)
            },
            'makeBase': lambda p: [
                Point(p['bx'], H + 2),
                Point(p['bx'], p['mid']),
                Point(p['bx'] + p['dx'], p['mid']),
                Point(p['bx'] + p['dx'], -2)
            ]
        },
        {
            'name': 'TT',
            'params': lambda: {
                'bx': W * (0.68 + r() * 0.10),
                'dx': W * (0.20 + r() * 0.08),
                'cy': H * (0.35 + r() * 0.20)
            },
            'makeBase': lambda p: [
                Point(p['bx'], -2),
                Point(p['bx'], p['cy']),
                Point(p['bx'] + p['dx'], p['cy']),
                Point(p['bx'] + p['dx'], -2)
            ]
        }
    ]

    paths = []
    for tmpl_idx, tmpl in enumerate(templates):
        p = tmpl['params']()
        print(f"\n{tmpl['name']}: params={p}")

        base_path = tmpl['makeBase'](p)

        for i in range(bundle_size):
            # Offset perpendicular for each line in bundle
            # Inner line (i=0) is offset inward (negative), outer lines outward (positive)
            perp_offset = (i - bundle_size // 2) * SP
            waypoints = offset_orthogonal(base_path, perp_offset)
            rad = base_rad

            print(f"  Line {i}: waypoints={waypoints}, rad={rad:.1f}")

            flat = flatten_orthogonal(waypoints, rad, W, H)

            if len(flat) >= 2:
                # Get bounding box
                xs = [pt.x for pt in flat]
                ys = [pt.y for pt in flat]
                bbox = (min(xs), min(ys), max(xs), max(ys))

                paths.append({
                    'template': tmpl['name'],
                    'line_idx': i,
                    'waypoints': waypoints,
                    'flat': flat,
                    'rad': rad,
                    'bbox': bbox
                })
                print(f"    bbox={bbox}")

    return paths

def check_overlaps(paths: List[dict], tolerance: float = 15.0) -> List[Tuple[int, int, float]]:
    """
    Check for overlaps between paths.
    Returns list of (path_i, path_j, min_distance) tuples for paths that come too close.
    """
    overlaps = []

    for i in range(len(paths)):
        for j in range(i + 1, len(paths)):
            flat_i = paths[i]['flat']
            flat_j = paths[j]['flat']

            min_dist = float('inf')

            for p_i in flat_i:
                for p_j in flat_j:
                    dist = math.hypot(p_i.x - p_j.x, p_i.y - p_j.y)
                    if dist < min_dist:
                        min_dist = dist

            if min_dist < tolerance:
                overlaps.append((i, j, min_dist))
                print(f"⚠️  OVERLAP: Path {i} ({paths[i]['template']}-{paths[i]['line_idx']}) "
                      f"and Path {j} ({paths[j]['template']}-{paths[j]['line_idx']}) "
                      f"are {min_dist:.1f}px apart")

    return overlaps

if __name__ == '__main__':
    # Test at typical screen size
    W, H = 1920, 1080

    # Test at 0% density (should be just 1 line per bundle)
    print("="*70)
    print("TESTING AT 0% DENSITY (1 line per bundle)")
    print("="*70)
    paths_0 = build_pathways_debug(W, H, density=0.0, seed=5)
    overlaps_0 = check_overlaps(paths_0, tolerance=15.0)

    print(f"\nTotal paths generated: {len(paths_0)}")
    print(f"Overlaps found: {len(overlaps_0)}")

    # Test at 50% density
    print("\n" + "="*70)
    print("TESTING AT 50% DENSITY")
    print("="*70)
    paths_50 = build_pathways_debug(W, H, density=0.5, seed=5)
    overlaps_50 = check_overlaps(paths_50, tolerance=15.0)

    print(f"\nTotal paths generated: {len(paths_50)}")
    print(f"Overlaps found: {len(overlaps_50)}")

    # Test at 100% density
    print("\n" + "="*70)
    print("TESTING AT 100% DENSITY")
    print("="*70)
    paths_100 = build_pathways_debug(W, H, density=1.0, seed=5)
    overlaps_100 = check_overlaps(paths_100, tolerance=15.0)

    print(f"\nTotal paths generated: {len(paths_100)}")
    print(f"Overlaps found: {len(overlaps_100)}")

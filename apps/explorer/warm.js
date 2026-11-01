// The rules that decide when warmed scrub work is still good, and how much
// of it the page may hold.
//
// This module imports nothing. It touches no DOM and no GPU. That is on
// purpose. The rest of the scrub path needs a browser to run, so none of it
// can be tested in node. These rules can, and they are the part that is easy
// to get wrong: a stale view generation shows a sharp image of the wrong
// place, and a missing budget grows without a limit.

// A string that names one view generation. Two views with the same key may
// share warmed reads. The zoom is rounded, because a fractional zoom change
// does not change which pyramid level a read should use.
export function viewKeyOf({ zoom, bounds }) {
  return `${Math.round(zoom)}|${bounds.map((v) => v.toFixed(4)).join(",")}`;
}

// True when `next` is far enough from `prev` that warmed reads no longer
// serve it. A zoom step always counts. A pan counts when the centre moves
// more than `panFraction` of the view's own width or height, so a small
// nudge does not throw away the whole stack.
export function viewChangedEnough(prev, next, panFraction = 0.25) {
  if (!prev) return true;
  if (Math.round(prev.zoom) !== Math.round(next.zoom)) return true;
  const width = prev.bounds[2] - prev.bounds[0];
  const height = prev.bounds[3] - prev.bounds[1];
  const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const [px, py] = centre(prev.bounds);
  const [nx, ny] = centre(next.bounds);
  return Math.abs(nx - px) > panFraction * width
    || Math.abs(ny - py) > panFraction * height;
}

// A byte budget over the warmed reads, which live in host memory rather than
// on the GPU. Insertion ordered, so the oldest read is the first to go.
export class WarmBudget {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.sizes = new Map();
  }

  get bytes() {
    let total = 0;
    for (const n of this.sizes.values()) total += n;
    return total;
  }

  add(id, bytes) {
    // Delete first, so a re-read moves the id to the back of the queue.
    this.sizes.delete(id);
    this.sizes.set(id, bytes);
  }

  has(id) { return this.sizes.has(id); }

  delete(id) { return this.sizes.delete(id); }

  // Drop the oldest entries until the total fits. Returns the ids dropped,
  // so the caller can downgrade each one to its soft rung.
  evictTo(maxBytes = this.maxBytes) {
    const dropped = [];
    while (this.bytes > maxBytes && this.sizes.size) {
      const oldest = this.sizes.keys().next().value;
      this.sizes.delete(oldest);
      dropped.push(oldest);
    }
    return dropped;
  }
}

// MIBS.GG/src/shared/PathBuffer.js
// ✅ MOVED: Single source of truth for the path buffer.

/**
 * PathBuffer - Stores path samples for smooth marble chain rendering
 */
export default class PathBuffer {
  constructor(sampleDistance = 2) {
    this.samples = [];
    this.sampleDistance = sampleDistance;
    this.maxSamples = 2000;
    this.totalLength = 0;
  }

  /**
   * Reset buffer with initial position
   */
  reset(x, y) {
    this.samples = [{ x, y, dist: 0 }];
    this.totalLength = 0;
  }

  /**
   * Add new point to path
   */
  add(x, y) {
    if (this.samples.length === 0) {
      this.samples.push({ x, y, dist: 0 });
      return;
    }
    
    const last = this.samples[this.samples.length - 1];
    const dx = x - last.x;
    const dy = y - last.y;
    const dist = Math.hypot(dx, dy);
    
    // Only add if moved far enough
    if (dist < this.sampleDistance * 0.5) return;
    
    this.totalLength += dist;
    this.samples.push({ x, y, dist: this.totalLength });
    
    // Limit buffer size
    if (this.samples.length > this.maxSamples) {
      const removed = this.samples.shift();
      const offset = removed.dist;
      for (const s of this.samples) {
        s.dist -= offset;
      }
      this.totalLength -= offset;
    }
  }

  /**
   * Sample position at specific distance along path
   */
  sampleAt(distance) {
    if (this.samples.length === 0) {
      return { x: 0, y: 0, angle: 0 };
    }
    if (this.samples.length === 1) {
      return { ...this.samples[0], angle: 0 };
    }
    
    distance = Math.max(0, Math.min(this.totalLength, distance));
    
    // Binary search for segment
    let left = 0;
    let right = this.samples.length - 1;
    while (left < right - 1) {
      const mid = Math.floor((left + right) / 2);
      if (this.samples[mid].dist < distance) {
        left = mid;
      } else {
        right = mid;
      }
    }
    
    const s1 = this.samples[left];
    const s2 = this.samples[right];
    
    if (s2.dist === s1.dist) {
      return { ...s1, angle: 0 };
    }
    
    // Interpolate between samples
    const t = (distance - s1.dist) / (s2.dist - s1.dist);
    const x = s1.x + (s2.x - s1.x) * t;
    const y = s1.y + (s2.y - s1.y) * t;
    const angle = Math.atan2(s2.y - s1.y, s2.x - s1.x);
    
    return { x, y, angle };
  }

  /**
   * Sample from end of path (distance from back)
   */
  sampleBack(distFromEnd) {
    return this.sampleAt(this.totalLength - distFromEnd);
  }
}
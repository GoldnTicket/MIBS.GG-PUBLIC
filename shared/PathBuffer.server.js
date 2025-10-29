// MIBS.GG/src/shared/PathBuffer.server.js
// ✅ Pure CommonJS PathBuffer for Node.js

class PathBuffer {
  constructor(sampleDistance = 2) {
    this.samples = [];
    this.sampleDistance = sampleDistance;
    this.maxSamples = 2000;
    this.totalLength = 0;
  }

  reset(x, y) {
    this.samples = [{ x, y, dist: 0 }];
    this.totalLength = 0;
  }

  add(x, y) {
    if (this.samples.length === 0) {
      this.samples.push({ x, y, dist: 0 });
      return;
    }
    
    const last = this.samples[this.samples.length - 1];
    const dx = x - last.x;
    const dy = y - last.y;
    const dist = Math.hypot(dx, dy);
    
    if (dist < this.sampleDistance * 0.5) return;
    
    this.totalLength += dist;
    this.samples.push({ x, y, dist: this.totalLength });
    
    if (this.samples.length > this.maxSamples) {
      const removed = this.samples.shift();
      const offset = removed.dist;
      for (const s of this.samples) {
        s.dist -= offset;
      }
      this.totalLength -= offset;
    }
  }

  sampleAt(distance) {
    if (this.samples.length === 0) return { x: 0, y: 0, angle: 0 };
    if (this.samples.length === 1) return { ...this.samples[0], angle: 0 };
    
    distance = Math.max(0, Math.min(this.totalLength, distance));
    
    let left = 0;
    let right = this.samples.length - 1;
    while (left < right - 1) {
      const mid = Math.floor((left + right) / 2);
      if (this.samples[mid].dist < distance) left = mid;
      else right = mid;
    }
    
    const s1 = this.samples[left];
    const s2 = this.samples[right];
    if (s2.dist === s1.dist) return { ...s1, angle: 0 };
    
    const t = (distance - s1.dist) / (s2.dist - s1.dist);
    return {
      x: s1.x + (s2.x - s1.x) * t,
      y: s1.y + (s2.y - s1.y) * t,
      angle: Math.atan2(s2.y - s1.y, s2.x - s1.x)
    };
  }

  sampleBack(distFromEnd) {
    return this.sampleAt(this.totalLength - distFromEnd);
  }
}

module.exports = PathBuffer;
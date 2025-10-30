// MIBS.GG/src/shared/PathBuffer.server.js
// ✅ Pure CommonJS PathBuffer for Node.js
// ✅ SELF-TRIMMING: Automatically maintains correct sample count

class PathBuffer {
  constructor(sampleDistance = 2) {
    this.samples = [];
    this.sampleDistance = sampleDistance;
    this.maxSamples = 2000;
    this.totalLength = 0;
    this._maxBodyLength = null; // ✅ NEW: Track expected body length
  }

  reset(x, y) {
    this.samples = [{ x, y, dist: 0 }];
    this.totalLength = 0;
  }

  /**
   * ✅ NEW: Set maximum body length for automatic trimming
   */
  setMaxBodyLength(bodyLength) {
    this._maxBodyLength = bodyLength;
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
    
    // ✅ CRITICAL FIX: Auto-trim based on body length
    if (this._maxBodyLength !== null) {
      const maxSamples = Math.ceil(this._maxBodyLength / this.sampleDistance);
      
      if (this.samples.length > maxSamples) {
        const toRemove = this.samples.length - maxSamples;
        const removed = this.samples.splice(0, toRemove);
        
        if (removed.length > 0 && this.samples.length > 0) {
          const offset = this.samples[0].dist;
          for (const s of this.samples) {
            s.dist -= offset;
          }
          this.totalLength = this.samples[this.samples.length - 1].dist;
        }
      }
    }
    else if (this.samples.length > this.maxSamples) {
      const removed = this.samples.shift();
      const offset = removed.dist;
      for (const s of this.samples) {
        s.dist -= offset;
      }
      this.totalLength -= offset;
    }
  }

  /**
   * ✅ NEW: Manual trim to specific sample count
   */
  trimToSampleCount(maxSamples) {
    if (this.samples.length <= maxSamples) return;
    
    const toRemove = this.samples.length - maxSamples;
    const removed = this.samples.splice(0, toRemove);
    
    if (removed.length > 0 && this.samples.length > 0) {
      const offset = this.samples[0].dist;
      for (const s of this.samples) {
        s.dist -= offset;
      }
      this.totalLength = this.samples.length > 0 
        ? this.samples[this.samples.length - 1].dist 
        : 0;
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

  getSampleCount() {
    return this.samples.length;
  }

  getExpectedSampleCount() {
    if (this._maxBodyLength === null) return null;
    return Math.ceil(this._maxBodyLength / this.sampleDistance);
  }
}

module.exports = PathBuffer;
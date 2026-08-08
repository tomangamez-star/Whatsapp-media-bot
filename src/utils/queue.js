'use strict'

/**
 * Minimal promise-based concurrency limiter.
 * Used to cap simultaneous yt-dlp downloads.
 */
class Queue {
  constructor (concurrency = 1) {
    this.concurrency = Math.max(1, concurrency)
    this.active = 0
    this.pending = []
  }

  get size () {
    return this.pending.length
  }

  get running () {
    return this.active
  }

  add (fn) {
    return new Promise((resolve, reject) => {
      this.pending.push({ fn, resolve, reject })
      this._pump()
    })
  }

  _pump () {
    while (this.active < this.concurrency && this.pending.length) {
      const job = this.pending.shift()
      this.active++
      Promise.resolve()
        .then(job.fn)
        .then((res) => {
          job.resolve(res)
        })
        .catch((err) => {
          job.reject(err)
        })
        .finally(() => {
          this.active--
          this._pump()
        })
    }
  }
}

module.exports = { Queue }

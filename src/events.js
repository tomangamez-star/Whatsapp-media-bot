'use strict'

/**
 * Tiny typed event bus — decouples bot, downloader, API and webhooks.
 */
const { EventEmitter } = require('events')

class Bus extends EventEmitter {
  emitSafe (event, payload) {
    try {
      this.emit(event, payload)
    } catch (err) {
      // listeners must never crash the process
    }
  }
}

module.exports = new Bus()

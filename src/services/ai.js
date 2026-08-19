'use strict'

/** Lightweight OpenAI-compatible AI client. Groq works out of the box. */

const config = require('../config')

function providerConfig () {
  if (process.env.GROQ_API_KEY) {
    return {
      key: process.env.GROQ_API_KEY,
      url: process.env.AI_API_URL || 'https://api.groq.com/openai/v1/chat/completions',
      model: process.env.AI_MODEL || 'llama-3.1-8b-instant'
    }
  }
  if (process.env.AI_API_KEY && process.env.AI_API_URL && process.env.AI_MODEL) {
    return { key: process.env.AI_API_KEY, url: process.env.AI_API_URL, model: process.env.AI_MODEL }
  }
  return null
}

function configured () {
  return Boolean(providerConfig())
}

async function askAI ({ prompt, groupName, senderName }) {
  const provider = providerConfig()
  if (!provider) throw new Error('AI is enabled but no provider is configured. Set GROQ_API_KEY (or AI_API_KEY + AI_API_URL + AI_MODEL).')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs)
  try {
    const res = await fetch(provider.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.key}`,
        'content-type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.7,
        max_tokens: config.ai.maxTokens,
        messages: [
          {
            role: 'system',
            content: `You are ${config.bot.name}, a fast, friendly WhatsApp assistant owned by ${config.bot.ownerName}. Keep replies concise and useful. Do not flood the chat. Use plain WhatsApp-friendly text; avoid giant headings and unnecessary disclaimers.`
          },
          {
            role: 'user',
            content: `${senderName ? `Sender: ${senderName}\n` : ''}${groupName ? `Group: ${groupName}\n` : ''}${prompt}`
          }
        ]
      })
    })

    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const detail = body?.error?.message || body?.message || `HTTP ${res.status}`
      throw new Error(`AI provider error: ${detail}`)
    }
    const text = String(body?.choices?.[0]?.message?.content || '').trim()
    if (!text) throw new Error('AI provider returned an empty reply')
    return text.slice(0, config.ai.maxReplyChars)
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { askAI, configured }

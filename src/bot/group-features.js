'use strict'

const config = require('../config')
const db = require('../db')
const logger = require('../logger')
const { askAI, configured: aiConfigured } = require('../services/ai')

const spamWindows = new Map()
const spamWarnedAt = new Map()
const warnings = new Map()
const aiCooldowns = new Map()
const aiInflight = new Set()
const metadataCache = new Map()

const METADATA_TTL_MS = 30000
const SPAM_WINDOW_MS = 8000
const SPAM_LIMIT = 6
const SPAM_WARN_COOLDOWN_MS = 5000
const WARNING_TTL_MS = 15 * 60 * 1000

function digits (jid) { return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '') }
function settingKey (group, name) { return `group:${group}:${name}` }
function getGroupSetting (group, name, fallback = 'off') { return db.getSetting(settingKey(group, name)) || fallback }
function setGroupSetting (group, name, value) { db.setSetting(settingKey(group, name), value); return value }

function unwrapMessage (message) {
  let m = message || {}
  for (let i = 0; i < 5; i++) {
    if (m.ephemeralMessage?.message) { m = m.ephemeralMessage.message; continue }
    if (m.viewOnceMessage?.message) { m = m.viewOnceMessage.message; continue }
    if (m.viewOnceMessageV2?.message) { m = m.viewOnceMessageV2.message; continue }
    if (m.documentWithCaptionMessage?.message) { m = m.documentWithCaptionMessage.message; continue }
    break
  }
  return m
}

function contextInfo (msg) {
  const m = unwrapMessage(msg?.message)
  return m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo || m.documentMessage?.contextInfo || {}
}

function participantMatches (participant, jid) {
  if (!participant || !jid) return false
  if (participant.id === jid || participant.phoneNumber === jid || participant.lid === jid) return true
  const target = digits(jid)
  return [participant.id, participant.phoneNumber, participant.lid].some((v) => v && digits(v) === target)
}

async function metadata (sock, groupJid, fresh = false) {
  const now = Date.now()
  const cached = metadataCache.get(groupJid)
  if (!fresh && cached && now - cached.at < METADATA_TTL_MS) return cached.value
  const value = await sock.groupMetadata(groupJid)
  metadataCache.set(groupJid, { value, at: now })
  return value
}

async function isAdmin (sock, groupJid, jid) {
  try {
    const md = await metadata(sock, groupJid)
    const p = md.participants.find((x) => participantMatches(x, jid))
    return Boolean(p?.admin)
  } catch {
    return false
  }
}

async function botIsAdmin (sock, groupJid) {
  const botJid = sock.user?.id
  if (!botJid) return false
  return isAdmin(sock, groupJid, botJid)
}

async function requireGroupAdmin (sock, groupJid, senderJid, owner) {
  if (owner) return true
  return isAdmin(sock, groupJid, senderJid)
}

function targetFromMessage (msg, arg) {
  const ctx = contextInfo(msg)
  const mentioned = Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid.filter(Boolean) : []
  if (mentioned[0]) return mentioned[0]
  if (ctx.participant) return ctx.participant
  const m = String(arg || '').match(/@?(\d{7,15})/)
  return m ? `${m[1]}@s.whatsapp.net` : null
}

async function sendText (sock, jid, text, mentions = []) {
  return sock.sendMessage(jid, { text, mentions })
}

async function deleteMessage (sock, groupJid, msg) {
  try {
    await sock.sendMessage(groupJid, { delete: msg.key })
    return true
  } catch (err) {
    logger.warn('[group] delete failed: %s', err.message)
    return false
  }
}

function warningState (kind, groupJid, senderJid) {
  const key = `${kind}:${groupJid}:${senderJid}`
  const now = Date.now()
  const prev = warnings.get(key)
  const count = !prev || now - prev.at > WARNING_TTL_MS ? 1 : prev.count + 1
  warnings.set(key, { count, at: now })
  return { key, count }
}

async function warnAndMaybeRemove (sock, { kind, groupJid, senderJid, reason, removeAtThree }) {
  const { key, count } = warningState(kind, groupJid, senderJid)
  const tag = `@${digits(senderJid)}`
  if (count >= 3) {
    await sendText(sock, groupJid, `⚠️ ${tag}, *${config.bot.name} has warned you for the last time.*\nReason » ${reason}`, [senderJid])
    if (removeAtThree && await botIsAdmin(sock, groupJid)) {
      try {
        await sock.groupParticipantsUpdate(groupJid, [senderJid], 'remove')
        warnings.delete(key)
        await sendText(sock, groupJid, `🛡️ ${tag} was removed after 3 warnings.`, [senderJid])
      } catch (err) {
        logger.warn('[group] remove after warnings failed: %s', err.message)
      }
    }
    return count
  }
  await sendText(sock, groupJid, `⚠️ ${tag}, warning *${count}/3* from ${config.bot.name}.\nReason » ${reason}`, [senderJid])
  return count
}

function containsLink (text) {
  return /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/|t\.me\/|discord\.gg\/|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[\w/?#=&%+.-]*)/i.test(String(text || ''))
}

async function moderateIncoming (sock, { msg, groupJid, senderJid, text, owner, isCommand }) {
  if (!groupJid?.endsWith('@g.us') || msg.key.fromMe) return false

  const antiLink = getGroupSetting(groupJid, 'antilink', 'off')
  const antiSpam = getGroupSetting(groupJid, 'antispam', 'off')
  // Fast path: do not fetch group metadata on every message when moderation is off.
  if (antiLink === 'off' && antiSpam !== 'on') return false

  // Group admins/owner are exempt from automatic moderation.
  if (owner || await isAdmin(sock, groupJid, senderJid)) return false
  if (!isCommand && antiLink !== 'off' && containsLink(text)) {
    if (antiLink === 'delete' || antiLink === 'on') await deleteMessage(sock, groupJid, msg)
    if (antiLink === 'warn' || antiLink === 'on') {
      await warnAndMaybeRemove(sock, {
        kind: 'link', groupJid, senderJid,
        reason: 'Links are not allowed in this group.',
        removeAtThree: antiLink === 'on'
      })
    }
    return true
  }

  if (antiSpam === 'on') {
    const now = Date.now()
    const key = `${groupJid}:${senderJid}`
    const recent = (spamWindows.get(key) || []).filter((entry) => now - entry.at <= SPAM_WINDOW_MS)
    recent.push({ at: now, key: msg.key })
    spamWindows.set(key, recent)

    if (recent.length >= SPAM_LIMIT) {
      // Remove the detected burst, not just the final message that crossed the threshold.
      if (await botIsAdmin(sock, groupJid)) {
        for (const entry of recent) {
          try { await sock.sendMessage(groupJid, { delete: entry.key }) } catch { /* best effort */ }
        }
      } else {
        await deleteMessage(sock, groupJid, msg)
      }
      const lastWarn = spamWarnedAt.get(key) || 0
      if (now - lastWarn >= SPAM_WARN_COOLDOWN_MS) {
        spamWarnedAt.set(key, now)
        spamWindows.set(key, [])
        await warnAndMaybeRemove(sock, {
          kind: 'spam', groupJid, senderJid,
          reason: 'Message flooding/spam detected.',
          removeAtThree: true
        })
      }
      return true
    }
  }
  return false
}

async function handleGroupCommand (sock, { cmd, arg, msg, groupJid, senderJid, owner, reply, prefix }) {
  const supported = new Set(['kick', 'setwelcome', 'goodbye', 'antispam', 'antilink', 'ai'])
  if (!supported.has(cmd)) return false
  if (!groupJid?.endsWith('@g.us')) {
    await reply('⚠️ This command only works inside a WhatsApp group.')
    return true
  }

  if (!await requireGroupAdmin(sock, groupJid, senderJid, owner)) {
    await reply('🔐 Only a group admin or the bot owner can use this command.')
    return true
  }

  if (cmd === 'kick') {
    if (!await botIsAdmin(sock, groupJid)) {
      await reply(`❌ ${config.bot.name} must be a group admin before it can remove members.`)
      return true
    }
    const target = targetFromMessage(msg, arg)
    if (!target) {
      await reply(`Usage: ${prefix}kick @user\nYou can also reply to a member's message with ${prefix}kick.`)
      return true
    }
    if (participantMatches({ id: sock.user?.id }, target)) {
      await reply('😂 I am not kicking myself.')
      return true
    }
    try {
      await sock.groupParticipantsUpdate(groupJid, [target], 'remove')
      await sendText(sock, groupJid, `🛡️ @${digits(target)} has been removed by ${config.bot.name}.`, [target])
    } catch (err) {
      await reply(`❌ Kick failed: ${err.message}`)
    }
    return true
  }

  const value = String(arg || '').toLowerCase().trim()
  if (cmd === 'antilink') {
    const allowed = ['on', 'off', 'delete', 'warn']
    if (!allowed.includes(value)) {
      await reply(`Usage: ${prefix}antilink <on|off|delete|warn>\n• on » delete + warn + remove after 3 warnings\n• delete » delete links only\n• warn » warn only\n• off » disabled`)
      return true
    }
    setGroupSetting(groupJid, 'antilink', value)
    await reply(`✅ Anti-link mode » *${value.toUpperCase()}*`)
    return true
  }

  if (!['on', 'off'].includes(value)) {
    await reply(`Usage: ${prefix}${cmd} <on|off>`)
    return true
  }

  const settingName = cmd === 'setwelcome' ? 'welcome' : cmd
  setGroupSetting(groupJid, settingName, value)
  if (cmd === 'ai' && value === 'on' && !aiConfigured()) {
    await reply('⚠️ AI is enabled for this group, but no AI provider key is configured yet. Set GROQ_API_KEY on Render.')
  } else {
    await reply(`✅ ${cmd === 'setwelcome' ? 'Welcome' : cmd.toUpperCase()} » *${value.toUpperCase()}*`)
  }
  return true
}

function randomOf (items) { return items[Math.floor(Math.random() * items.length)] }

async function handleGroupParticipantsUpdate (sock, update) {
  const groupJid = update?.id
  const participants = update?.participants || []
  if (!groupJid || !participants.length) return
  metadataCache.delete(groupJid)
  let md = null
  try { md = await metadata(sock, groupJid, true) } catch { /* best effort */ }
  const groupName = md?.subject || 'the group'

  for (const rawParticipant of participants) {
    const participant = typeof rawParticipant === 'string'
      ? rawParticipant
      : (rawParticipant?.id || rawParticipant?.phoneNumber || rawParticipant?.lid || '')
    if (!participant || digits(participant) === digits(sock.user?.id)) continue
    const tag = `@${digits(participant)}`

    if (update.action === 'add' && getGroupSetting(groupJid, 'welcome', 'off') === 'on') {
      const caption = randomOf([
        `👋 ${tag}, welcome to *${groupName}*. Your presence is noticed.`,
        `✨ Welcome ${tag} to *${groupName}*. Pantheon has registered your arrival.`,
        `🛰️ New presence detected: ${tag}. Welcome to *${groupName}*.`,
        `⚡ ${tag} just entered *${groupName}*. Make yourself at home.`
      ])
      try {
        const pp = await sock.profilePictureUrl(participant, 'image').catch(() => null)
        if (pp) await sock.sendMessage(groupJid, { image: { url: pp }, caption, mentions: [participant] })
        else await sendText(sock, groupJid, caption, [participant])
      } catch (err) {
        logger.warn('[welcome] failed: %s', err.message)
      }
    }

    if (update.action === 'remove' && getGroupSetting(groupJid, 'goodbye', 'off') === 'on') {
      const text = randomOf([
        `👋 ${tag} has left *${groupName}*.`,
        `📡 Presence lost: ${tag} has exited *${groupName}*.`,
        `🌙 Farewell ${tag}. *${groupName}* will remember the signal.`,
        `🚪 ${tag} has departed *${groupName}*. Until next time.`
      ])
      try { await sendText(sock, groupJid, text, [participant]) } catch (err) { logger.warn('[goodbye] failed: %s', err.message) }
    }
  }
}

function aiDirectedAtBot (sock, msg, text) {
  const ctx = contextInfo(msg)
  const botDigits = digits(sock.user?.id)
  const mentioned = (ctx.mentionedJid || []).some((jid) => digits(jid) === botDigits)
  const repliedToBot = ctx.participant && digits(ctx.participant) === botDigits
  const named = /^\s*(?:@?pantheon|🅟🅐🅝🅣🅗🅔🅞🅝)\b[,:\s-]*/i.test(String(text || ''))
  return mentioned || repliedToBot || named
}

function cleanAiPrompt (text) {
  return String(text || '')
    .replace(/^\s*(?:@?pantheon|🅟🅐🅝🅣🅗🅔🅞🅝)\b[,:\s-]*/i, '')
    .replace(/@\d{5,20}/g, '')
    .trim()
}

async function maybeReplyAI (sock, { msg, groupJid, senderJid, text }) {
  if (!groupJid?.endsWith('@g.us')) return false
  if (getGroupSetting(groupJid, 'ai', 'off') !== 'on') return false
  if (!aiDirectedAtBot(sock, msg, text)) return false

  const prompt = cleanAiPrompt(text)
  if (!prompt) return false

  const key = `${groupJid}:${senderJid}`
  const now = Date.now()
  if (now - (aiCooldowns.get(key) || 0) < config.ai.cooldownMs || aiInflight.has(key)) return true
  aiCooldowns.set(key, now)
  aiInflight.add(key)

  try {
    const md = await metadata(sock, groupJid).catch(() => null)
    const response = await askAI({ prompt, groupName: md?.subject, senderName: `@${digits(senderJid)}` })
    await sendText(sock, groupJid, response, [senderJid])
  } catch (err) {
    logger.warn('[ai] reply failed: %s', err.message)
    // Configuration errors are useful; transient provider errors stay quiet to avoid spam.
    if (/no provider|not configured/i.test(err.message)) {
      await sendText(sock, groupJid, `⚠️ ${config.bot.name} AI is enabled but not configured by the owner yet.`)
    }
  } finally {
    aiInflight.delete(key)
  }
  return true
}

module.exports = {
  getGroupSetting,
  setGroupSetting,
  handleGroupCommand,
  handleGroupParticipantsUpdate,
  moderateIncoming,
  maybeReplyAI
}

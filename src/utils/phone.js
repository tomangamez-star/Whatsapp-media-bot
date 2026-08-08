'use strict'

/**
 * Phone number normalization for WhatsApp pairing.
 *
 * Baileys' requestPairingCode() needs the number in E.164 form WITHOUT the
 * leading "+" and WITHOUT any leading zeros — e.g. a Nigerian number
 * +234 707 445 5500 must be sent as "2347074455500".
 *
 * Accepts every common user input and resolves it to that canonical form:
 *   "+2347074455500"  -> "2347074455500"   (leading "+" stripped)
 *   "2347074455500"   -> "2347074455500"   (already canonical)
 *   "002347074455500" -> "2347074455500"   (international "00" prefix)
 *   "07074455500"     -> "2347074455500"   (national format: leading 0 replaced
 *                                           by the default country code)
 *
 * When the input is national format ("0…") and no defaultCountryCode is
 * configured, the leading 0 is kept (best effort — will likely be rejected by
 * WhatsApp, which is the correct signal that DEFAULT_COUNTRY_CODE must be set).
 */

function normalizePhone (raw, defaultCountryCode) {
  let s = String(raw == null ? '' : raw).trim().replace(/[^\d+]/g, '')
  if (!s) return ''
  if (s.startsWith('+')) {
    s = s.slice(1) // "+234..." -> "234..."
  } else if (s.startsWith('00')) {
    s = s.slice(2) // "00234..." -> "234..."
  } else if (s.startsWith('0')) {
    const cc = String(defaultCountryCode == null ? '' : defaultCountryCode).replace(/\D/g, '')
    if (cc) s = cc + s.slice(1) // "0707..." -> "234707..."
  }
  return s
}

function validPhone (s) {
  return /^\d{8,15}$/.test(String(s || ''))
}

module.exports = { normalizePhone, validPhone }

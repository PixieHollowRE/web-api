const MORE_OPTIONS_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const MORE_OPTIONS_EMPTY = 'A'.repeat(24)
const FAVORITE_BADGE_OFFSET = 10

const FAVORITE_REQUEST_ROOTS = (body) => [
  body,
  body.updatefavoritebadgerequest
].filter(Boolean)

function normalizeMoreOptions (moreOptions) {
  if (!moreOptions || moreOptions.length !== 24) {
    return MORE_OPTIONS_EMPTY
  }

  if (moreOptions.split('').every((char) => char === '0')) {
    return MORE_OPTIONS_EMPTY
  }

  if (moreOptions.split('').some((char) => !MORE_OPTIONS_ALPHABET.includes(char))) {
    return MORE_OPTIONS_EMPTY
  }

  return moreOptions
}

function decodeMoreOptions (moreOptions) {
  moreOptions = normalizeMoreOptions(moreOptions)
  let bits = 0
  let bitCount = 0
  const decoded = []

  for (const char of moreOptions) {
    const value = MORE_OPTIONS_ALPHABET.indexOf(char)
    bits = (bits << 6) | value
    bitCount += 6
    while (bitCount >= 8) {
      bitCount -= 8
      decoded.push((bits >> bitCount) & 0xFF)
    }
  }

  return Buffer.from(decoded)
}

function parseFavoriteBadgeFromMoreOptions (moreOptions) {
  const decoded = decodeMoreOptions(moreOptions)
  if (decoded.length < FAVORITE_BADGE_OFFSET + 2) {
    return 0
  }

  const badgeId =
    decoded[FAVORITE_BADGE_OFFSET] |
    (decoded[FAVORITE_BADGE_OFFSET + 1] << 8)

  if (badgeId < 10000 || badgeId > 32767) {
    return 0
  }

  return badgeId
}

async function persistFavoriteBadge (fairy, badgeId) {
  badgeId = Number(badgeId)
  if (!Number.isFinite(badgeId) || badgeId <= 0) {
    return false
  }

  const earnedBadges = Array.isArray(fairy.earnedBadges) ? fairy.earnedBadges : []
  const earnedBadgeIds = new Set(
    earnedBadges.map((entry) => Number(entry.badgeId))
  )
  if (!earnedBadgeIds.has(badgeId)) {
    return false
  }

  fairy.moreOptions = setFavoriteInMoreOptions(fairy.moreOptions, badgeId)
  fairy.favoriteBadgeId = badgeId
  await fairy.save()
  return true
}

function extractFavoriteBadgeId (body) {
  if (!body || typeof body !== 'object') {
    return 0
  }

  const unwrap = (value) => {
    if (value === undefined || value === null) {
      return 0
    }
    if (typeof value === 'object' && value._ !== undefined) {
      return unwrap(value._)
    }
    const raw = Array.isArray(value) ? value[0] : value
    if (typeof raw === 'object' && raw !== null) {
      return 0
    }
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  const badgeKeys = [
    'badge_id',
    'badgeId',
    'fav_badge',
    'favorite_badge',
    'favoriteBadgeId',
    'favorite_badge_id'
  ]

  const walk = (node, parentKey = '') => {
    if (!node || typeof node !== 'object') {
      return 0
    }

    if (node.$ && typeof node.$ === 'object') {
      for (const key of badgeKeys) {
        const parsed = unwrap(node.$[key])
        if (parsed) {
          return parsed
        }
      }
    }

    const keys = parentKey === 'badge'
      ? [...badgeKeys, 'id']
      : badgeKeys

    for (const key of keys) {
      const parsed = unwrap(node[key])
      if (parsed) {
        return parsed
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === '$') {
        continue
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const parsed = walk(item, key)
          if (parsed) {
            return parsed
          }
        }
      } else if (typeof value === 'object' && value !== null) {
        const parsed = walk(value, key)
        if (parsed) {
          return parsed
        }
      }
    }

    return 0
  }

  const roots = FAVORITE_REQUEST_ROOTS(body)

  for (const root of roots) {
    const items = Array.isArray(root) ? root : [root]
    for (const item of items) {
      const parsed = walk(item)
      if (parsed) {
        return parsed
      }
    }
  }

  return 0
}

const PROFILE_REQUEST_ROOTS = (body) => [
  body?.fairiesprofilerequest,
  body?.FairiesProfileRequest
].filter(Boolean)

function unwrapXmlStringField (value) {
  if (value === undefined || value === null) {
    return ''
  }
  if (typeof value === 'object' && value._ !== undefined) {
    return unwrapXmlStringField(value._)
  }
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw === 'object' && raw !== null) {
    return ''
  }
  return String(raw)
}

function extractStringFieldFromNode (node, fieldKeys) {
  if (!node || typeof node !== 'object') {
    return ''
  }

  if (node.$ && typeof node.$ === 'object') {
    for (const key of fieldKeys) {
      const parsed = unwrapXmlStringField(node.$[key])
      if (parsed) {
        return parsed
      }
    }
  }

  for (const key of fieldKeys) {
    const parsed = unwrapXmlStringField(node[key])
    if (parsed) {
      return parsed
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === '$') {
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const parsed = extractStringFieldFromNode(item, fieldKeys)
        if (parsed) {
          return parsed
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      const parsed = extractStringFieldFromNode(value, fieldKeys)
      if (parsed) {
        return parsed
      }
    }
  }

  return ''
}

function extractStringFieldFromBody (body, fieldKeys) {
  if (!body || typeof body !== 'object') {
    return ''
  }

  const roots = FAVORITE_REQUEST_ROOTS(body)

  for (const root of roots) {
    const items = Array.isArray(root) ? root : [root]
    for (const item of items) {
      const parsed = extractStringFieldFromNode(item, fieldKeys)
      if (parsed) {
        return parsed
      }
    }
  }

  return ''
}

function extractMoreOptionsFromBody (body) {
  return extractStringFieldFromBody(body, [
    'more_options',
    'moreOptions',
    'moreoptions'
  ])
}

function extractFairyIdFromBody (body) {
  const profileFieldKeys = [
    'fairy_id',
    'fairyId',
    'fairyid',
    'id'
  ]

  for (const root of PROFILE_REQUEST_ROOTS(body)) {
    const items = Array.isArray(root) ? root : [root]
    for (const item of items) {
      const raw = extractStringFieldFromNode(item, profileFieldKeys)
      const parsed = Number(raw)
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed
      }
    }
  }

  const raw = extractStringFieldFromBody(body, [
    'fairy_id',
    'fairyId',
    'fairyid',
    'id'
  ])
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function resolveFavoriteFromRequest (body) {
  const badgeId = extractFavoriteBadgeId(body)
  const moreOptions = extractMoreOptionsFromBody(body)

  if (badgeId > 0) {
    return { badgeId, moreOptions: moreOptions || null }
  }

  if (moreOptions) {
    const parsed = parseFavoriteBadgeFromMoreOptions(moreOptions)
    if (parsed > 0) {
      return { badgeId: parsed, moreOptions }
    }
    return { badgeId: 0, moreOptions }
  }

  return { badgeId: 0, moreOptions: null }
}

async function persistFavoriteFromRequest (fairy, { badgeId, moreOptions }) {
  const earnedBadges = Array.isArray(fairy.earnedBadges) ? fairy.earnedBadges : []
  const earnedBadgeIds = new Set(
    earnedBadges.map((entry) => Number(entry.badgeId))
  )

  if (moreOptions) {
    const repaired = repairMoreOptions(
      moreOptions,
      badgeId > 0 ? badgeId : Number(fairy.favoriteBadgeId || 0),
      earnedBadgeIds
    )
    fairy.moreOptions = repaired
    fairy.favoriteBadgeId = parseFavoriteBadgeFromMoreOptions(repaired)

    if (fairy.favoriteBadgeId <= 0 && badgeId > 0) {
      return persistFavoriteBadge(fairy, badgeId)
    }

    if (fairy.favoriteBadgeId > 0) {
      await fairy.save()
      return true
    }

    await fairy.save()
    return false
  }

  if (badgeId > 0) {
    return persistFavoriteBadge(fairy, badgeId)
  }

  return false
}

function pickFavoriteId (parsed, favoriteBadgeId, earnedBadgeIds) {
  if (earnedBadgeIds.has(parsed)) {
    return parsed
  }
  if (earnedBadgeIds.has(favoriteBadgeId)) {
    return favoriteBadgeId
  }
  return 0
}

function isCorruptMoreOptions (moreOptions, earnedBadgeIds = new Set()) {
  moreOptions = normalizeMoreOptions(moreOptions)
  if (moreOptions === MORE_OPTIONS_EMPTY) {
    return false
  }

  const decoded = decodeMoreOptions(moreOptions)
  if (decoded.length !== 18) {
    return true
  }

  const favorite = parseFavoriteBadgeFromMoreOptions(moreOptions)
  if (
    favorite >= 10000 &&
    earnedBadgeIds.size > 0 &&
    !earnedBadgeIds.has(favorite)
  ) {
    return true
  }

  return false
}

function setFavoriteInMoreOptions (moreOptions, favorite) {
  moreOptions = normalizeMoreOptions(moreOptions)
  const decoded = Buffer.from(decodeMoreOptions(moreOptions))
  const payload = Buffer.alloc(18, 0)
  decoded.copy(payload, 0, 0, Math.min(decoded.length, 18))
  payload[FAVORITE_BADGE_OFFSET] = favorite & 0xFF
  payload[FAVORITE_BADGE_OFFSET + 1] = (favorite >> 8) & 0xFF

  let bits = 0
  let bitCount = 0
  const encoded = []

  for (const byte of payload) {
    bits = (bits << 8) | byte
    bitCount += 8
    while (bitCount >= 6) {
      bitCount -= 6
      const index = (bits >> bitCount) & 0x3F
      encoded.push(MORE_OPTIONS_ALPHABET[index])
    }
  }

  if (bitCount) {
    bits <<= 6 - bitCount
    encoded.push(MORE_OPTIONS_ALPHABET[bits & 0x3F])
  }

  return encoded.join('').slice(0, 24).padEnd(24, 'A')
}

function resolveFavoriteBadgeFromValues (
  moreOptions,
  favoriteBadgeId = 0,
  earnedBadgeIds = new Set()
) {
  moreOptions = normalizeMoreOptions(moreOptions)
  const stored = Number(favoriteBadgeId || 0)
  const parsed = parseFavoriteBadgeFromMoreOptions(moreOptions)
  const favorite = pickFavoriteId(parsed, stored, earnedBadgeIds)

  if (isCorruptMoreOptions(moreOptions, earnedBadgeIds)) {
    const base = MORE_OPTIONS_EMPTY
    if (favorite > 0) {
      const repaired = setFavoriteInMoreOptions(base, favorite)
      return { moreOptions: repaired, favoriteBadgeId: favorite }
    }
    if (parsed > 0 && !earnedBadgeIds.has(parsed)) {
      return {
        moreOptions: setFavoriteInMoreOptions(base, 0),
        favoriteBadgeId: 0
      }
    }
    return { moreOptions: base, favoriteBadgeId: 0 }
  }

  if (favorite > 0) {
    return {
      moreOptions: setFavoriteInMoreOptions(moreOptions, favorite),
      favoriteBadgeId: favorite
    }
  }

  if (parsed > 0 && !earnedBadgeIds.has(parsed)) {
    return {
      moreOptions: setFavoriteInMoreOptions(moreOptions, 0),
      favoriteBadgeId: 0
    }
  }

  return { moreOptions, favoriteBadgeId: 0 }
}

function repairMoreOptions (
  moreOptions,
  favoriteBadgeId = 0,
  earnedBadgeIds = new Set()
) {
  return resolveFavoriteBadgeFromValues(
    moreOptions,
    favoriteBadgeId,
    earnedBadgeIds
  ).moreOptions
}

function resolveFavoriteBadge (fairy) {
  const earnedBadges = Array.isArray(fairy.earnedBadges) ? fairy.earnedBadges : []
  const earnedBadgeIds = new Set(
    earnedBadges.map((entry) => Number(entry.badgeId))
  )
  return resolveFavoriteBadgeFromValues(
    fairy.moreOptions,
    Number(fairy.favoriteBadgeId || 0),
    earnedBadgeIds
  )
}

module.exports = {
  MORE_OPTIONS_EMPTY,
  parseFavoriteBadgeFromMoreOptions,
  setFavoriteInMoreOptions,
  persistFavoriteBadge,
  extractFavoriteBadgeId,
  extractMoreOptionsFromBody,
  extractFairyIdFromBody,
  resolveFavoriteFromRequest,
  persistFavoriteFromRequest,
  repairMoreOptions,
  resolveFavoriteBadge,
  resolveFavoriteBadgeFromValues
}

/* global app:writable */
/* global db:writeable */

app = global.app

const createXML = require('../utils/xml')
const {
  parseFavoriteBadgeFromMoreOptions,
  persistFavoriteBadge,
  extractFairyIdFromBody,
  resolveFavoriteFromRequest,
  repairMoreOptions,
  setFavoriteInMoreOptions,
  resolveFavoriteBadge,
  resolveFavoriteBadgeFromValues
} = require('../utils/moreOptions')
const {
  shouldAckMemberDays,
  NON_MEMBER_DAYS
} = require('../utils/loyalty')

const express = require('express')

const CryptoJS = require('crypto-js')

const fs = require('fs')
const { XMLParser } = require('fast-xml-parser')

const loginQueue = []

const PACIFIC_TIME_ZONE = 'America/Los_Angeles'

function getPacificServerTime () {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: PACIFIC_TIME_ZONE,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date()).map(({ type, value }) => [type, value])
  )
  const hour = Number(parts.hour) % 24
  const minute = Number(parts.minute)
  return {
    day: `${parts.year}/${parts.month}/${parts.day}`,
    time: `${hour}:${String(minute).padStart(2, '0')}`
  }
}

// Coliseum leaderboard panel requests dna=1 and queues AvatarBustBitmapRequest per row.
// Fairies without avatar DNA leave the panel stuck on the loading hourglass.
const MINIMAL_PROFILE_AVATAR = {
  proportions: { head: 95, height: 100, body: 90 },
  rotations: {
    head_rot: 15,
    ll_arm_rot: -11,
    ul_arm_rot: -55,
    ul_leg_rot: -4,
    ll_leg_rot: 9,
    lr_arm_rot: -14,
    ur_arm_rot: 57,
    lr_leg_rot: 15,
    ur_leg_rot: 0
  },
  hair_back: 5555,
  hair_front: 5044,
  face: 4539,
  eye: 4039,
  wing: 6003,
  hair_color: 76,
  eye_color: 71,
  skin_color: 103,
  wing_color: 109,
  hair_color2: 0,
  items: []
}

function profileAvatarSource(fairy, includeAvatarExplicit) {
  if (fairy.avatar) {
    return fairy.avatar
  }
  if (includeAvatarExplicit) {
    return MINIMAL_PROFILE_AVATAR
  }
  return null
}

function profileCreatedDate(fairy) {
  if (fairy.created && typeof fairy.created.toISOString === 'function') {
    return fairy.created.toISOString().split('T')[0]
  }
  return new Date().toISOString().split('T')[0]
}

function profileTutorialBitmask(fairy) {
  const bits = Array.isArray(fairy.tutorialBitmask) ? fairy.tutorialBitmask : [0, 0]
  return [Number(bits[0] || 0), Number(bits[1] || 0)]
}

function isSyntheticLeaderboardOwner(ownerUsername) {
  return typeof ownerUsername === 'string' && ownerUsername.startsWith('__leaderboard_')
}

const LEADERBOARD_BUST_XML_CACHE = new Map()
const LEADERBOARD_BUST_XML_CACHE_LIMIT = 512
const LEADERBOARD_SNAPSHOT_BY_ID = new Map()

function minimalLeaderboardBustFairy(fairyId) {
  return {
    _id: Number(fairyId),
    name: 'Fairy',
    address: '',
    gender: 2,
    talent: 1,
    avatar: MINIMAL_PROFILE_AVATAR,
    tutorialBitmask: [0, 0],
    moreOptions: 'AAAAAAAAAAAAAAAAAAAAAAAA',
    accountId: 0,
    chosen: true,
    icon: 164,
    game_prof_bg: '50',
    optionsBitmask: 0,
    level: 1
  }
}

function fairyFromLeaderboardEntry(entry) {
  const profile = entry.displayProfile || {}
  return {
    _id: entry.avId,
    name: entry.avName || '',
    address: `${entry.addrNum || 0}${entry.addrStr || ''}`,
    gender: profile.gender ?? 2,
    talent: profile.talent ?? 1,
    avatar: profile.avatar || null,
    tutorialBitmask: [0, 0],
    moreOptions: 'AAAAAAAAAAAAAAAAAAAAAAAA',
    accountId: 0,
    chosen: true,
    icon: 164,
    game_prof_bg: '50',
    optionsBitmask: 0,
    level: 1
  }
}

async function loadLeaderboardSnapshotFairy(fairyId) {
  const idNum = Number(fairyId)
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return null
  }

  const cached = LEADERBOARD_SNAPSHOT_BY_ID.get(idNum)
  if (cached) {
    return cached
  }

  const coll = db.db.collection('leaderboard_data')
  const meta = await coll.findOne({ _id: 'meta' })
  const weekId = meta?.currentWeeklyId
  if (!weekId) {
    return null
  }

  const escapedWeek = String(weekId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const docs = await coll.find({
    _id: { $regex: `^weekly:\\d+:${escapedWeek}$` }
  }).toArray()

  for (const doc of docs) {
    for (const entry of doc.entries || []) {
      if (Number(entry.avId) === idNum) {
        const fairy = fairyFromLeaderboardEntry(entry)
        LEADERBOARD_SNAPSHOT_BY_ID.set(idNum, fairy)
        return fairy
      }
    }
  }
  return null
}

function cacheLeaderboardBustXml(fairyId, xml) {
  if (LEADERBOARD_BUST_XML_CACHE.size >= LEADERBOARD_BUST_XML_CACHE_LIMIT) {
    LEADERBOARD_BUST_XML_CACHE.clear()
  }
  LEADERBOARD_BUST_XML_CACHE.set(String(fairyId), xml)
}

async function warmLeaderboardEntries(entries, seen) {
  let warmed = 0
  for (const entry of entries) {
    const id = Number(entry.avId)
    if (!id || seen.has(id) || !entry.avName) {
      continue
    }
    seen.add(id)
    const fairy = fairyFromLeaderboardEntry(entry)
    if (!profileAvatarSource(fairy, true)) {
      fairy.avatar = MINIMAL_PROFILE_AVATAR
    }
    LEADERBOARD_SNAPSHOT_BY_ID.set(id, fairy)
    cacheLeaderboardBustXml(id, buildLeaderboardBustProfileXml(fairy))
    warmed++
  }
  return warmed
}

async function warmLeaderboardBustCacheForIds(fairyIds) {
  try {
    const want = new Set(
      (fairyIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
    if (!want.size) {
      return 0
    }

    const coll = db.db.collection('leaderboard_data')
    const meta = await coll.findOne({ _id: 'meta' })
    const weekId = meta?.currentWeeklyId
    if (!weekId) {
      return 0
    }

    const escapedWeek = String(weekId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const docs = await coll.find({
      _id: { $regex: `^weekly:\\d+:${escapedWeek}$` }
    }).toArray()

    const seen = new Set()
    let warmed = 0
    for (const doc of docs) {
      const matching = (doc.entries || []).filter((entry) =>
        want.has(Number(entry.avId))
      )
      warmed += await warmLeaderboardEntries(matching, seen)
    }

    for (const fairyId of want) {
      if (seen.has(fairyId)) {
        continue
      }
      const fairy = await loadLeaderboardSnapshotFairy(fairyId)
      if (!fairy) {
        continue
      }
      if (!profileAvatarSource(fairy, true)) {
        fairy.avatar = MINIMAL_PROFILE_AVATAR
      }
      cacheLeaderboardBustXml(fairyId, buildLeaderboardBustProfileXml(fairy))
      warmed++
    }

    if (warmed > 0) {
      console.log(
        `[lbBust] targeted warm fairyIds=${[...want].join(',')} warmed=${warmed}`
      )
    }
    return warmed
  } catch (err) {
    console.error('warmLeaderboardBustCacheForIds failed:', err.message)
    return 0
  }
}

async function warmLeaderboardBustCache(options = {}) {
  const fairyIds = options.fairyIds
  if (Array.isArray(fairyIds) && fairyIds.length > 0) {
    return warmLeaderboardBustCacheForIds(fairyIds)
  }

  try {
    const coll = db.db.collection('leaderboard_data')
    const meta = await coll.findOne({ _id: 'meta' })
    const weekId = meta?.currentWeeklyId
    if (!weekId) {
      return 0
    }

    const escapedWeek = String(weekId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const docs = await coll.find({
      _id: { $regex: `^weekly:\\d+:${escapedWeek}$` }
    }).toArray()

    LEADERBOARD_SNAPSHOT_BY_ID.clear()
    const seen = new Set()
    let warmed = 0
    for (const doc of docs) {
      warmed += await warmLeaderboardEntries(doc.entries || [], seen)
    }
    if (warmed > 0) {
      console.log(`Warmed ${warmed} leaderboard bust profile(s) for week ${weekId}`)
    }
    return warmed
  } catch (err) {
    console.error('warmLeaderboardBustCache failed:', err.message)
    return 0
  }
}

function isLeaderboardBustPullRequest(body, ses, includeAvatarExplicit, includeBio) {
  const profileFairyIdFromBody = extractFairyIdFromBody(body)
  return Boolean(
    includeAvatarExplicit &&
    !includeBio &&
    ses?.logged &&
    profileFairyIdFromBody > 0
  )
}

function buildAvatarXmlEl(avatarForResponse, gender) {
  const avatarEl = {}

  const proportions = []
  if (avatarForResponse.proportions) {
    for (const [type, value] of Object.entries(avatarForResponse.proportions)) {
      if (value != null) {
        proportions.push({
          '@type': type.toUpperCase(),
          '#': value
        })
      }
    }
  }
  if (proportions.length > 0) {
    avatarEl.proportion = proportions
  }

  const rotations = []
  if (avatarForResponse.rotations) {
    for (const [type, value] of Object.entries(avatarForResponse.rotations)) {
      if (value != null) {
        rotations.push({
          '@type': type.toUpperCase(),
          '#': value
        })
      }
    }
  }
  if (rotations.length > 0) {
    avatarEl.rotation = rotations
  }

  for (const field of [
    'hair_back', 'hair_front', 'face', 'eye', 'wing',
    'hair_color', 'eye_color', 'skin_color', 'wing_color'
  ]) {
    if (avatarForResponse[field] != null) {
      avatarEl[field] = avatarForResponse[field]
    }
  }

  avatarEl.gender = gender
  return avatarEl
}

function buildLeaderboardBustProfileXml(fairy) {
  const avatarForResponse = profileAvatarSource(fairy, true)
  const [tutorialLo, tutorialHi] = profileTutorialBitmask(fairy)
  const fairyEl = {
    '@fairy_id': fairy._id,
    '#': {
      address: fairy.address || '',
      more_options: fairy.moreOptions || 'AAAAAAAAAAAAAAAAAAAAAAAA',
      badge_count: 0,
      total_badges: 0,
      newest_badge: 0,
      recent_badge: 0,
      fav_badge: 0,
      favorite_badge: 0,
      tutorial: tutorialLo,
      tutorial_hi: tutorialHi,
      created: profileCreatedDate(fairy),
      name: fairy.name,
      talent: fairy.talent,
      gender: fairy.gender,
      chosen: fairy.chosen,
      icon: fairy.icon,
      game_prof_bg: fairy.game_prof_bg,
      options_mask: fairy.optionsBitmask,
      level: fairy.level,
      member_days: NON_MEMBER_DAYS,
      user_id: fairy.accountId
    }
  }

  if (avatarForResponse) {
    fairyEl.avatar = buildAvatarXmlEl(avatarForResponse, fairy.gender)
  }

  return createXML({
    response: {
      success: true,
      status: 'logged_in_fairy',
      fairies: [{ fairy: fairyEl }]
    }
  })
}

async function respondLeaderboardBustProfile(res, fairyId) {
  const cacheKey = String(fairyId)
  let xml = LEADERBOARD_BUST_XML_CACHE.get(cacheKey)
  if (xml) {
    console.log(`[lbBust] fairyId=${fairyId} cacheHit=true`)
    return res.send(xml)
  }

  let fairy = await loadLeaderboardSnapshotFairy(fairyId)
  let source = 'snapshot'
  if (!fairy) {
    fairy = await db.retrieveFairy(fairyId)
    source = fairy ? 'mongo' : 'missing'
  }
  if (!fairy) {
    fairy = minimalLeaderboardBustFairy(fairyId)
    source = 'minimal'
  }
  if (!profileAvatarSource(fairy, true)) {
    fairy.avatar = MINIMAL_PROFILE_AVATAR
    source += '+minimalAvatar'
  }

  xml = buildLeaderboardBustProfileXml(fairy)
  cacheLeaderboardBustXml(fairyId, xml)
  console.log(`[lbBust] fairyId=${fairyId} cacheHit=false source=${source}`)
  return res.send(xml)
}

function dedupeFriendsPreserveOrder(friends) {
  if (!Array.isArray(friends)) {
    return friends
  }

  const seen = new Set()
  const normalized = []

  for (const raw of friends) {
    const id = Number(raw)
    if (!Number.isFinite(id) || id <= 0) {
      continue
    }
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    normalized.push(id)
  }

  return normalized
}

async function sanitizeFriendsForWrite(friends, fairy) {
  if (!Array.isArray(friends)) {
    return friends
  }

  const playToken = fairy.ownerAccount
  const fairyId = Number(fairy._id)
  const accountId = Number(fairy.accountId || 0)
  let normalized = dedupeFriendsPreserveOrder(friends)

  if (normalized.length !== friends.length) {
    console.warn(
      `setFairyData: deduped friends[] for playToken=${playToken} (${friends.length} -> ${normalized.length})`
    )
  }

  normalized = normalized.filter((id) => {
    if (id === fairyId) {
      console.warn(
        `setFairyData: removed fairy _id=${fairyId} from friends[] for playToken=${playToken} (expected accountId)`
      )
      return false
    }
    if (accountId && id === accountId) {
      return false
    }
    return true
  })

  if (!normalized.length) {
    return normalized
  }

  const Fairy = require('../db/models/Fairy')
  const avatarDocs = await Fairy.find(
    { _id: { $in: normalized } },
    { _id: 1, accountId: 1 }
  ).lean()

  if (!avatarDocs.length) {
    return normalized
  }

  const avatarIdToAccountId = new Map(
    avatarDocs
      .filter((doc) => Number(doc.accountId) > 0 && Number(doc._id) !== Number(doc.accountId))
      .map((doc) => [Number(doc._id), Number(doc.accountId)])
  )

  if (!avatarIdToAccountId.size) {
    return normalized
  }

  const remapped = []
  const seen = new Set()
  for (const id of normalized) {
    let resolved = id
    if (avatarIdToAccountId.has(id)) {
      resolved = avatarIdToAccountId.get(id)
      console.warn(
        `setFairyData: friends[] contained avatar _id=${id} for playToken=${playToken}; remapped to accountId=${resolved}`
      )
    }
    if (seen.has(resolved)) {
      continue
    }
    seen.add(resolved)
    remapped.push(resolved)
  }

  return remapped
}

app.get('/', (req, res) => {
  res.send('Pixie Hollow API service.')
})

function parseFairyNames () {
  const xml = fs.readFileSync('assets/nameGenerator.xml', 'utf-8')
  const parser = new XMLParser({ ignoreAttributes: false })

  const names = parser.parse(xml).NameGenerator.NameSelector

  const namesList = {}

  for (const ns of names) {
    const type = ns['@_type']
    namesList[type] = []

    for (const name of ns.name) {
      namesList[type].push(name['#text'])
    }
  }

  return namesList
}

const fairyNames = parseFairyNames()

function parseMinigameIds () {
  const xml = fs.readFileSync('assets/minigames.xml', 'utf-8')
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '')
  const ids = [...withoutComments.matchAll(/id="(\d+)"/g)].map((match) => match[1])
  return [...new Set(ids)]
}

const minigameIds = parseMinigameIds()

function validateFairyName (name) {
  const nameParts = name.trim().split(/\s+/)
  if (nameParts.length > 2) return false

  const [firstName, lastName] = nameParts

  function validateLastName(lastName) {
    for (const prefix of fairyNames['Prefix']) {
      if (lastName.startsWith(prefix)) {
        const suffix = lastName.slice(prefix.length)
        if (fairyNames['Suffix'].includes(suffix)) {
          return true
        }
      }
    }

    return false
  }

  if (nameParts.length === 1) {
    return fairyNames['First'].includes(firstName) || validateLastName(firstName)
  }

  return fairyNames['First'].includes(firstName) && validateLastName(lastName)
}

function verifyAuthorization (token) {
  return token === process.env.API_TOKEN
}

function buildGameStatEntries (gameStats) {
  let statsById = gameStats
  if (!statsById || typeof statsById !== 'object') {
    statsById = {}
  } else if (typeof statsById.toObject === 'function') {
    statsById = statsById.toObject()
  }

  const entries = []

  for (const gameId of minigameIds) {
    const entry = statsById[gameId] || statsById[String(gameId)] || {}
    const timesPlayed = Number(entry?.timesPlayed || 0)
    const bestScore = Number(entry?.bestScore || 0)

    if (timesPlayed <= 0 && bestScore <= 0) {
      continue
    }

    entries.push({
      '#': {
        stat_id: gameId,
        count: timesPlayed,
        best: bestScore,
        total: timesPlayed,
        bonus: 0,
        won: 0
      }
    })
  }

  return entries
}

function buildBadgeInvEntries (earnedBadges) {
  if (!Array.isArray(earnedBadges)) {
    return []
  }

  return earnedBadges
    .filter((entry) => entry && entry.badgeId != null)
    .map((entry, index) => ({
      item_id: Number(entry.badgeId),
      inv_id: Number(entry.badgeId),
      slot: index
    }))
}

function resolveBadgeCount (fairy, earnedBadges) {
  const earnedCount = earnedBadges.length
  const storedCount = Number(fairy.badgeCount || 0)
  return Math.max(storedCount, earnedCount)
}

function resolveRequestField (body, fieldName) {
  const roots = [
    body,
    body?.fairiesprofilerequest,
    body?.FairiesProfileRequest,
    body?.fairiesinventoryrequest,
    body?.FairiesInventoryRequest
  ].filter(Boolean)

  for (const root of roots) {
    const value = unwrapXmlField(root[fieldName])
    if (value) {
      return value
    }
  }

  return unwrapXmlField(body?.[fieldName])
}

function unwrapXmlField (value) {
  if (value === undefined || value === null) {
    return ''
  }
  if (typeof value === 'object' && value._ !== undefined) {
    return unwrapXmlField(value._)
  }
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw === 'object' && raw !== null) {
    if (raw._ !== undefined) {
      return unwrapXmlField(raw._)
    }
    return ''
  }
  return String(raw)
}

function resolveInventoryRequestType (body) {
  const roots = [
    body,
    body?.fairiesinventoryrequest,
    body?.FairiesInventoryRequest
  ].filter(Boolean)

  for (const root of roots) {
    const type = unwrapXmlField(root.type)
    if (type) {
      return type.toLowerCase()
    }
  }

  return 'wardrobe'
}

async function resolveInventoryFairyId (body, ses) {
  let fairyId = extractFairyIdFromBody(body)

  if (fairyId <= 0) {
    fairyId = Number(ses?.fairyId || 0)
  }

  if (fairyId <= 0 && ses?.username) {
    const fairy = await db.retrieveFairyByOwnerAccount(ses.username)
    if (fairy) {
      fairyId = fairy._id
    }
  }

  if (fairyId <= 0 && ses?.userId) {
    const fairy = await db.retrieveFairyByAccountId(ses.userId)
    if (fairy) {
      fairyId = fairy._id
    }
  }

  return fairyId > 0 ? fairyId : null
}

async function resolveProfileFairyId (body, ses, options = {}) {
  const touchSession = options.touchSession !== false
  let fairyId = extractFairyIdFromBody(body)

  const userIdRaw = resolveRequestField(body, 'user_id')
  const userId = userIdRaw ? parseInt(userIdRaw, 10) : null
  if (userId !== null && Number.isFinite(userId)) {
    const account = await db.retrieveAccountFromIdentifier(userId)
    if (account?.playerId) {
      fairyId = account.playerId
    }
  }

  const current = resolveRequestField(body, 'current')
  if (current === '1') {
    if (touchSession) {
      ses.viewProfileFairyId = null
    }
    return Number(ses?.fairyId || 0) || null
  }

  if (fairyId > 0) {
    if (touchSession) {
      const ownFairyId = Number(ses?.fairyId || 0)
      if (ownFairyId > 0 && Number(fairyId) !== ownFairyId) {
        ses.viewProfileFairyId = fairyId
      } else {
        ses.viewProfileFairyId = null
      }
    }
    return fairyId
  }

  return Number(ses?.fairyId || 0) || null
}

function generateRandomNumber () {
  return Math.floor(Math.random() * 101)
}

async function generateToken (username) {
  const accData = await db.retrieveAccountData(username)

  const data = {
    playToken: username,
    SpeedChatPlus: accData.SpeedChatPlus,
    OpenChat: accData.OpenChat,
    Member: accData.Member,
    Timestamp: Math.floor(new Date().getTime() / 1000) + 10 * 60,
    dislId: accData.dislId,
    accountType: accData.accountType,
    LinkedToParent: accData.LinkedToParent,
    token: '',
    Banned: accData.Banned,
    Terminated: accData.Terminated
  }

  const key = CryptoJS.enc.Hex.parse(process.env.TOKEN_KEY)
  const iv = CryptoJS.lib.WordArray.random(16) // Generate random IV (16 bytes)

  const encrypted = CryptoJS.AES.encrypt(JSON.stringify(data), key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  })

  const ivBase64 = CryptoJS.enc.Base64.stringify(iv)
  const encryptedBase64 = encrypted.toString()

  return btoa(JSON.stringify({
    iv: ivBase64,
    data: encryptedBase64
  }))
}

async function handleWhoAmIRequest (req, res) {
  const ses = req.session

  let success = false
  let status = 'not_logged_in'
  let accountId = -1
  let userName = ''
  let speedChatPrompt = 'false'
  let memberDays = NON_MEMBER_DAYS

  if (ses.success || req.query.isFirst === undefined) {
    success = true
  }

  if (ses.logged && ses.username && ses.userId) {
    status = 'logged_in_fairy'

    accountId = ses.userId
    userName = ses.username

    const membership = await db.resolveMembershipContext(userName, ses)
    memberDays = membership.memberDays
    speedChatPrompt = `${Boolean(!membership.accData.SpeedChatPlus)}`
  }

  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    WhoAmIResponse: {
      success: success,
      status: status,
      username: userName,
      member_days: memberDays,
      account: {
        '@account_id': accountId,
        '#': {
          first_name: '',
          dname: userName,
          age: 0,
          isChild: true,
          access: 'basic',
          touAccepted: true,
          speed_chat_prompt: speedChatPrompt,
          dname_submitted: true,
          dname_approved: true,
          member_days: memberDays
        }
      },
      userTestAccessAllowed: false,
      'server-time': getPacificServerTime(),
      fairy_id: ses.fairyId
    }
  }))
}

app.get('/fairies/api/AccountLogoutRequest', async (req, res) => {
  req.session.destroy()

  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    AccountLogoutResponse: {
      success: true
    }
  }))
})

app.get('/fairies/api/WhoAmIRequest', async (req, res) => {
  await handleWhoAmIRequest(req, res)
})

app.post('/fairies/api/WhoAmIRequest', async (req, res) => {
  await handleWhoAmIRequest(req, res)
})

app.get('/dxd/flashAPI/login', async (req, res) => {
  await db.handleFlashLogin(req, res)
})

app.post('/dxd/flashAPI/login', async (req, res) => {
  await db.handleFlashLogin(req, res)
})

app.post('/dxd/flashAPI/checkUsernameAvailability', async (req, res) => {
  const username = req.body.username.toLowerCase()
  let status

  if (process.env.LOCALHOST_INSTANCE === 'true') {
    status = await db.isUsernameAvailable(username)
  } else {
    // TODO: Integrate registration into Sunrise database and re-enable in-game registrations for production
    status = false
  }

  const responseData = {
    success: status
  }

  if (!status) {
    // Specified username is taken, give some suggestions to choose from.
    const words = [
      'Amazing',
      'Cool',
      'Super',
      'Fantastic'
    ]

    const randomIndex = Math.floor(Math.random() * words.length)

    responseData.results = {
      suggestedUsername1: `${username}${generateRandomNumber()}`,
      suggestedUsername2: `${username}${generateRandomNumber()}`,
      suggestedUsername3: `${words[randomIndex]}${username}`
    }
  }

  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    response: responseData
  }))
})

app.post('/dxd/flashAPI/createAccount', async (req, res) => {
  const username = req.body.username.toLowerCase()
  const status = await db.createAccount(username, req.body.password)
  const accountId = status ? await db.getAccountIdFromUser(username) : -1

  // Start our session if we do not already have one.
  // TODO: Should we redirect instead if they are already signed in?
  if (!req.session.logged) {
    await db.createSession(req, username, accountId, true)
  }

  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    response: {
      success: !!status,
      results: {
        userId: accountId
      }
    }
  }))
})

app.post('/fairies/api/AccountLoginRequest', async (req, res) => {
  await db.handleAccountLogin(req, res)
})

app.get('/fairies/api/AccountLoginRequest', async (req, res) => {
  await db.handleAccountLogin(req, res)
})

app.get('/fairies/api/GameEntranceRequest', (req, res) => {
  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    GameEntranceRequestResponse: {
      success: true,
      queue: {
        can_enter_game: loginQueue.length > 0 ? 'false' : 'true'
      }
    }
  }))
})

app.get('/fairies/api/QueueStatsRequest', (req, res) => {
  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    QueueStatsRequestResponse: {
      queue: {
        est_queue_before_you: 0
      }
    }
  }))
})

app.post('/fairies/api/GenerateTokenRequest', async (req, res) => {
  const ses = req.session

  const success = ses ? 'true' : 'false'

  const responseData = {
    success
  }

  if (ses.username) {
    responseData.token = process.env.LOCALHOST_INSTANCE === 'true' ? ses.username : await generateToken(ses.username)
  }

  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    GenerateTokenRequestResponse: responseData
  }))
})

app.use(express.json())

app.post('/fairies/api/internal/warmLeaderboardBustCache', async (req, res) => {
  if (!verifyAuthorization(req.headers.authorization)) {
    return res.status(401).send('Authorization failed.')
  }
  const fairyIds = Array.isArray(req.body?.fairyIds) ? req.body.fairyIds : null
  const warmed = await warmLeaderboardBustCache({ fairyIds })
  return res.status(200).send({ success: true, warmed })
})

app.post('/fairies/api/internal/setFairyData', async (req, res) => {
  if (!verifyAuthorization(req.headers.authorization)) {
    return res.status(401).send('Authorization failed.')
  }

  const data = req.body

  if (data.playToken && data.fieldData) {
    const fairy = await db.retrieveFairyByOwnerAccount(data.playToken)
    if (!fairy) {
      console.log(`setFairyData: no fairy for playToken=${data.playToken}`)
      return res.status(404).send({ success: false, message: 'Fairy not found.' })
    }
    console.log(
      `setFairyData: playToken=${data.playToken} fairyId=${fairy._id} fields=${JSON.stringify(Object.keys(data.fieldData))}`
    )
    if (Object.prototype.hasOwnProperty.call(data.fieldData, 'friends')) {
      data.fieldData.friends = await sanitizeFriendsForWrite(data.fieldData.friends, fairy)
    }
    Object.assign(fairy, data.fieldData)
    await fairy.save()
    return res.status(200).send({ success: true, message: 'Success.' })
  }

  return res.status(501).send({ success: false, message: 'Something went wrong.' })
})

app.get('/fairies/api/internal/retrieveAccount', async (req, res) => {
  if (!verifyAuthorization(req.headers.authorization)) {
    return res.status(401).send('Authorization failed.')
  }

  res.setHeader('content-type', 'application/json')
  if (req.query.userName) {
    let account = await db.retrieveAccountFromUser(req.query.userName)
    if (account) {
      account = account.toObject()
      delete account.password
      return res.end(JSON.stringify(
        account
      ))
    }
  }

  return res.status(404).send({ message: `Could not find account from username ${req.query.userName}` })
})

app.get('/fairies/api/internal/retrieveFairy', async (req, res) => {
  if (!verifyAuthorization(req.headers.authorization)) {
    return res.status(401).send('Authorization failed.')
  }

  res.setHeader('content-type', 'application/json')
  if (req.query.identifier) {
    const fairy = await db.retrieveFairy(req.query.identifier)
    if (!fairy) {
      return res.status(404).send({ message: `Fairy ${req.query.identifier} not found` })
    }
    return res.end(JSON.stringify(fairy.toObject()))
  }

  if (req.query.playToken) {
    const fairy = await db.retrieveFairyByOwnerAccount(req.query.playToken)
    if (!fairy) {
      return res.status(404).send({ message: `Fairy for account ${req.query.playToken} not found` })
    }
    return res.end(JSON.stringify(fairy.toObject()))
  }

  return res.status(400).send({})
})

app.get('/fairies/api/internal/retrieveObject/:identifier', async (req, res) => {
  if (!verifyAuthorization(req.headers.authorization)) {
    return res.status(401).send('Authorization failed.')
  }

  res.setHeader('content-type', 'application/json')
  if (req.params.identifier) {
    // Check for account
    let account = await db.retrieveAccountFromIdentifier(req.params.identifier)
    if (account) {
      // Convert Mongoose docs to JS objects so we can make
      // changes to it.
      account = account.toObject()
      // Don't send the account's hashed password
      delete account.password

      account.objectName = 'Account'
      return res.end(JSON.stringify(
        account
      ))
    }

    // Check for Fairy
    let fairy = await db.retrieveFairy(req.params.identifier)
    if (fairy) {
      fairy = fairy.toObject()

      if (fairy._id === Number(req.params.identifier)) {
        fairy.objectName = 'DistributedFairyPlayer'
      } else {
        fairy.objectName = 'Unknown'
      }

      return res.end(JSON.stringify(
        fairy
      ))
    }

    return res.status(404).send({ message: `Object ${req.params.identifier} not found!` })
  }
})

app.post('/fairies/api/internal/updateObject/:identifier', async (req, res) => {
  if (!verifyAuthorization(req.headers.authorization)) {
    return res.status(401).send('Authorization failed.')
  }

  const data = req.body

  let updated = false
  if (req.params.identifier) {
    // Check for account
    const account = await db.retrieveAccountFromIdentifier(req.params.identifier)
    if (account) {
      Object.assign(account, data)
      await account.save()
      updated = true
    }

    if (!updated) {
      const fairyId = Number(req.params.identifier)
      let fairy = null
      if (Number.isFinite(fairyId) && fairyId > 0) {
        fairy = await db.retrieveFairyById(fairyId)
      }
      if (!fairy) {
        fairy = await db.retrieveFairy(req.params.identifier)
      }
      if (fairy && Number(fairy._id) !== fairyId && Number.isFinite(fairyId) && fairyId > 0) {
        fairy = null
      }
      if (fairy) {
        const fairyDNAFieldMap = {
          talent: 'talent',
          head: 'avatar.proportions.head',
          height: 'avatar.proportions.height',
          body: 'avatar.proportions.body',
          hair_back: 'avatar.hair_back',
          hair_front: 'avatar.hair_front',
          face: 'avatar.face',
          eye: 'avatar.eye',
          wing: 'avatar.wing',
          hair_color: 'avatar.hair_color',
          hair_color2: 'avatar.hair_color2',
          eye_color: 'avatar.eye_color',
          skin_color: 'avatar.skin_color',
          wing_color: 'avatar.wing_color',
          gender: 'gender',
          head_rot: 'avatar.rotations.head_rot',
          ul_arm_rot: 'avatar.rotations.ul_arm_rot',
          ur_arm_rot: 'avatar.rotations.ur_arm_rot',
          ll_arm_rot: 'avatar.rotations.ll_arm_rot',
          lr_arm_rot: 'avatar.rotations.lr_arm_rot',
          ul_leg_rot: 'avatar.rotations.ul_leg_rot',
          ur_leg_rot: 'avatar.rotations.ur_leg_rot',
          ll_leg_rot: 'avatar.rotations.ll_leg_rot',
          lr_leg_rot: 'avatar.rotations.lr_leg_rot'
        }

        if (Array.isArray(data.equippedSlots) && data.equippedSlots.length > 0) {
          db.applyEquippedSlotUpdates(fairy, data.equippedSlots)
        }

        for (const [key, value] of Object.entries(data)) {
          if (key === 'equippedSlots') {
            continue
          }
          if (fairyDNAFieldMap[key]) {
            fairy.set(fairyDNAFieldMap[key], value)
          } else {
            fairy[key] = value
          }
        }

        if (typeof data.moreOptions === 'string') {
          const earnedBadges = Array.isArray(fairy.earnedBadges) ? fairy.earnedBadges : []
          const earnedBadgeIds = new Set(
            earnedBadges.map((entry) => Number(entry.badgeId))
          )
          const repaired = repairMoreOptions(
            data.moreOptions,
            Number(fairy.favoriteBadgeId || 0),
            earnedBadgeIds
          )
          fairy.moreOptions = repaired
          fairy.favoriteBadgeId = parseFavoriteBadgeFromMoreOptions(repaired)
        }

        const directFavoriteBadgeId = Number(data.favoriteBadgeId || 0)
        if (directFavoriteBadgeId > 0) {
          await persistFavoriteBadge(fairy, directFavoriteBadgeId)
        }

        await fairy.save()
        updated = true
      }
    }

    if (updated) {
      return res.send({ message: 'Updated successfully!' })
    } else {
      return res.status(404).send({ message: `Could not update ${req.params.identifier}` })
    }
  }
})

app.post('/dxd/flashAPI/getFamilyStructure', (req, res) => {
  // TODO: Implement parent accounts
  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    response: {
      success: 0
    }
  }))
})

app.post('/dxd/flashAPI/lookupAccount', async (req, res) => {
  const ses = req.session

  const success = (ses && ses.userId) ? true : false

  const responseData = {
    success
  }

  if (success) {
    const userId = ses.userId
    const account = await db.retrieveAccountFromIdentifier(userId)

    if (account) {
      responseData.acceptedTOU = true

      const accData = await db.retrieveAccountData(account.username)

      responseData.results = {
        firstName: accData.FirstName ?? '',
        lastName: accData.LastName ?? '',
        email: accData.Email ?? '',
        username: account.username,
        swid: accData.dislId ?? '',
        age: accData.Age ?? '',
        hoh: accData.Age >= 18,
        userId,
      }

      if (accData.SpeedChatPlus === 1) {
        responseData.results.canWhitelistChat = true
        responseData.results.canWhitelistChatValidationType = 0
      } else {
        responseData.results.canWhitelistChat = false
      }

      if (accData.OpenChat === 1) {
        responseData.results.chatLevel = 3 // TODO: Implement the chat types
        responseData.results.chatLevelValidationType = 0
      } else {
        responseData.results.chatLevel = 0
      }
    }
  }

  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    response: responseData
  }))
})

app.post('/commerce/flashapi/lookupOffers', async (req, res) => {
  // TODO: Implement me
  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    response: {
      success: 1,
      offers: {}
    }
  }))
})

app.post('/commerce/flashapi/lookupSubscriptions', async (req, res) => {
  // TODO: Same as above
  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    response: {
      success: 1
    }
  }))
})

app.get('/dxd/flashAPI/getTermsOfUseText', async (req, res) => {
  // TODO: Same as above
  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    response: {
      success: 1,
      results: {
        tou: ''
      }
    }
  }))
})

app.post('/fairies/api/SubmitDNameRequest', (req, res) => {
  res.send(createXML({
    SubmitDNameRequestResponse: {
      success: true
    }
  }))
})

app.post('/fairies/api/FairiesProfileRequest', async (req, res) => {
  const ses = req.session

  try {
    const loggedInFairy = false
    const includeAvatarExplicit = 'dna' in req.body
    const includeBio = 'bio' in req.body
    const profileFairyIdFromBody = extractFairyIdFromBody(req.body)
    const isLeaderboardBustPull = isLeaderboardBustPullRequest(
      req.body,
      ses,
      includeAvatarExplicit,
      includeBio
    )

    if (!ses.logged) {
      return res.send(createXML({
        response: {
          success: false,
          status: 'not_logged_in'
        }
      }))
    }

    if (isLeaderboardBustPull) {
      console.log(`[lbBust] request fairyId=${profileFairyIdFromBody}`)
      return await respondLeaderboardBustProfile(res, profileFairyIdFromBody)
    }

    const fairyId = await resolveProfileFairyId(req.body, ses, {
      touchSession: !isLeaderboardBustPull
    })
    const sessionOwnFairy = ses.logged ? await db.resolveWritableSessionFairy(req) : null
    const sessionOwnFairyId = sessionOwnFairy ? Number(sessionOwnFairy._id) : 0

    const fairyData = await db.retrieveFairy(fairyId)
    const fairiesToSend = fairyData ? [fairyData] : []

    const responseData = {
      success: true,
      status: fairyId != null ? 'logged_in_fairy' : 'logged_in',
      fairies: []
    }

    for (const fairy of fairiesToSend) {
    const earnedBadges = Array.isArray(fairy.earnedBadges) ? fairy.earnedBadges : []
    const badgeCount = resolveBadgeCount(fairy, earnedBadges)
    const newestBadge = typeof fairy.newestBadge === 'number' && fairy.newestBadge > 0
      ? fairy.newestBadge
      : (earnedBadges.length ? Number(earnedBadges[earnedBadges.length - 1].badgeId) : 0)
    const earnedBadgeIds = new Set(
      earnedBadges.map((entry) => Number(entry.badgeId))
    )
    const previousFavoriteId = Number(fairy.favoriteBadgeId || 0)
    let favoriteBadgeData = resolveFavoriteBadge(fairy)
    let profileWritePatch = null
    const isOwnFairy = sessionOwnFairyId > 0 && Number(fairy._id) === sessionOwnFairyId

    const wouldClearValidFavorite =
      favoriteBadgeData.favoriteBadgeId <= 0 &&
      previousFavoriteId > 0 &&
      earnedBadgeIds.has(previousFavoriteId)

    if (wouldClearValidFavorite) {
      favoriteBadgeData = resolveFavoriteBadgeFromValues(
        fairy.moreOptions,
        previousFavoriteId,
        earnedBadgeIds
      )
    } else if (
      isOwnFairy &&
      (
        fairy.moreOptions !== favoriteBadgeData.moreOptions ||
        Number(fairy.favoriteBadgeId || 0) !== favoriteBadgeData.favoriteBadgeId
      )
    ) {
      profileWritePatch = {
        moreOptions: favoriteBadgeData.moreOptions,
        favoriteBadgeId: favoriteBadgeData.favoriteBadgeId
      }
      fairy.moreOptions = favoriteBadgeData.moreOptions
      fairy.favoriteBadgeId = favoriteBadgeData.favoriteBadgeId
    }

    const ownerUsername = fairy.ownerAccount || await db.getUserNameFromAccountId(fairy.accountId)
    if (ownerUsername) {
      responseData.user_name = ownerUsername
    }
    const membership = ownerUsername && !isSyntheticLeaderboardOwner(ownerUsername)
      ? await db.resolveMembershipContext(
        ownerUsername,
        isLeaderboardBustPull ? null : ses
      )
      : { memberDays: NON_MEMBER_DAYS }
    const accountMemberDays = membership.memberDays
    const lastAckMemberDays = Number(fairy.lastAckMemberDays ?? NON_MEMBER_DAYS)
    const responseMemberDays = accountMemberDays

    const [tutorialLo, tutorialHi] = profileTutorialBitmask(fairy)

    const fairyEl = {
      '@fairy_id': fairy._id,
      '#': {
        address: fairy.address,
        more_options: favoriteBadgeData.moreOptions,
        badge_count: badgeCount,
        total_badges: badgeCount,
        newest_badge: newestBadge,
        recent_badge: newestBadge,
        fav_badge: favoriteBadgeData.favoriteBadgeId,
        favorite_badge: favoriteBadgeData.favoriteBadgeId,
        tutorial: tutorialLo,
        tutorial_hi: tutorialHi,
        created: profileCreatedDate(fairy),
        name: fairy.name,
        talent: fairy.talent,
        gender: fairy.gender,
        chosen: fairy.chosen,
        icon: fairy.icon,
        game_prof_bg: fairy.game_prof_bg,
        options_mask: fairy.optionsBitmask,
        level: fairy.level,
        member_days: responseMemberDays,
        user_id: fairy.accountId
      }
    }

    if (isOwnFairy && shouldAckMemberDays(accountMemberDays, lastAckMemberDays)) {
      profileWritePatch = profileWritePatch || {}
      profileWritePatch.lastAckMemberDays = accountMemberDays
      fairy.lastAckMemberDays = accountMemberDays
    }

    if (profileWritePatch && sessionOwnFairy) {
      await db.updateOwnedFairyFields(sessionOwnFairy, ses, profileWritePatch)
    }

    if (loggedInFairy) {
      fairyEl.logged_in_fairy = true
    }

    if (includeBio) {
      const bio_questions = []

      for (const bio_question of fairy.bio) {
        bio_questions.push(bio_question)
      }

      fairyEl['#'].bio = [{
        question: bio_questions
      }]
    }

    const includeAvatar = includeAvatarExplicit || Boolean(fairy.avatar)
    const avatarForResponse = profileAvatarSource(fairy, includeAvatarExplicit)

    if (includeAvatar && avatarForResponse) {
      const avatarEl = {}

      const proportions = []
      if (avatarForResponse.proportions) {
        for (const [type, value] of Object.entries(avatarForResponse.proportions)) {
          if (value != null) {
            proportions.push({
              '@type': type.toUpperCase(),
              '#': value
            })
          }
        }
      }
      if (proportions.length > 0) {
        avatarEl.proportion = proportions
      }

      const rotations = []
      if (avatarForResponse.rotations) {
        for (const [type, value] of Object.entries(avatarForResponse.rotations)) {
          if (value != null) {
            rotations.push({
              '@type': type.toUpperCase(),
              '#': value
            })
          }
        }
      }
      if (rotations.length > 0) {
        avatarEl.rotation = rotations
      }

      const simpleFields = [
        'hair_back', 'hair_front', 'face', 'eye', 'wing',
        'hair_color', 'eye_color', 'skin_color', 'wing_color'
      ]
      for (const field of simpleFields) {
        if (avatarForResponse[field] != null) {
          avatarEl[field] = avatarForResponse[field]
        }
      }

      avatarEl.gender = fairy.gender

      if (avatarForResponse.items) {
        avatarEl.inv_item = []

        for (const item of avatarForResponse.items) {
          if (item.location !== "Equipped") {
            continue;
          }

          const colors = []

          if (typeof item.color1 === 'number' && item.color1 !== 0) {
            colors.push({
              '@number': 1,
              '#': item.color1
            })
          }

          if (typeof item.color2 === 'number' && item.color2 !== 0) {
            colors.push({
              '@number': 2,
              '#': item.color2
            })
          }

          avatarEl.inv_item.push({
            '@type': item.type,
            '#': {
              item_id: item.item_id,
              color: colors
            }
          })
        }
      }

      fairyEl.avatar = avatarEl
    }

    responseData.fairies.push({ fairy: fairyEl })
    }

    return res.send(createXML({
      response: responseData
    }))
  } catch (err) {
    console.error('FairiesProfileRequest failed:', err)
    return res.send(createXML({
      response: {
        success: false,
        status: ses?.logged ? 'logged_in' : 'not_logged_in'
      }
    }))
  }
})

app.post('/fairies/api/FairiesNewFairyRequest', async (req, res) => {
  const ses = req.session
  let success = true

  const fairyData = req.body.fairiesnewfairyrequest?.fairy[0]

  if (!ses.logged || !validateFairyName(fairyData.name[0])) {
    success = false
    return res.send(createXML({
      response: {
        success
      }
    }))
  }

  // TODO: Why is this happening
  if (ses.userId == -1) {
    success = false
    return res.send(createXML({
      response: {
        success
      }
    }))
  }

  // TODO: Support multiple fairies for Pixie Hollow Rewritten
  const existing = await db.retrieveFairyByOwnerAccount(ses.username)

  if (existing) {
    success = false
    return res.send(createXML({
      response: {
        success
      }
    }))
  }

  const fairyId = ses ? await db.createFairy(ses.userId, fairyData) : -1
  ses.fairyId = fairyId

  res.send(createXML({
    response: {
      success,
      fairy_id: fairyId
    }
  }))
})

app.post('/fairies/api/ChooseFairyRequest', (req, res) => {
  res.send(createXML({
    response: {
      success: true
    }
  }))
})

app.post('/fairies/api/FairiesInventoryRequest', async (req, res) => {
  const ses = req.session
  const requestType = resolveInventoryRequestType(req.body)

  if (requestType === 'games') {
    const fairyId = await resolveInventoryFairyId(req.body, ses)
    const fairy = fairyId ? await db.retrieveFairy(fairyId) : null
    const stat = buildGameStatEntries(fairy?.gameStats)
    const inventory = { type: 'games' }

    if (stat.length) {
      inventory.stat = stat
    }

    return res.send(createXML({
      response: {
        success: true,
        inventory
      }
    }))
  }

  if (requestType === 'stats' && ses?.logged) {
    const fairyId = await resolveInventoryFairyId(req.body, ses)
    const fairy = fairyId ? await db.retrieveFairy(fairyId) : null
    const stat = buildGameStatEntries(fairy?.gameStats)
    const inventory = { type: 'stats' }

    if (stat.length) {
      inventory.stat = stat
    }

    return res.send(createXML({
      response: {
        success: true,
        inventory
      }
    }))
  }

  if (requestType === 'badges') {
    const fairyId = await resolveInventoryFairyId(req.body, ses)
    const fairy = fairyId ? await db.retrieveFairy(fairyId) : null
    const earnedBadges = Array.isArray(fairy?.earnedBadges) ? fairy.earnedBadges : []
    const invItem = buildBadgeInvEntries(earnedBadges)
    const inventory = { type: 'badges' }

    if (invItem.length) {
      inventory.inv_item = invItem
    }

    return res.send(createXML({
      response: {
        success: true,
        inventory
      }
    }))
  }

  const items = [
    { item_id: 2501, inv_id: 3612, slot: 0, created_by_id: 0, gifted_by_id: 0, quality: 3, color: { number: 1, value: 37 } },
    { item_id: 2503, inv_id: 3876, slot: 1, created_by_id: 0, gifted_by_id: 0, quality: 3, color: { number: 1, value: 39 } },
    { item_id: 2503, inv_id: 3877, slot: 2, created_by_id: 0, gifted_by_id: 0, quality: 3, color: { number: 1, value: 39 } }
  ]

  const item_list = items.map(i => ({
    item_id: i.item_id,
    inv_id: i.inv_id,
    slot: i.slot,
    created_by_id: i.created_by_id,
    gifted_by_id: i.gifted_by_id,
    quality: i.quality,
    color: {
      '@number': i.color.number,
      '#': i.color.value
    },
  }))

  return res.send(createXML({
    response: {
      success: true,
      inventory: {
        type: 'wardrobe',
        inv_item: item_list
      }
    }
  }))
})

app.post('/fairies/api/CouponRedemptionRequest', async (req, res) => {
  const code = req.body.couponredemptionrequest?.code[0]
  const ses = req.session
  let success = false

  if (!ses.logged) {
    return res.send(createXML({
      response: {
        success,
        error: { '@code': 'USER_NOT_LOGGED_IN' }
      }
    }))
  }

  const codeData = await db.getRedeemableCode(code)
  if (!codeData) {
    return res.send(createXML({
      response: {
        success,
        error: { '@code': 'ERROR_INVALID_PARMS' }
      }
    }))
  }

  const isRedeemed = await db.checkCodeRedeemedByUser(ses.username, code)
  if (isRedeemed) {
    return res.send(createXML({
      response: {
        success,
        error: { '@code': 'AT_MAX_USES' }
      }
    }))
  }

  success = true
  // TODO: Save rewards
  await db.setCodeAsRedeemedByUser(ses.username, code)

  res.send(createXML({
    response: {
      success,
      item_id: codeData.rewardId,
      count: codeData.quantity
    }
  }))
})

app.post('/fairies/api/FairiesEditBioRequest', async (req, res) => {
    const questions = req.body.fairieseditbiorequest?.bio?.[0]?.question
    const success = true

    if (!questions || questions.length != 6) {
      return res.send(createXML({
        response: {
          success: !success
        }
      }))
    }

    const fairy = await resolveOwnedSessionFairyForWrite(req, res)
    if (!fairy) {
      return
    }

    const bio = questions.map((question, i) => ({
      id: i + 1,
      answer: parseInt(question.answer[0], 10)
    }))

    const saved = await db.updateOwnedFairyFields(fairy, req.session, { bio })
    if (!saved) {
      return sendProfileWriteFailure(res)
    }

    res.send(createXML({
      response: {
        success
      }
    }))
})

app.post('/fairies/api/FairiesEditIconRequest', async (req, res) => {
    const iconId = parseInt(req.body.icon_id, 10)
    const bgId = req.body.game_prof_bg
    const success = true

    if (!Number.isFinite(iconId) || iconId <= 0) {
      return res.send(createXML({
        response: {
          success: !success
        }
      }))
    }

    const fairy = await resolveOwnedSessionFairyForWrite(req, res)
    if (!fairy) {
      return
    }

    const saved = await db.updateOwnedFairyFields(fairy, req.session, {
      icon: iconId,
      game_prof_bg: bgId
    })
    if (!saved) {
      return sendProfileWriteFailure(res)
    }

    res.send(createXML({
      response: {
        success
      }
    }))
})

async function resolveSessionFairy (req) {
  return db.resolveWritableSessionFairy(req)
}

function sendProfileWriteFailure (res) {
  return res.send(createXML({
    response: {
      success: false
    }
  }))
}

async function resolveOwnedSessionFairyForWrite (req, res) {
  const bodyFairyId = extractFairyIdFromBody(req.body)
  const fairy = await resolveSessionFairy(req)
  if (!fairy) {
    sendProfileWriteFailure(res)
    return null
  }

  if (bodyFairyId > 0 && Number(bodyFairyId) !== Number(fairy._id)) {
    sendProfileWriteFailure(res)
    return null
  }

  return fairy
}

async function handleFavoriteBadgeRequest (req, res) {
  const favoriteRequest = resolveFavoriteFromRequest(req.body)
  const badgeId = favoriteRequest.badgeId

  const fairy = await resolveOwnedSessionFairyForWrite(req, res)
  if (!fairy) {
    return
  }

  if (badgeId <= 0) {
    return res.send(createXML({
      response: {
        success: false
      }
    }))
  }

  const earnedBadges = Array.isArray(fairy.earnedBadges) ? fairy.earnedBadges : []
  const earnedBadgeIds = new Set(
    earnedBadges.map((entry) => Number(entry.badgeId))
  )
  if (!earnedBadgeIds.has(badgeId)) {
    return res.send(createXML({
      response: {
        success: false
      }
    }))
  }

  let moreOptions = fairy.moreOptions
  if (favoriteRequest.moreOptions) {
    moreOptions = repairMoreOptions(
      favoriteRequest.moreOptions,
      badgeId,
      earnedBadgeIds
    )
  } else {
    moreOptions = setFavoriteInMoreOptions(fairy.moreOptions, badgeId)
  }

  const resolvedFavoriteId = parseFavoriteBadgeFromMoreOptions(moreOptions)
  const favoriteToStore = resolvedFavoriteId > 0 ? resolvedFavoriteId : badgeId
  const saved = await db.updateFavoriteBadgeForSessionOwner(
    fairy,
    req.session,
    favoriteToStore,
    moreOptions
  )

  if (!saved) {
    return res.send(createXML({
      response: {
        success: false
      }
    }))
  }

  return res.send(createXML({
    response: {
      success: true
    }
  }))
}

app.post('/fairies/api/UpdateFavoriteBadgeRequest', (req, res) => {
  return handleFavoriteBadgeRequest(req, res)
})

setTimeout(() => {
  warmLeaderboardBustCache()
}, 3000)
setInterval(() => {
  warmLeaderboardBustCache()
}, 5 * 60 * 1000)

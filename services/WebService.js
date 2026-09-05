/* global app:writable */
/* global db:writeable */
/* global md:writeable */

app = global.app

const createXML = require('../utils/xml')

const express = require('express')

const CryptoJS = require('crypto-js')

const fs = require('fs')
const { XMLParser } = require('fast-xml-parser')

const { normalizeFairyName } = require('../utils/name')

const loginQueue = []

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

function validateFairyName (name) {
  const nameParts = normalizeFairyName(name).split(' ')
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

  if (ses.success || req.query.isFirst === undefined) {
    success = true
  }

  if (ses.logged && ses.username && ses.userId) {
    status = 'logged_in_fairy'

    accountId = ses.userId
    userName = ses.username

    const accData = await db.retrieveAccountData(userName)
    speedChatPrompt = `${Boolean(!accData.SpeedChatPlus)}`
  }

  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    WhoAmIResponse: {
      success: success,
      status: status,
      username: userName,
      account: {
        '@account_id': accountId,
        '#': {
          first_name: '',
          dname: userName,
          age: 0,
          isChild: true,
          access: 'basic',
          touAccepted: true,
          speed_chat_prompt: 'true', // speedChatPrompt
          dname_submitted: true,
          dname_approved: true
        }
      },
      userTestAccessAllowed: false,
      'server-time': {
        day: new Date().toLocaleDateString('en-ZA', { timeZone: 'America/Los_Angeles' }),
        time: new Date().toLocaleTimeString('en-ZA', { timeZone: 'America/Los_Angeles' })
      },
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
    // TODO: register against the Sunrise database and re-enable in-game signup
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
  // Registration is disabled for now.
  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    response: {
      success: false,
      results: {
        userId: -1
      }
    }
  }))

  return

  const username = req.body.username.toLowerCase()
  const status = await db.createAccount(username, req.body.password)
  const accountId = status ? await db.getAccountIdFromUser(username) : -1

  // TODO: redirect instead when they are already signed in?
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

app.post('/fairies/api/internal/setFairyData', async (req, res) => {
  if (!verifyAuthorization(req.headers.authorization)) {
    return res.status(401).send('Authorization failed.')
  }

  const data = req.body

  if (!data.fieldData) {
    return res.status(400).send({ success: false, message: 'Missing fieldData.' })
  }

  let fairy

  if (data.fairyId !== undefined && data.fairyId !== null) {
    // Preferred: _id stays unique once an account can own several fairies.
    fairy = await db.retrieveFairyById(data.fairyId)

    if (!fairy) {
      return res.status(404).send({ success: false, message: `Fairy ${data.fairyId} not found.` })
    }
  } else if (data.playToken) {
    // Legacy: only unambiguous while an account owns exactly one fairy.
    const fairies = await db.retrieveFairiesByOwnerAccount(data.playToken)

    if (fairies.length === 0) {
      return res.status(404).send({ success: false, message: `No fairy found for playToken ${data.playToken}.` })
    }

    if (fairies.length > 1) {
      return res.status(409).send({
        success: false,
        message: `playToken ${data.playToken} owns ${fairies.length} fairies; address this write by fairyId.`
      })
    }

    fairy = fairies[0]
  } else {
    return res.status(400).send({ success: false, message: 'Missing fairyId (or playToken).' })
  }

  // An empty Lua table arrives as `{}`; Mongoose would drop the write.
  if (data.fieldData.friends !== undefined && !Array.isArray(data.fieldData.friends)) {
    data.fieldData.friends = Object.values(data.fieldData.friends)
  }

  Object.assign(fairy, data.fieldData)
  await fairy.save()

  return res.status(200).send({ success: true, message: 'Success.' })
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

// Bulk retrieveFairy: one request per friends panel; POST for URL length.
app.post('/fairies/api/internal/retrieveFairies', async (req, res) => {
  if (!verifyAuthorization(req.headers.authorization)) {
    return res.status(401).send('Authorization failed.')
  }

  const identifiers = req.body?.identifiers

  if (!Array.isArray(identifiers)) {
    return res.status(400).send({ success: false, message: 'Missing identifiers array.' })
  }

  res.setHeader('content-type', 'application/json')

  const wanted = identifiers.map(Number).filter(id => !Number.isNaN(id))

  if (wanted.length === 0) {
    return res.end(JSON.stringify({}))
  }

  const fairies = await db.retrieveFairySummaries(wanted)
  const requested = new Set(wanted)
  const byIdentifier = {}

  for (const fairy of fairies) {
    const summary = {
      _id: fairy._id,
      accountId: fairy.accountId,
      name: fairy.name,
      ownerAccount: fairy.ownerAccount
    }

    if (requested.has(fairy._id)) {
      byIdentifier[fairy._id] = summary
    }

    if (requested.has(fairy.accountId)) {
      byIdentifier[fairy.accountId] = summary
    }
  }

  return res.end(JSON.stringify(byIdentifier))
})

app.get('/fairies/api/internal/retrieveFairy', async (req, res) => {
  if (!verifyAuthorization(req.headers.authorization)) {
    return res.status(401).send('Authorization failed.')
  }

  res.setHeader('content-type', 'application/json')
  if (req.query.identifier) {
    res.end(JSON.stringify(
      await db.retrieveFairy(req.query.identifier))
    )
    return
  }

  if (req.query.playToken) {
    res.end(JSON.stringify(
      await db.retrieveFairyByOwnerAccount(req.query.playToken))
    )
    return
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

/**
 * Pin bio to the { id, answer } records the Flash-facing routes read.
 *
 * setBio is a `db` field, so an update through the state server write-throughs
 * to APIDatabase.lua, whose Lua unpacker reads BioAnswer members positionally.
 * Without this a round-trip can rewrite bio into a shape the profile can't read.
 */
function normaliseBio (value) {
  if (!Array.isArray(value)) {
    return value
  }

  return value.map((answer, i) => {
    if (Array.isArray(answer)) {
      // BioAnswer { int16 questionId; int16 answerId; }
      return { id: answer[0], answer: answer[1] }
    }

    if (answer && typeof answer === 'object') {
      return {
        id: answer.id ?? answer.questionId ?? i + 1,
        answer: answer.answer ?? answer.answerId ?? 0
      }
    }

    return answer
  })
}

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
      const fairy = await db.retrieveFairy(req.params.identifier)
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

        for (const [key, value] of Object.entries(data)) {
          if (fairyDNAFieldMap[key]) {
            fairy.set(fairyDNAFieldMap[key], value)
          } else if (key === 'name') {
            fairy.name = normalizeFairyName(value)
          } else if (key === 'bio') {
            fairy.bio = normaliseBio(value)
          } else {
            fairy[key] = value
          }
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
  // One character per account, matching Disney's rules from Nov 10, 2011 on.
  const ses = req.session

  const loggedInFairy = false
  const includeAvatar = 'dna' in req.body
  const includeBio = 'bio' in req.body

  let fairyId = req.body.fairy_id ?? null
  const userId = req.body.user_id ?? null

  if (fairyId !== null) {
    fairyId = parseInt(fairyId)
  } else {
    fairyId = ses?.fairyId ?? null
  }

  if (userId !== null) {
    // Grab the fairyId from the account instead.
    const account = await db.retrieveAccountFromIdentifier(userId)
    fairyId = account.playerId
  }

  // Projected: a bust render needs none of the badge rows or the wardrobe.
  const fairyData = await db.retrieveFairyProfile(fairyId, { includeAvatar, includeBio })
  const fairiesToSend = fairyData ? [fairyData] : []

  const success = ses.logged ? true : false
  const status = !success ? 'not_logged_in' : (fairyId != null ? 'logged_in_fairy' : 'logged_in')

  const responseData = {
    success,
    status
  }

  if (!success) {
    return res.send(createXML({
      response: responseData
    }))
  }

  // LimitedProfile reads the account name from here for fairies we can't see.
  if (fairyData) {
    responseData.user_name = fairyData.ownerAccount || await db.getUserNameFromAccountId(fairyData.accountId)
  }

  responseData.fairies = []
  for (const fairy of fairiesToSend) {

    const fairyEl = {
      '@fairy_id': fairy._id,
      '#': {
        user_id: fairy.accountId,
        address: fairy.address,
        more_options: fairy.moreOptions,
        // moreOptions offset 15: 0 = public, 1 = friends-only.
        home_privacy_state: Number((fairy.moreOptions || '').charAt(15)) || 0,
        tutorial: fairy.tutorialBitmask[0],
        tutorial_hi: fairy.tutorialBitmask[1],
        created: fairy.created.toISOString().split('T')[0],
        name: fairy.name,
        talent: fairy.talent,
        chosen: fairy.chosen,
        icon: fairy.icon,
        game_prof_bg: fairy.game_prof_bg,
        options_mask: fairy.optionsBitmask,
        level: fairy.level,
        // Both default to the fairy's talent until customized.
        home_type_id: fairy.homeType ?? fairy.talent,
        garden_type_id: fairy.gardenType ?? 1,
        badge_count: fairy.badge_count ?? 0,
        fav_badge: fairy.favoriteBadgeId ?? 0,
        newest_badge: fairy.newest_badge ?? 0
      }
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

    if (includeAvatar && fairy.avatar) {
      const avatarEl = {}

      // An array is what makes xmlbuilder2 repeat the tag for AvatarDNA.
      if (fairy.avatar.proportions) {
        const proportions = []

        for (const [type, value] of Object.entries(fairy.avatar.proportions)) {
          if (value != null) {
            proportions.push({
              '@type': type.toUpperCase(),
              '#': value
            })
          }
        }

        if (proportions.length) {
          avatarEl.proportion = proportions
        }
      }

      if (fairy.avatar.rotations) {
        const rotations = []

        for (const [type, value] of Object.entries(fairy.avatar.rotations)) {
          if (value != null) {
            rotations.push({
              '@type': type.toUpperCase(),
              '#': value
            })
          }
        }

        if (rotations.length) {
          avatarEl.rotation = rotations
        }
      }

      const simpleFields = [
        'hair_back', 'hair_front', 'face', 'eye', 'wing',
        'hair_color', 'eye_color', 'skin_color', 'wing_color'
      ]
      for (const field of simpleFields) {
        if (fairy.avatar[field] != null) {
          avatarEl[field] = fairy.avatar[field]
        }
      }

      avatarEl.gender = fairy.gender

      if (fairy.avatar.items) {
        avatarEl.inv_item = []

        for (const item of fairy.avatar.items) {
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

  res.send(createXML({
    response: responseData
  }))
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
  const existing = await db.retrieveFairyByOwnerAccount(ses.username);

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

// Written by the game-server's MongoInterface.recordStat.
const INVENTORY_STAT_TYPES = {
  games: 'game',
  stats: 'recipe'
}

app.post('/fairies/api/FairiesInventoryRequest', async (req, res) => {
  const statType = INVENTORY_STAT_TYPES[req.body.type]

  if (statType) {
    const fairyId = req.body.fairy_id ?? req.session?.fairyId ?? null
    const fairy = fairyId !== null ? await db.retrieveFairy(parseInt(fairyId)) : false

    const stats = fairy ? fairy.stats.filter(s => s.type === statType) : []

    return res.send(createXML({
      response: {
        success: true,
        inventory: {
          stat: stats.map(s => ({
            stat_id: s.statId,
            count: s.count,
            best: s.best,
            total: s.total,
            bonus: s.bonus
          }))
        }
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

// Build the <message> element the Post Office panels expect.
function buildMessageEl (m) {
  const words = m.words || []
  const wordColors = m.word_colors || []

  const el = {
    '@message_id': m._id,
    background: m.background ?? 0,
    phrase: m.phrase ?? 0,
    word: 0,
    fairy: {
      '@fairy_id': m.sender?.fairy_id ?? 0,
      '#': {
        name: m.sender?.name ?? '',
        address: m.sender?.address ?? '',
        talent: m.sender?.talent ?? 0,
        icon: m.sender?.icon ?? 0
      }
    },
    created: m.created ? m.created.toISOString() : ''
  }

  // All eight slots ship; the panel counts non-zero words to pick a frame.
  for (let i = 1; i <= 8; i++) {
    const color = wordColors[i - 1] || []

    el['word' + i] = {
      '@color1': color[0] ?? 0,
      '@color2': color[1] ?? 0,
      '#': words[i - 1] ?? 0
    }
  }

  return el
}

app.post('/fairies/api/FairiesMessageArchiveRequest', async (req, res) => {
  const fairyId = req.body.fairy_id ?? req.session?.fairyId ?? null
  const type = parseInt(req.body.type ?? 1)

  if (fairyId === null) {
    return res.send(createXML({ response: { success: false } }))
  }

  const messages = await db.getMessagesForFairy(parseInt(fairyId), type)

  return res.send(createXML({
    response: {
      success: true,
      messages: {
        message: messages.map(buildMessageEl)
      }
    }
  }))
})

app.post('/fairies/api/FairiesDeleteMessageRequest', async (req, res) => {
  const messageId = req.body.message_id ?? null

  if (messageId === null) {
    return res.send(createXML({ response: { success: false } }))
  }

  await db.deleteMessage(parseInt(messageId))

  return res.send(createXML({ response: { success: true } }))
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
    const ses = req.session
    const success = true

    if (!ses.logged || !questions || questions.length != 6) {
      return res.send(createXML({
        response: {
          success: !success
        }
      }))
    }

    const fairy = await db.retrieveFairy(ses.fairyId)
    for (const [i, question] of questions.entries()) {
      fairy.bio[i] = {
        id: i+1,
        answer: parseInt(question.answer[0]),
      }
    }

    await fairy.save()

    // setBio is `required db`, so the state server's copy is stale until told.
    md.sendFairyBio(fairy._id, fairy.bio)

    res.send(createXML({
      response: {
        success
      }
    }))
})

app.post('/fairies/api/FairiesEditIconRequest', async (req, res) => {
    const iconId = req.body.icon_id
    const bgId = req.body.game_prof_bg
    const ses = req.session
    const success = true

    if (!ses.logged || !iconId) {
      return res.send(createXML({
        response: {
          success: !success
        }
      }))
    }

    const fairy = await db.retrieveFairy(ses.fairyId)
    fairy.icon = iconId
    fairy.game_prof_bg = bgId

    await fairy.save()

    res.send(createXML({
      response: {
        success
      }
    }))
})

app.post('/fairies/api/UpdateFavoriteBadgeRequest', async (req, res) => {
    const badgeId = parseInt(req.body.badge_id)
    const ses = req.session
    const success = true

    if (!ses.logged || !badgeId) {
      return res.send(createXML({
        response: {
          success: !success
        }
      }))
    }

    const fairy = await db.retrieveFairy(ses.fairyId)

    // The panel already hides this for unearned badges; don't trust the client.
    const isEarned = fairy.badgeData?.badges?.some(
      badge => badge.badgeId === badgeId && badge.status === 'Earned'
    )

    if (!isEarned) {
      return res.send(createXML({
        response: {
          success: !success
        }
      }))
    }

    fairy.badgeData.favoriteBadgeId = badgeId
    await fairy.save()

    res.send(createXML({
      response: {
        success
      }
    }))
})

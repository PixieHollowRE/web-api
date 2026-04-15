/* global app:writable */
/* global db:writeable */

app = global.app

const createXML = require('../utils/xml')

const express = require('express')

const CryptoJS = require('crypto-js')

const fs = require('fs')
const { XMLParser } = require('fast-xml-parser')

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
  const nameParts = name.split(' ')
  const [firstName, lastName] = nameParts

  if (nameParts.length > 2) return false

  if (fairyNames['First'].includes(firstName)) {
    if (!lastName) return true

    for (const prefix of fairyNames['Prefix']) {
      if (lastName.startsWith(prefix)) {
        const suffix = lastName.slice(prefix.length)
        if (fairyNames['Suffix'].includes(suffix)) {
          return true
        }
      }
    }
  }

  return false
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
          speed_chat_prompt: speedChatPrompt,
          dname_submitted: true,
          dname_approved: true
        }
      },
      userTestAccessAllowed: false,
      'server-time': {
        day: new Date().toLocaleDateString('en-ZA'),
        time: new Date().toLocaleTimeString('en-ZA')
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
  const username = req.body.username
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
  const accountId = await db.getAccountIdFromUser(req.body.username)

  // Start our session if we do not already have one.
  // TODO: Should we redirect instead if they are already signed in?
  if (!req.session.logged) {
    await db.createSession(req, username, accountId, true)
  }

  res.setHeader('content-type', 'text/xml')
  res.send(createXML({
    response: {
      success: status,
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

  if (data.playToken && data.fieldData) {
    const fairy = await db.retrieveFairyByOwnerAccount(data.playToken)
    console.log(fairy, data.fieldData)
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
      const fairy = await db.retrieveFairy(req.params.identifier)
      if (fairy) {
        Object.assign(fairy, data)
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
  // NOTE: Sunrise only supports one Fairy or Sparrow Man character per account.
  // Sunrise is aiming for accuracy as close as possible, even if the client may allow it still.

  // Prior to November 10, 2011, you could create up to three fairies or sparrow men.
  // After that date, you could only create one fairy per Disney account.
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

  const fairyData = await db.retrieveFairy(fairyId)
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

  responseData.fairies = []
  for (const fairy of fairiesToSend) {
    const fairyEl = {
      '@fairy_id': fairy._id,
      '#': {
        address: fairy.address,
        more_options: fairy.moreOptions,
        tutorial: fairy.tutorialBitmask[0],
        tutorial_hi: fairy.tutorialBitmask[1],
        created: fairy.created.toISOString().split('T')[0],
        name: fairy.name,
        talent: fairy.talent,
        gender: fairy.gender,
        chosen: fairy.chosen,
        icon: fairy.icon,
        game_prof_bg: fairy.game_prof_bg,
        options_mask: fairy.optionsBitmask
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

      if (fairy.avatar.proportions) {
        for (const [type, value] of Object.entries(fairy.avatar.proportions)) {
          if (value != null) {
            avatarEl.proportion = {
              '@type': type.toUpperCase(),
              '#': value
            }
          }
        }
      }

      if (fairy.avatar.rotations) {
        for (const [type, value] of Object.entries(fairy.avatar.rotations)) {
          if (value != null) {
            avatarEl.rotation = {
              '@type': type.toUpperCase(),
              '#': value
            }
          }
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

app.post('/fairies/api/FairiesInventoryRequest', (req, res) => {
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

    res.send(createXML({
      response: {
        success
      }
    }))
})

app.post('/fairies/api/FairiesEditIconRequest', async (req, res) => {
    const iconId = req.body.icon_id
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

    await fairy.save()

    res.send(createXML({
      response: {
        success
      }
    }))
})

/* global mongoose: writeable */
/* global db: writeable */

mongoose = global.mongoose

const createXML = require('../utils/xml')

const Account = require('./models/Account')
const Fairy = require('./models/Fairy')
const RedeemableCode = require('./models/RedeemableCode')
const Message = require('./models/Message')

const bcrypt = require('bcrypt')

const axios = require('axios').default

const { normalizeFairyName } = require('../utils/name')

const saltRounds = 12

const userAgent = 'Sunrise Games - Pixie Hollow API'

const STARTER_FURNITURE = {
  1: [ // animal talent starter furniture
    { item_id: 6507, color1: 114, color2: 0 }, // Toadstool Tableset
    { item_id: 7005, color1: 115, color2: 0 }, // Glowing Gourd Lamp
    { item_id: 7512, color1: 142, color2: 0 }  // Woven Basket
  ],
  2: [ // garden talent starter furniture
    { item_id: 6513, color1: 254, color2: 0 }, // Sunflower Loveseat
    { item_id: 7007, color1: 157, color2: 0 }, // Rose of Sharon Lamp
    { item_id: 7507, color1: 121, color2: 0 }  // Watering Tin
  ],
  3: [ // light talent starter furniture
    { item_id: 6502, color1: 127, color2: 0 }, // Swirled Toadstool Chairs
    { item_id: 7003, color1: 128, color2: 0 }, // Daisy Table Lamp
    { item_id: 7523, color1: 116, color2: 0 }  // Firefly Fetcher
  ],
  4: [ // water talent starter furniture
    { item_id: 6535, color1: 135, color2: 0 }, // Eggshell Tea Table
    { item_id: 7001, color1: 131, color2: 0 }, // Tulip Floor Lamp
    { item_id: 7509, color1: 132, color2: 0 }  // River Stone Pitcher
  ],
  5: [ // tinker talent starter furniture
    { item_id: 6512, color1: 2, color2: 0 }, // Tulip Leaf Table
    { item_id: 7004, color1: 12, color2: 0 }, // Petal Candle
    { item_id: 7511, color1: 102, color2: 0 }  // Clay Pot
  ]
}

class Database {
  constructor() {
    this.connect()
  }

  async connect() {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/PixieHollow')

    console.log('Connected to MongoDB!')

    this.db = mongoose.connection

    // Create id sequence
    const doIdSequence = await this.db.collection('globals').findOne({ _id: 'doid' })
    if (!doIdSequence) {
      console.log('Creating doid sequence...')
      this.db.collection('globals').insertOne({
        _id: 'doid',
        seq: 1000000000
      })
    }

    this.db.on('error', console.error.bind(console, 'MongoDB connection error:'))
  }

  async getNextDoId() {
    const ret = await this.db.collection('globals').findOneAndUpdate(
      { _id: 'doid' }, // filter
      { $inc: { seq: 1 } }, // update
      { returnOriginal: true } // options
    )
    console.log(ret)
    return ret.seq
  }

  async handleFlashLogin(req, res) {
    let username = req.body.username
    let password = req.body.password
    let loginType = req.body.loginType

    if (username === undefined && password === undefined) {
      username = req.query.username
      password = req.query.password
    }

    if (username !== undefined) {
      username = username.toLowerCase()
    }

    if (loginType === undefined) {
      loginType = req.query.loginType
    }

    let validCredentials
    let accountId
    if (loginType === 'swid') {
      const ses = req.session
      if (ses.logged && ses.username && ses.userId) {
        validCredentials = true
        accountId = ses.userId
        username = ses.username
      }
    } else {
      validCredentials = await this.verifyCredentials(username, password)
      accountId = await this.getAccountIdFromUser(username)
    }

    const responseData = {
      success: validCredentials,
      error: ''
    }

    if (!validCredentials) {
      responseData.error = {
        '@code': 'PARAM_ERROR'
      }

      return res.send(createXML({
        result: responseData
      }))
    }

    responseData.input = {
      'cookieValue': '',
      'loginType': 'hard'
    }
    responseData.token = ''
    responseData.type = 'hard'
    responseData.banURL = ''
    responseData.results = {
      username,
      userId: accountId
    }

    res.setHeader('content-type', 'text/xml')
    res.send(createXML({
      result: responseData
    }))
  }

  async handleAccountLogin(req, res) {
    let username = req.body.username
    let password = req.body.password

    if (username === undefined && password === undefined) {
      username = req.query.username
      password = req.query.password
    }

    if (username !== undefined) {
      username = username.toLowerCase()
    }

    const validCredentials = await this.verifyCredentials(username, password)
    const accountId = await this.getAccountIdFromUser(username)

    let errorCode = '' // LOGIN_FAILED or BANNED

    if (validCredentials) {
      await db.createSession(req, username, accountId, false)
    } else {
      errorCode = 'LOGIN_FAILED'
    }

    res.setHeader('content-type', 'text/xml')
    res.send(createXML({
      AccountLoginResponse: {
        success: validCredentials,
        status: 'logged_in',
        error: {
          '@code': errorCode
        },
        account: {
          '@account_id': accountId
        },
        dname_submitted: true,
        dname_approved: true
      }
    }))
  }

  async createSession(req, username, accountId, justRegistered) {
    const ses = req.session

    ses.username = username
    ses.success = '1'
    ses.status = 'logged_in_player'
    ses.logged = true
    ses.userId = accountId

    if (!justRegistered) {
      const fairy = await this.retrieveFairy(accountId)
      ses.fairyId = fairy._id
    }
  }

  async isUsernameAvailable(username) {
    const account = await Account.exists({ username })

    if (account) {
      return false
    }

    return true
  }

  async doesFairyExist(identifier) {
    const fairy = await Fairy.findOne({ $or: [{ _id: identifier }, { accountId: identifier }] })

    if (fairy) {
      return true
    }

    return false
  }

  async retrieveFairy(identifier) {
    const fairy = await Fairy.findOne({ $or: [{ _id: identifier }, { accountId: identifier }] })

    if (fairy) {
      return fairy
    }

    return false
  }

  // No accountId fallback, so it stays unambiguous. Use it for writes.
  async retrieveFairyById(id) {
    const fairy = await Fairy.findById(id)

    if (fairy) {
      return fairy
    }

    return false
  }

  async retrieveFairyByOwnerAccount(owner) {
    const fairy = await Fairy.findOne({ ownerAccount: owner })

    if (fairy) {
      return fairy
    }

    return false
  }

  // For callers that must not silently act on an arbitrary fairy.
  async retrieveFairiesByOwnerAccount(owner) {
    return await Fairy.find({ ownerAccount: owner })
  }

  // Projected on purpose: a 300-friend login would pull 300 whole fairies.
  async retrieveFairySummaries(identifiers) {
    return await Fairy.find(
      { $or: [{ _id: { $in: identifiers } }, { accountId: { $in: identifiers } }] },
      { _id: 1, accountId: 1, name: 1, ownerAccount: 1 }
    )
  }

  // A fairy projected down to exactly what FairiesProfileRequest emits.
  async retrieveFairyProfile(identifier, { includeAvatar = false, includeBio = false } = {}) {
    const id = Number(identifier)

    if (!Number.isFinite(id)) {
      return false
    }

    // Matched on _id or accountId, so both branches hit an index.
    const earned = {
      $filter: {
        input: { $ifNull: ['$badgeData.badges', []] },
        as: 'b',
        cond: { $eq: ['$$b.status', 'Earned'] }
      }
    }

    const projection = {
      _id: 1,
      accountId: 1,
      ownerAccount: 1,
      address: 1,
      moreOptions: 1,
      created: 1,
      name: 1,
      talent: 1,
      gender: 1,
      chosen: 1,
      icon: 1,
      game_prof_bg: 1,
      optionsBitmask: 1,
      level: 1,
      homeType: 1,
      gardenType: 1,
      tutorialBitmask: { $ifNull: ['$tutorialBitmask', [0, 0]] },

      badge_count: { $size: earned },
      favoriteBadgeId: { $ifNull: ['$badgeData.favoriteBadgeId', 0] },

      // $gt keeps the first on a tie, the way the array reduce it replaced did.
      newest_badge: {
        $let: {
          vars: {
            best: {
              $reduce: {
                input: {
                  $filter: { input: earned, as: 'b', cond: { $ne: ['$$b.dateEarned', null] } }
                },
                initialValue: null,
                in: {
                  $cond: [
                    {
                      $or: [
                        { $eq: ['$$value', null] },
                        { $gt: ['$$this.dateEarned', '$$value.dateEarned'] }
                      ]
                    },
                    '$$this',
                    '$$value'
                  ]
                }
              }
            }
          },
          in: { $ifNull: ['$$best.badgeId', 0] }
        }
      }
    }

    if (includeBio) {
      projection.bio = { $ifNull: ['$bio', []] }
    }

    if (includeAvatar) {
      // items is the expensive part, so it is cut down to what renders.
      projection.avatar = {
        proportions: { $ifNull: ['$avatar.proportions', {}] },
        rotations: { $ifNull: ['$avatar.rotations', {}] },
        hair_back: '$avatar.hair_back',
        hair_front: '$avatar.hair_front',
        face: '$avatar.face',
        eye: '$avatar.eye',
        wing: '$avatar.wing',
        hair_color: '$avatar.hair_color',
        eye_color: '$avatar.eye_color',
        skin_color: '$avatar.skin_color',
        wing_color: '$avatar.wing_color',
        items: {
          $map: {
            input: {
              $filter: {
                input: { $ifNull: ['$avatar.items', []] },
                as: 'i',
                cond: { $eq: ['$$i.location', 'Equipped'] }
              }
            },
            as: 'i',
            in: {
              type: '$$i.type',
              item_id: '$$i.item_id',
              color1: '$$i.color1',
              color2: '$$i.color2',
              location: '$$i.location'
            }
          }
        }
      }
    }

    const [fairy] = await Fairy.aggregate([
      { $match: { $or: [{ _id: id }, { accountId: id }] } },
      { $limit: 1 },
      { $project: projection }
    ])

    if (fairy) {
      return fairy
    }

    return false
  }

  async getAccountIdFromUser(username) {
    const account = await this.retrieveAccountFromUser(username)

    if (account) {
      return account._id
    }

    return -1
  }

  async getUserNameFromAccountId(accountId) {
    const account = await this.retrieveAccountFromIdentifier(accountId)

    if (account) {
      return account.username
    }

    return ''
  }

  async retrieveAccountData(username) {
    const data = new URLSearchParams()

    data.append('username', username)
    data.append('secretKey', process.env.API_TOKEN)

    const request = await axios.post('https://sunrise.games/api/internal/Account.php', data, {
      headers: {
        'Accept-Encoding': 'application/json',
        'User-Agent': userAgent
      }
    })
    return request.data
  }

  async checkLogin(username, password) {
    const data = new URLSearchParams()

    data.append('username', username)
    data.append('password', password)
    data.append('serverType', 'Pixie Hollow')

    return await axios.post('https://sunrise.games/api/login/alt/', data, {
      headers: {
        'Accept-Encoding': 'application/json',
        'User-Agent': userAgent
      }
    })
  }

  async retrieveAccountFromIdentifier(identifier) {
    return await Account.findById(identifier)
  }

  async retrieveAccountFromUser(username) {
    return await Account.findOne({ username })
  }

  async retrieveAccountFromFairyId(fairyId) {
    return await Account.findOne({ $or: [{ playerId: fairyId }] })
  }

  async verifyCredentials(username, password) {
    let account = await this.retrieveAccountFromUser(username)

    if (!account) {
      // Check if it's in the Sunrise Games database.
      const res = await this.checkLogin(username, password)
      const errorCode = res.data.errorCode

      if (errorCode === 0) {
        // Create a brand new account
        account = await this.createAccount(username, password)
      } else {
        return false
      }
    }

    const match = bcrypt.compareSync(password, account.password)

    if (!match) {
      // Check if it's in the Sunrise Games database.
      const res = await this.checkLogin(username, password)
      const errorCode = res.data.errorCode

      if (errorCode === 0) {
        // The Sunrise Games password changed; rehash ours to match.
        account.password = bcrypt.hashSync(password, saltRounds)
        await account.save()
      } else {
        return false
      }
    }

    return match
  }

  async createFairy(accountId, fairyData) {
    const avatar = fairyData.avatar[0]

    const proportions = {}
    avatar.proportion.forEach(p => {
      proportions[p.$.type.toLowerCase()] = parseInt(p._)
    })

    const rotations = {}
    avatar.rotation.forEach(r => {
      rotations[r.$.type.toLowerCase()] = parseInt(r._)
    })

    const items = []

    for (const i of avatar.item) {
      let color1 = 0
      let color2 = 0

      for (const c of i.color || []) {
        const num = parseInt(c.$.number)
        const val = parseInt(c._)

        if (num === 1) {
          color1 = val
        } else if (num === 2) {
          color2 = val
        }
      }

      items.push({
        inv_id: await this.getNextDoId(),
        type: i.$.type,
        item_id: parseInt(i.item_id[0]),
        color1,
        color2,
        location: "Equipped"
      })
    }

    const bio = () => {
      const questions = []
      for (let i = 1; i <= 6; i++) {
        questions.push({ id: i, answer: 0 })
      }
      return questions
    }

    const talentNum = parseInt(fairyData.talent[0])
    const starterFurniture = STARTER_FURNITURE[talentNum] || []

    for (const f of starterFurniture) {
      items.push({
        inv_id: await this.getNextDoId(),
        type: "Furniture",
        item_id: f.item_id,
        color1: f.color1,
        color2: f.color2,
        location: "Storage"
      })
    }

    const account = await this.retrieveAccountFromIdentifier(accountId)

    // Store our fairy.
    const fairy = new Fairy({
      _id: await this.getNextDoId(),
      ownerAccount: await this.getUserNameFromAccountId(accountId),
      accountId,
      name: normalizeFairyName(fairyData.name[0]),
      talent: parseInt(fairyData.talent[0]),
      gender: parseInt(fairyData.gender[0]),
      bio: bio(),
      avatar: {
        proportions,
        rotations,
        hair_back: parseInt(avatar.hair_back[0]),
        hair_front: parseInt(avatar.hair_front[0]),
        face: parseInt(avatar.face[0]),
        eye: parseInt(avatar.eye[0]),
        wing: parseInt(avatar.wing[0]),
        hair_color: parseInt(avatar.hair_color[0]),
        eye_color: parseInt(avatar.eye_color[0]),
        skin_color: parseInt(avatar.skin_color[0]),
        wing_color: parseInt(avatar.wing_color[0]),
        items
      }
    })

    const saved = await fairy.save()

    // Save the information into the account.
    account.playerId = fairy._id
    await account.save()

    return saved._id
  }

  async createAccount(username, password) {
    if (!await this.isUsernameAvailable(username)) {
      // Sanity check
      return false
    }

    // Store the account object.
    const account = new Account({
      _id: await this.getNextDoId(),
      username,
      password: bcrypt.hashSync(password, saltRounds)
    })

    return await account.save()
  }

  // Post Office messages (postcards/gift sets waiting in a fairy's home).
  async getMessagesForFairy(fairyId, type) {
    return await Message.find({ recipient_id: fairyId, type }).sort({ created: 1 })
  }

  async deleteMessage(messageId) {
    return await Message.deleteOne({ _id: messageId })
  }

  async getRedeemableCode(code) {
    return await RedeemableCode.findOne({ $and: [{ codeName: code }, { expirationDate: { $gt: new Date() } }] })
  }

  async checkCodeRedeemedByUser(username, code) {
    const account = await this.retrieveAccountFromUser(username)

    if (account) {
      if (account.codesRedeemed === undefined) {
        account.codesRedeemed = {}
        await account.save()
      }

      return account.codesRedeemed.includes(code)
    }

    return false
  }

  async setCodeAsRedeemedByUser(username, code) {
    const account = await this.retrieveAccountFromUser(username)

    if (account) {
      account.codesRedeemed.push(code)
      await account.save()
    }
  }
}

module.exports = Database

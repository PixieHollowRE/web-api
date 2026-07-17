/* global mongoose: writeable */

mongoose = global.mongoose

const Fairy = new mongoose.model('Fairy', {
  _id: { type: Number },
  ownerAccount: { type: String },
  accountId: { type: Number }, // Account object id
  friends: { type: Array }, // Friends list (of Account object ids)
  created: { type: Date, default: Date.now },
  name: String,
  talent: Number,
  gender: Number,
  chosen: { type: Boolean, default: true },
  icon: { type: Number, default: 0 },
  game_prof_bg: { type: String, default: null },
  bio: { type: Array },
  address: { type: String, default: '1234CatepillerCorral' },
  homeType: { type: Number, default: null }, // home_type_id; falls back to talent when unset
  moreOptions: { type: String, default: '000000000000000000000000' },
  tutorialBitmask: { type: Array, default: [0, 0] },
  optionsBitmask: { type: Number, default: 0 },
  gold: { type: Number, default: 0 },
  goldTradedToday: { type: Number, default: 0 },
  lastGoldTradeAt: { type: Date, default: null }, 
  pouch: { type: Array },
  maxOutfitSlots: { type: Number, default: 1 }, // saved-outfit slots; owned by the game-server AI
  savedOutfits: { type: Array, default: [] }, // written only by the game-server AI (DistributedFairyPlayerAI)
  level: { type: Number, default: 0 },
  dailyChanceLastSpin: { type: Date, default: null },
  badgeData: {
    badges: [{
      badgeId: { type: Number },
      status: {
        type: String,
        enum: ['Active', 'Earned'],
        default: 'Active'
      },
      progress: { type: Number, default: 0 },
      dateEarned: { type: Date, default: null }
    }],
    unlockedPages: { type: Array, default: [] },
    favoriteBadgeId: { type: Number, default: 0 }
  },
  stats: [{
    type: { type: String, enum: ['recipe', 'game'], required: true },
    statId: { type: Number, required: true },
    count: { type: Number, default: 0 },
    best: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
  }],
  avatar: {
    proportions: {
      head: Number,
      height: Number,
      body: Number
    },
    rotations: {
      head_rot: Number,
      ll_arm_rot: Number,
      ul_arm_rot: Number,
      ul_leg_rot: Number,
      ll_leg_rot: Number,
      lr_arm_rot: Number,
      ur_arm_rot: Number,
      lr_leg_rot: Number,
      ur_leg_rot: Number
    },
    hair_back: Number,
    hair_front: Number,
    face: Number,
    eye: Number,
    wing: Number,
    hair_color: Number,
    hair_color2: { type: Number, default: 0 },
    eye_color: Number,
    skin_color: Number,
    wing_color: Number,
    items: [{
      inv_id: Number,
      type: { type: String },
      item_id: Number,
      slot: { type: Number, default: 0 },
      createdById: { type: Number, default: 0 },
      createdByName: { type: String, default: '' },
      giftedById: { type: Number, default: 0 },
      giftedByName: { type: String, default: '' },
      quality: { type: Number, default: 0 },
      color1: { type: Number, default: 0 },
      color2: { type: Number, default: 0 },
      howAcquired: { type: Number, default: 0 },
      location: {
        type: String,
        enum: ['Equipped', 'Wardrobe', 'Storage'],
        default: 'Wardrobe'
      },
      home: {
        type: {
          roomId: Number,
          x: Number,
          y: Number,
          depth: Number,
          flip: Number,
          scale: Number
        },
        default: undefined,
        _id: false
      }
    }]
  }
})

module.exports = Fairy

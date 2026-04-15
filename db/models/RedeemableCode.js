/* global mongoose: writeable */

mongoose = global.mongoose

const RedeemableCode = new mongoose.model('RedeemableCode', {
  _id: { type: Number },
  codeName: { type: String },
  rewardId: { type: Number },
  quantity: { type: Number },
  expirationDate: { type: Date }
})

module.exports = RedeemableCode

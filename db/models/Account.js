/* global mongoose: writeable */

mongoose = global.mongoose

const Account = new mongoose.model('Account', {
  _id: { type: Number },
  username: { type: String, index: true },
  password: { type: String },
  playerId: { type: Number }, // DistributedFairyPlayer object id
  lastLogin: { type: String },
  codesRedeemed: { type: Array },
  membershipStartDate: { type: Date, default: null }
})

module.exports = Account

/* global mongoose: writeable */

mongoose = global.mongoose

const Account = new mongoose.model('Account', {
  _id: { type: Number },
  username: { type: String },
  password: { type: String },
  playerId: { type: Number }, // DistributedFairyPlayer object id
  lastLogin: { type: String },
  codesRedeemed: { type: Array }
})

module.exports = Account

/* global mongoose: writeable */

mongoose = global.mongoose

// Written by DistributedFairyShopkeeperNPCAI._writePostOfficeMessage.
const Message = new mongoose.model('Message', {
  _id: { type: Number }, // a doid, not an ObjectId -- shared with the cluster
  recipient_id: { type: Number }, // Fairy _id the message is waiting for
  type: { type: Number }, // 4 = postcard, 5 = gift set
  sender: {
    fairy_id: { type: Number },
    name: { type: String, default: '' },
    address: { type: String, default: '' },
    talent: { type: Number, default: 0 },
    icon: { type: Number, default: 0 }
  },
  background: { type: Number, default: 0 }, // postcard design id, else 0
  phrase: { type: Number, default: 0 }, // canned message id the sender picked
  words: { type: Array, default: [] }, // gift-set item ids; [] for postcards
  word_colors: { type: Array, default: [] }, // [c1, c2] per word; [] pre-fix
  created: { type: Date, default: Date.now }
})

module.exports = Message

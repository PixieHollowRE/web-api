/* global mongoose: writeable */

mongoose = global.mongoose

// A Post Office message: a postcard (type 4) or gift set (type 5) waiting in a
// fairy's home Post Office. Written by the game-server shopkeeper AI
// (DistributedFairyShopkeeperNPCAI._writePostOfficeMessage) into the shared
// `messages` collection, read back here by FairiesMessageArchiveRequest and
// removed by FairiesDeleteMessageRequest. `_id` is a distributed-object id from
// the shared doid sequence, so it stays a Number rather than an ObjectId.
const Message = new mongoose.model('Message', {
  _id: { type: Number },
  recipient_id: { type: Number }, // Fairy _id the message is waiting for
  type: { type: Number }, // 4 = postcard, 5 = gift set
  sender: {
    fairy_id: { type: Number },
    name: { type: String, default: '' },
    address: { type: String, default: '' },
    talent: { type: Number, default: 0 },
    icon: { type: Number, default: 0 }
  },
  background: { type: Number, default: 0 }, // postcard design id (88501-88521); 0 for gift sets
  phrase: { type: Number, default: 0 }, // canned message id the sender picked
  words: { type: Array, default: [] }, // gift-set item ids (empty for postcards)
  created: { type: Date, default: Date.now }
})

module.exports = Message

// Bridge from the API into the OTP cluster.
//
// The cluster has no database of its own: APIDatabase.lua pulls object state
// from us over HTTP when an object is generated. The catch is that fields
// marked `db` in the dclass are only read at generate time — the state server
// then keeps them in RAM and only re-broadcasts them when the field is updated
// through the cluster. So a route that writes Mongo directly leaves the state
// server holding a stale copy until the object is regenerated (i.e. a relog).
//
// This lets those routes poke the state server so its RAM copy, its
// `broadcast` viewers and its `ownrecv` owner all catch up immediately.
//
// - Jessi

const net = require('net')

const Datagram = require('../utils/datagram')

// See game-server/game/otp/ai/AIMsgTypes.py
const STATESERVER_OBJECT_UPDATE_FIELD = 2004

const FIELD_SET_BIO = 485

// Our own channel on the cluster. This must not collide with anything allocated
// in game-server/config/otp.yml: DATABASE_ID 4003, DistributedDirectory 4619,
// uberdogs 4677-4756, stateserver control 20100000, clientagent/dbss
// 1000000000 and up. I picked 4010 but this can be changed
const WEB_API_CHANNEL = 4010

const RECONNECT_DELAY = 5000

// BioAnswer's fields are int16, but the values reach us straight from client
// input via parseInt. Clamp anything unrepresentable instead of letting the
// packer throw. yadda yadda hacked client or whatever.
function toInt16(value) {
  const number = Number(value)

  if (!Number.isFinite(number)) {
    return 0
  }

  return Math.max(-32768, Math.min(32767, Math.trunc(number)))
}

class MessageDirector {
  constructor(host, port) {
    this.host = host || process.env.MD_HOST || '127.0.0.1'
    this.port = parseInt(process.env.MD_PORT) || port || 6666

    this.socket = null
    this.connected = false
    this.reconnectTimer = null

    this.connect()
  }

  connect() {
    this.reconnectTimer = null

    this.socket = net.createConnection({ host: this.host, port: this.port })

    this.socket.on('connect', () => {
      this.connected = true
      console.log(`Connected to the message director at ${this.host}:${this.port}!`)
    })

    // We only ever send, so we never subscribe to a channel and nothing should
    // be routed back to us. Drain anything that does arrive so the socket
    // doesn't stall.
    this.socket.on('data', () => {})

    this.socket.on('error', (err) => {
      console.error('Message director connection error:', err.message)
    })

    this.socket.on('close', () => {
      if (this.connected) {
        console.warn('Lost the message director connection, reconnecting...')
      }

      this.connected = false
      this.scheduleReconnect()
    })
  }

  scheduleReconnect() {
    if (this.reconnectTimer) {
      return
    }

    this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY)
  }

  send(dg) {
    if (!this.connected) {
      console.warn('Not connected to the message director, dropping datagram.')
      return false
    }

    try {
      this.socket.write(dg.toBuffer())
      return true
    } catch (err) {
      console.error('Failed to write to the message director:', err.message)
      return false
    }
  }

  // Test Datagram based on my own research - if this breaks yell at Jessi :)
  sendUpdateField(doId, fieldId, value) {
    const dg = new Datagram()

    dg.addServerHeader(doId, WEB_API_CHANNEL, STATESERVER_OBJECT_UPDATE_FIELD)
    dg.addUint32(doId)
    dg.addUint16(fieldId)
    dg.addBytes(value)

    return this.send(dg)
  }

  sendFairyBio(doId, bio) {
    const answers = new Datagram()

    for (const answer of bio || []) {
      answers.addInt16(toInt16(answer.id))
      answers.addInt16(toInt16(answer.answer))
    }

    const packed = answers.body()

    const value = new Datagram()
    value.addUint16(packed.length)
    value.addBytes(packed)

    return this.sendUpdateField(doId, FIELD_SET_BIO, value.body())
  }
}

module.exports = MessageDirector

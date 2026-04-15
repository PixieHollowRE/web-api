const express = require('express')
const cors = require('cors')
const xmlparser = require('express-xml-bodyparser')
const session = require('express-session')
const MongoStore = require('connect-mongo').default

global.mongoose = require('mongoose')

Database = require('./db/Database')
global.db = new Database()

/* global Database: writeable */

_create = require('xmlbuilder2')
global.create = _create.create

/* global _create: writeable */

global.app = express()

global.app.set('trust proxy', 1)

// for parsing application/x-www-form-urlencoded
global.app.use(express.urlencoded({ extended: true }))

global.app.use(cors())
global.app.use(xmlparser())

/* global sess: writeable */

// Setup sessions and include our web routes.
sess = {
  secret: process.env.SESSION_SECRET || 'PixieHollow_secret',
  store: MongoStore.create({ mongoUrl: 'mongodb://127.0.0.1:27017/PixieHollow', ttl: 60 * 60 * 24 }),
  resave: false,
  saveUninitialized: true,

  cookie: {
    secure: false, // if true only transmit cookie over https
    httpOnly: false, // if true prevent client side JS from reading the cookie
    maxAge: 1000 * 60 * 60 * 24 // session max age in milliseconds
  },
  rolling: true // reset the cookie Max-Age on every request
}

global.app.use(session(sess))

require('./services/WebService')

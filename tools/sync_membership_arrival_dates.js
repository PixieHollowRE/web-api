/**
 * Align account.membershipStartDate with fairy.created (arrival is source of truth).
 *
 * Usage:
 *   node tools/sync_membership_arrival_dates.js --dry-run
 *   node tools/sync_membership_arrival_dates.js --username <account>
 *   node tools/sync_membership_arrival_dates.js --all
 *   node tools/sync_membership_arrival_dates.js --restore tools/backups/membership_arrival/<file>.json
 */

const fs = require('fs')
const path = require('path')

const apiRoot = path.join(__dirname, '..')
try {
  require(path.join(apiRoot, 'node_modules', 'dotenv')).config({ path: path.join(apiRoot, '.env') })
} catch (_) {
  // dotenv optional when MONGO_URI is set externally
}

const mongoose = require('mongoose')
global.mongoose = mongoose

const Account = require(path.join(apiRoot, 'db/models/Account'))
const Fairy = require(path.join(apiRoot, 'db/models/Fairy'))
const {
  canonicalArrivalDate,
  datesMatch,
  utcCalendarDay
} = require(path.join(apiRoot, 'utils/loyalty'))

const BACKUP_DIR = path.join(__dirname, 'backups', 'membership_arrival')

function parseArgs (argv) {
  const args = {
    dryRun: false,
    all: false,
    username: null,
    restore: null
  }

  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--dry-run') {
      args.dryRun = true
    } else if (token === '--all') {
      args.all = true
    } else if (token === '--username' && argv[i + 1]) {
      args.username = argv[++i]
    } else if (token === '--restore' && argv[i + 1]) {
      args.restore = argv[++i]
    } else {
      throw new Error(`Unknown argument: ${token}`)
    }
  }

  if (!args.restore && !args.all && !args.username) {
    throw new Error('Specify --all, --username <name>, or --restore <backup.json>')
  }

  return args
}

function timestampForFilename () {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function loadFairyForAccount (account) {
  return Fairy.findOne({
    $or: [
      { accountId: account._id },
      { ownerAccount: account.username }
    ]
  }).select('_id name created ownerAccount accountId')
}

function describeRow (account, fairy, targetDate) {
  return {
    accountId: account._id,
    username: account.username,
    fairyId: fairy?._id ?? null,
    fairyName: fairy?.name ?? null,
    arrivalDate: fairy?.created ?? null,
    previousMembershipStartDate: account.membershipStartDate ?? null,
    targetMembershipStartDate: targetDate
  }
}

async function planSyncForAccount (account) {
  const fairy = await loadFairyForAccount(account)
  if (!fairy?.created) {
    return {
      action: 'skip',
      reason: 'no fairy with created date',
      row: describeRow(account, fairy, null)
    }
  }

  const targetDate = canonicalArrivalDate(fairy, account)
  if (!targetDate) {
    return {
      action: 'skip',
      reason: 'could not resolve arrival date',
      row: describeRow(account, fairy, null)
    }
  }

  if (datesMatch(account.membershipStartDate, targetDate)) {
    return {
      action: 'skip',
      reason: 'already aligned',
      row: describeRow(account, fairy, targetDate)
    }
  }

  return {
    action: 'update',
    row: describeRow(account, fairy, targetDate)
  }
}

async function runSync (args) {
  const query = args.username
    ? { username: args.username }
    : {}

  const accounts = await Account.find(query).select('_id username membershipStartDate')
  if (!accounts.length) {
    console.log('No matching accounts.')
    return
  }

  const planned = []
  for (const account of accounts) {
    planned.push(await planSyncForAccount(account))
  }

  const updates = planned.filter((entry) => entry.action === 'update')
  const skipped = planned.filter((entry) => entry.action === 'skip')

  console.log(`Accounts scanned: ${accounts.length}`)
  console.log(`Would update: ${updates.length}`)
  console.log(`Skipped: ${skipped.length}`)

  for (const entry of updates) {
    const row = entry.row
    console.log(
      `[update] ${row.username} fairy=${row.fairyId} ` +
      `membership ${utcCalendarDay(row.previousMembershipStartDate) || '(null)'} -> ` +
      `${utcCalendarDay(row.targetMembershipStartDate)}`
    )
  }

  if (args.dryRun) {
    console.log('Dry run only; no writes performed.')
    return
  }

  if (!updates.length) {
    console.log('Nothing to update.')
    return
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const backupPath = path.join(BACKUP_DIR, `membership_arrival_${timestampForFilename()}.json`)
  fs.writeFileSync(
    backupPath,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      updates: updates.map((entry) => entry.row)
    }, null, 2)
  )
  console.log(`Backup written: ${backupPath}`)

  for (const entry of updates) {
    await Account.updateOne(
      { _id: entry.row.accountId },
      { $set: { membershipStartDate: entry.row.targetMembershipStartDate } }
    )
  }

  console.log(`Updated ${updates.length} account(s).`)
}

async function runRestore (backupPath) {
  const resolved = path.isAbsolute(backupPath)
    ? backupPath
    : path.join(apiRoot, backupPath)

  const payload = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  const rows = Array.isArray(payload.updates) ? payload.updates : []

  if (!rows.length) {
    console.log('Backup contains no update rows.')
    return
  }

  for (const row of rows) {
    await Account.updateOne(
      { _id: row.accountId },
      { $set: { membershipStartDate: row.previousMembershipStartDate ?? null } }
    )
    console.log(`[restore] ${row.username} -> ${utcCalendarDay(row.previousMembershipStartDate) || '(null)'}`)
  }

  console.log(`Restored ${rows.length} account(s) from ${resolved}`)
}

async function main () {
  const args = parseArgs(process.argv)
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/PixieHollow')

  try {
    if (args.restore) {
      await runRestore(args.restore)
    } else {
      await runSync(args)
    }
  } finally {
    await mongoose.disconnect()
  }
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})

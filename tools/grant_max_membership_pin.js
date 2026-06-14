/**
 * Set fairy arrival + account membership start so member_days reaches max pin tier (15).
 *
 * Grants max membership pin (tier 15) to any account by login username.
 *
 * Usage:
 *   node tools/grant_max_membership_pin.js
 *   node tools/grant_max_membership_pin.js --username <login_username>
 *   node tools/grant_max_membership_pin.js --username <login_username> --dry-run
 *   node tools/grant_max_membership_pin.js --restore tools/backups/max_pin/<file>.json
 */

const fs = require('fs')
const path = require('path')
const readline = require('readline')

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
  MAX_MEMBER_DAYS,
  MAX_TIER,
  NON_MEMBER_DAYS,
  computeMemberDays,
  loyaltyTier,
  membershipStartDateForMemberDays,
  utcCalendarDay
} = require(path.join(apiRoot, 'utils/loyalty'))

const BACKUP_DIR = path.join(__dirname, 'backups', 'max_pin')

function parseArgs (argv) {
  const args = {
    dryRun: false,
    yes: false,
    username: null,
    restore: null
  }

  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--dry-run') {
      args.dryRun = true
    } else if (token === '--yes' || token === '-y') {
      args.yes = true
    } else if (token === '--username' && argv[i + 1]) {
      args.username = argv[++i]
    } else if (token === '--restore' && argv[i + 1]) {
      args.restore = argv[++i]
    } else {
      throw new Error(`Unknown argument: ${token}`)
    }
  }

  return args
}

function timestampForFilename () {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function promptLine (question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function promptUsername () {
  const username = await promptLine('Enter account username to grant max pin: ')
  if (!username) {
    throw new Error('Username is required.')
  }

  return username
}

async function confirmApply () {
  const answer = await promptLine('Apply max pin grant? (y/N): ')
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes'
}

async function loadFairyForAccount (account) {
  return Fairy.findOne({
    $or: [
      { accountId: account._id },
      { ownerAccount: account.username }
    ]
  }).select('_id name created ownerAccount accountId lastAckMemberDays')
}

function describePlan (account, fairy, targetDate, now = new Date()) {
  const previousMemberDays = computeMemberDays({}, account.membershipStartDate, now)
  const targetMemberDays = computeMemberDays({}, targetDate, now)

  return {
    accountId: account._id,
    username: account.username,
    fairyId: fairy?._id ?? null,
    fairyName: fairy?.name ?? null,
    previousCreated: fairy?.created ?? null,
    previousMembershipStartDate: account.membershipStartDate ?? null,
    previousLastAckMemberDays: fairy?.lastAckMemberDays ?? NON_MEMBER_DAYS,
    previousMemberDays,
    previousTier: loyaltyTier(previousMemberDays),
    targetCreated: targetDate,
    targetMembershipStartDate: targetDate,
    targetLastAckMemberDays: NON_MEMBER_DAYS,
    targetMemberDays,
    targetTier: loyaltyTier(targetMemberDays)
  }
}

function printPlan (plan) {
  console.log(`Account: ${plan.username} (id=${plan.accountId})`)
  console.log(`Fairy: ${plan.fairyName || '(unknown)'} (id=${plan.fairyId})`)
  console.log(
    `Arrival: ${utcCalendarDay(plan.previousCreated) || '(null)'} -> ` +
    `${utcCalendarDay(plan.targetCreated)}`
  )
  console.log(
    `Membership start: ${utcCalendarDay(plan.previousMembershipStartDate) || '(null)'} -> ` +
    `${utcCalendarDay(plan.targetMembershipStartDate)}`
  )
  console.log(
    `Member days / tier: ${plan.previousMemberDays} (tier ${plan.previousTier}) -> ` +
    `${plan.targetMemberDays} (tier ${plan.targetTier})`
  )
  console.log(
    `lastAckMemberDays: ${plan.previousLastAckMemberDays} -> ${plan.targetLastAckMemberDays} ` +
    '(resets pin tier-up ack)'
  )
}

async function planGrant (username) {
  const account = await Account.findOne({ username }).select('_id username membershipStartDate')
  if (!account) {
    throw new Error(`No account found for username: ${username}`)
  }

  const fairy = await loadFairyForAccount(account)
  if (!fairy) {
    throw new Error(`No fairy found for account: ${username}`)
  }

  const targetDate = membershipStartDateForMemberDays(MAX_MEMBER_DAYS)
  const plan = describePlan(account, fairy, targetDate)

  if (plan.targetTier < MAX_TIER) {
    throw new Error(
      `Target tier ${plan.targetTier} is below max tier ${MAX_TIER}; ` +
      `expected at least ${MAX_MEMBER_DAYS} member days.`
    )
  }

  const alreadyMax =
    utcCalendarDay(plan.previousCreated) === utcCalendarDay(plan.targetCreated) &&
    utcCalendarDay(plan.previousMembershipStartDate) === utcCalendarDay(plan.targetMembershipStartDate) &&
    plan.previousTier >= MAX_TIER

  return { account, fairy, plan, alreadyMax }
}

async function runGrant (args) {
  const username = args.username || await promptUsername()
  const { account, fairy, plan, alreadyMax } = await planGrant(username)

  console.log(`Max pin needs ${MAX_MEMBER_DAYS} member days (tier ${MAX_TIER}).`)
  printPlan(plan)

  if (alreadyMax) {
    console.log('Already at max pin dates; nothing to change.')
    return
  }

  if (args.dryRun) {
    console.log('Dry run only; no writes performed.')
    return
  }

  if (!args.yes) {
    const confirmed = await confirmApply()
    if (!confirmed) {
      console.log('Cancelled.')
      return
    }
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const backupPath = path.join(BACKUP_DIR, `max_pin_${timestampForFilename()}.json`)
  fs.writeFileSync(backupPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    plan
  }, null, 2))
  console.log(`Backup written: ${backupPath}`)

  await Fairy.updateOne(
    { _id: fairy._id },
    {
      $set: {
        created: plan.targetCreated,
        lastAckMemberDays: plan.targetLastAckMemberDays
      }
    }
  )

  await Account.updateOne(
    { _id: account._id },
    { $set: { membershipStartDate: plan.targetMembershipStartDate } }
  )

  console.log(`Granted max pin to ${username}. Log out and back in to refresh member_days.`)
  console.log('Note: Sunrise MemberDays/MemberSince overrides Mongo if set on the account.')
}

async function runRestore (backupPath) {
  const resolved = path.isAbsolute(backupPath)
    ? backupPath
    : path.join(apiRoot, backupPath)

  const payload = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  const plan = payload.plan
  if (!plan?.accountId || !plan?.fairyId) {
    throw new Error('Backup is missing plan.accountId or plan.fairyId')
  }

  await Account.updateOne(
    { _id: plan.accountId },
    { $set: { membershipStartDate: plan.previousMembershipStartDate ?? null } }
  )

  await Fairy.updateOne(
    { _id: plan.fairyId },
    {
      $set: {
        created: plan.previousCreated ?? new Date(),
        lastAckMemberDays: plan.previousLastAckMemberDays ?? NON_MEMBER_DAYS
      }
    }
  )

  console.log(`Restored ${plan.username} from ${resolved}`)
}

async function main () {
  const args = parseArgs(process.argv)
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/PixieHollow')

  try {
    if (args.restore) {
      await runRestore(args.restore)
    } else {
      await runGrant(args)
    }
  } finally {
    await mongoose.disconnect()
  }
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})

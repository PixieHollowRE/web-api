const LOYALTY_PERIOD_DAYS = 90
const MAX_TIER = 15
const MAX_MEMBER_DAYS = MAX_TIER * LOYALTY_PERIOD_DAYS
const NON_MEMBER_DAYS = -1

// Sunrise Account.php fields (first match wins).
const MEMBER_SINCE_FIELDS = [
  'MemberSince',
  'memberSince',
  'MembershipStart',
  'membershipStart'
]
const MEMBER_DAYS_FIELDS = [
  'MemberDays',
  'memberDays',
  'member_days'
]

function parseDateValue (value) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed
}

function parseMembershipStartDate (accData) {
  if (!accData || typeof accData !== 'object') {
    return null
  }

  for (const field of MEMBER_SINCE_FIELDS) {
    const parsed = parseDateValue(accData[field])
    if (parsed) {
      return parsed
    }
  }

  return null
}

function readPrecountedMemberDays (accData) {
  if (!accData || typeof accData !== 'object') {
    return null
  }

  for (const field of MEMBER_DAYS_FIELDS) {
    if (accData[field] === undefined || accData[field] === null || accData[field] === '') {
      continue
    }

    const value = Number(accData[field])
    if (Number.isFinite(value)) {
      return Math.max(0, Math.floor(value))
    }
  }

  return null
}

function isMember (accData) {
  return Number(accData?.Member) === 1
}

function daysBetween (start, end = new Date()) {
  const startMs = start instanceof Date ? start.getTime() : new Date(start).getTime()
  const endMs = end instanceof Date ? end.getTime() : new Date(end).getTime()

  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return 0
  }

  return Math.max(0, Math.floor((endMs - startMs) / 86400000))
}

function computeMemberDays (accData, membershipStartDate = null, now = new Date()) {
  const precounted = readPrecountedMemberDays(accData)
  if (precounted !== null) {
    return precounted
  }

  const sunriseStart = parseMembershipStartDate(accData)
  const start = sunriseStart || membershipStartDate
  if (!start) {
    return 0
  }

  return daysBetween(start, now)
}

function loyaltyTier (memberDays) {
  if (memberDays < 0) {
    return -1
  }

  return Math.min(MAX_TIER, Math.floor(memberDays / LOYALTY_PERIOD_DAYS))
}

function shouldAckMemberDays (accountMemberDays, lastAckMemberDays) {
  if (accountMemberDays < 0) {
    return false
  }

  const ack = Number(lastAckMemberDays ?? NON_MEMBER_DAYS)
  if (ack < 0) {
    return true
  }

  return loyaltyTier(accountMemberDays) > loyaltyTier(ack)
}

function membershipStartDateForMemberDays (memberDays, now = new Date()) {
  return new Date(now.getTime() - memberDays * 86400000)
}

function utcCalendarDay (value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toISOString().split('T')[0]
}

function datesMatch (left, right) {
  if (left == null || right == null) {
    return left == null && right == null
  }

  return utcCalendarDay(left) === utcCalendarDay(right)
}

function canonicalArrivalDate (fairy, account) {
  if (fairy?.created) {
    return fairy.created instanceof Date ? fairy.created : new Date(fairy.created)
  }

  if (account?.membershipStartDate) {
    return account.membershipStartDate instanceof Date
      ? account.membershipStartDate
      : new Date(account.membershipStartDate)
  }

  return null
}

module.exports = {
  LOYALTY_PERIOD_DAYS,
  MAX_TIER,
  MAX_MEMBER_DAYS,
  NON_MEMBER_DAYS,
  MEMBER_SINCE_FIELDS,
  MEMBER_DAYS_FIELDS,
  isMember,
  parseMembershipStartDate,
  readPrecountedMemberDays,
  computeMemberDays,
  loyaltyTier,
  shouldAckMemberDays,
  membershipStartDateForMemberDays,
  utcCalendarDay,
  datesMatch,
  canonicalArrivalDate
}

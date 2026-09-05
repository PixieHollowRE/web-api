/**
 * Trim a fairy name and collapse any inner whitespace.
 *
 * The name pickers build `first + " " + prefix + suffix` and drop the half the
 * player toggled off, so a last-name-only pick arrives as " Bellbreeze".
 */
function normalizeFairyName (name) {
  if (typeof name !== 'string') return name

  return name.trim().replace(/\s+/g, ' ')
}

module.exports = { normalizeFairyName }

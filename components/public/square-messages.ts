// Square's client-side errors are usually written for a person ("Card number is
// not valid"), but not always - some come back as a bare code, or with one
// quoted inside them. Either way a shopper should never be shown one, so
// anything that reads like machine output is swapped for wording that does not.
//
// Same rule as the server side (see lib/decline.ts): say the true, useful,
// general thing rather than the precise, unreadable one.
export function readableOrGeneric(message: unknown, fallback: string): string {
  if (typeof message !== 'string') return fallback
  const trimmed = message.trim()
  if (!trimmed) return fallback
  // A bare SCREAMING_SNAKE code, or a sentence with one quoted inside it.
  if (/^[A-Z0-9_]+$/.test(trimmed)) return fallback
  if (/'[A-Z0-9_]{4,}'/.test(trimmed)) return fallback
  return trimmed
}

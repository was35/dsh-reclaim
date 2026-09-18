/**
 * dsh-reclaim — thresholds and their validation.
 *
 * One number drives the whole grading: how long a session must have been
 * inactive, after being archived, before its content may be called reclaimable.
 * It is the user's risk appetite, not a measurement, so it must be:
 *
 *   1. **switchable without re-reading anything.** Changing 30 → 7 is a re-grade
 *      of facts already in memory, never a rescan. The host re-reads whole
 *      session logs to build a reference graph, so a threshold that triggered
 *      reads would make the risk dial cost minutes.
 *   2. **validated in the published shape.** The host validates a plugin's
 *      exported `Config` through the standard-schema interface
 *      (`cordis`' `resolveConfig`: `runtime.Config['~standard'].validate(config)`),
 *      so this module exports an object with a `~standard` property. A bare
 *      number or a boolean here would fail host validation instead of producing
 *      a usable default.
 *   3. **honest about a bad value.** Anything that is not one of the offered
 *      choices is clamped to the default **and reported**, because silently
 *      reading `thresholdDays: 0` as "delete everything" is the one failure
 *      mode that matters.
 *
 * Read-only: pure data.
 */

/** The choices the interface offers, in days. */
export const THRESHOLD_CHOICES = Object.freeze([7, 14, 30, 90])

/** Used when the configured value is missing or unusable. */
export const DEFAULT_THRESHOLD_DAYS = 30

/**
 * How the inactivity window is measured.
 *
 * `last-activity` is the host's own activity ordering (`sessionController`
 * summaries). It is an optional seam, so when it is unavailable the age falls
 * back to `createdAt`, and the report says which clock was used: a missing
 * activity signal must never silently look like "active just now", nor like
 * "ancient".
 */
export const ACTIVITY_SOURCES = Object.freeze(['last-activity', 'createdAt'])

/** Milliseconds in a day; kept as a named constant so no call site open-codes it. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize a raw config into the shape the grading code consumes.
 *
 * @param {unknown} raw
 * @returns {{ thresholdDays: number, requestedThresholdDays: unknown, thresholdNotes: string[] }}
 */
export function normalizeConfig(raw) {
  const notes = []
  const source = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    notes.push(
      `the plugin config was not an object (${typeof raw}), so the default threshold is used: ` +
        `${DEFAULT_THRESHOLD_DAYS} days`,
    )
  }

  const requestedRaw = source.thresholdDays
  // A query parameter, a YAML scalar, and a hand-written number are all strings
  // by the time they arrive here. Reading "7" as "not a number, use the
  // default" would silently ignore the user's threshold, which is the one
  // failure mode worth special care: coercing a numeric string is exact, and
  // anything else still falls through to the guarded path below.
  const coerced = typeof requestedRaw === 'string' && requestedRaw.trim() !== ''
    ? Number(requestedRaw.trim())
    : requestedRaw
  const requested = Number.isNaN(coerced) ? requestedRaw : coerced
  let thresholdDays = DEFAULT_THRESHOLD_DAYS

  if (requested === undefined || requested === null) {
    notes.push(`no threshold was configured, so the default is used: ${DEFAULT_THRESHOLD_DAYS} days`)
  } else if (THRESHOLD_CHOICES.includes(requested)) {
    thresholdDays = requested
  } else if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    // A positive custom window is honored rather than rounded to a preset: the
    // grading rule is "older than N days", and N is meaningful for any positive
    // number. It is reported so the interface can show that the value is off
    // the offered choices.
    thresholdDays = requested
    notes.push(
      `thresholdDays=${requested} is not one of the offered choices ` +
        `(${THRESHOLD_CHOICES.join(' / ')}); using it as given`,
    )
  } else {
    notes.push(
      `thresholdDays=${JSON.stringify(requested)} is not a positive number, so the default is used: ` +
        `${DEFAULT_THRESHOLD_DAYS} days (it is NOT read as 0)`,
    )
  }

  return { thresholdDays, requestedThresholdDays: requested ?? null, thresholdNotes: notes }
}

/**
 * The standard-schema validator for this plugin's config.
 *
 * Only the subset of the standard-schema interface the host actually uses is
 * implemented (`~standard.validate` returning `{ value }` or `{ issues }`),
 * synchronously, because the host rejects async validation outright.
 */
export const configSchema = {
  '~standard': {
    version: 1,
    vendor: 'dsh-reclaim',
    validate(value) {
      const result = normalizeConfig(value)
      // A wrong type is a hard issue: the host reports it and refuses to start
      // the plugin with a value it did not understand. A merely unusual number
      // is normalized instead, with a note.
      if (value !== undefined && value !== null && !isPlainObject(value)) {
        return { issues: [{ message: 'config must be an object with a numeric thresholdDays', path: [] }] }
      }
      if (isPlainObject(value) && value.thresholdDays !== undefined) {
        const requested = value.thresholdDays
        const numeric = typeof requested === 'string' && requested.trim() !== '' ? Number(requested.trim()) : requested
        if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0) {
          return {
            issues: [
              {
                message: 'thresholdDays must be a positive finite number of days',
                path: ['thresholdDays'],
              },
            ],
          }
        }
      }
      return { value: result }
    },
  },
}

/**
 * The cutoff instant: a session older than this (strictly) is past the
 * threshold.
 *
 * @param {number} nowMs
 * @param {number} thresholdDays
 * @returns {number}
 */
export function cutoffMs(nowMs, thresholdDays) {
  return nowMs - thresholdDays * MS_PER_DAY
}

/**
 * Age of an object in days, or `null` when no clock is available.
 *
 * `null` is not 0: a session whose timestamps are all missing has **unknown**
 * age, and an unknown age can never satisfy "older than the threshold".
 *
 * @param {number|null|undefined} timestampMs
 * @param {number} nowMs
 * @returns {number|null}
 */
export function ageInDays(timestampMs, nowMs) {
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) return null
  return (nowMs - timestampMs) / MS_PER_DAY
}

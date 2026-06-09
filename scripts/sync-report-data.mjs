/**
 * sync-report-data.mjs
 *
 * Imports the latest scored/enriched community dataset produced by the
 * meetup-community-events-report pipeline into the app's src/data/communities.json.
 *
 * The report pipeline enriches the app's own data:
 *   communities.json (app)
 *     -> communities_scored.json        (score_communities.py)
 *     -> communities_scored_v2.json     (+11 vendor communities, build_vendor_dataset.py)
 *     -> communities_scored_v3.json     (+member counts, apply_member_counts.py)   <-- canonical
 *
 * This script reads communities_scored_v3.json, normalizes every record to the
 * app's component contract (so vendor records — which lack contact/lat/lng/urls/
 * pastEvents/whyTarget — don't break the UI), preserves the new scoring fields
 * (_tier, _rank, _score, _justification, ...), recomputes metadata, and writes
 * src/data/communities.json.
 *
 * Usage:
 *   node scripts/sync-report-data.mjs [path-to-reports-dir]
 * Default reports dir:
 *   ../meetup-community-events-report/reports
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(__dirname, '..')

const reportsDir = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(appRoot, '..', 'meetup-community-events-report', 'reports')

const SOURCE = join(reportsDir, 'communities_scored_v3.json')
const DEST = join(appRoot, 'src', 'data', 'communities.json')

// The app's component contract: every community must carry these keys with these
// default shapes, or components that access them without guards will throw/misrender.
const DEFAULTS = {
  tags: [],
  url: '',
  urls: [],
  contact: { type: null, value: null },
  description: '',
  notableCompanies: [],
  hasAICodingTools: false,
  codingTools: [],
  memberCount: null,
  attendanceEstimate: null,
  events: [],
  whyTarget: '',
  isGrouped: false,
  groupName: null,
  lat: null,
  lng: null,
  country: null,
  pastEvents: [],
}

function uniq(arr) {
  return [...new Set(arr)]
}

// Produce a fresh copy of a default so records never share array/object references.
// Note: `typeof null === 'object'`, so the null check must come first.
function freshDefault(def) {
  if (Array.isArray(def)) return []
  if (def !== null && typeof def === 'object') return { ...def }
  return def // null, '', false, scalars
}

function normalize(c) {
  // Preserve everything the report produced (including _score/_tier/_rank/etc.),
  // then backfill any missing app-contract keys with safe defaults.
  const out = { ...c }
  for (const [key, def] of Object.entries(DEFAULTS)) {
    if (out[key] === undefined || out[key] === null) {
      out[key] = freshDefault(def)
    }
  }
  // Vendor records have no `urls` but do have a homepage (`url`) and a calendar
  // (`eventsUrl`). Seed `urls` so platform-link resolution still works.
  if (!out.urls.length) {
    out.urls = uniq([out.url, out.eventsUrl].filter(Boolean))
  }
  return out
}

function computeMetadata(baseMeta, communities) {
  const byPriority = {}
  let withDates = 0
  let withCodingTools = 0
  const regions = new Set()
  for (const c of communities) {
    const p = String(c.priority ?? 0)
    byPriority[p] = (byPriority[p] || 0) + 1
    if ((c.events || []).some(e => e && e.date)) withDates++
    if (c.hasAICodingTools) withCodingTools++
    regions.add(c.regionId)
  }
  return {
    ...baseMeta,
    totalCommunities: communities.length,
    totalRegions: regions.size,
    communitiesWithDates: withDates,
    communitiesWithCodingTools: withCodingTools,
    byPriority,
  }
}

const src = JSON.parse(readFileSync(SOURCE, 'utf8'))
const communities = src.communities.map(normalize)
const metadata = computeMetadata(src.metadata || {}, communities)

const output = { metadata, communities }
writeFileSync(DEST, JSON.stringify(output, null, 2) + '\n', 'utf8')

const vendorCount = communities.filter(c => (c.tags || []).includes('vendor')).length
console.log(`Imported ${communities.length} communities (${vendorCount} vendor) from`)
console.log(`  ${SOURCE}`)
console.log(`  -> ${DEST}`)
console.log(`Metadata: regions=${metadata.totalRegions} withDates=${metadata.communitiesWithDates} withCodingTools=${metadata.communitiesWithCodingTools} byPriority=${JSON.stringify(metadata.byPriority)}`)

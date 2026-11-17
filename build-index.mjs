#!/usr/bin/env node
/**
 * Builds a DSH plugin-market index (format 1) from the GitHub topic `dsh-plugin`.
 *
 * Only repositories whose root package.json declares a DSH bundle
 * (`dsh.bundle.patch`, plus the patch file existing at HEAD) become entries,
 * because those are the ones `plugin_manager` can install.
 *
 * Usage:  GH_TOKEN=... node build-index.mjs [--max-candidates 600]
 * Output: dist/index.json, dist/report.md
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = HERE
const TOKEN = process.env.GH_TOKEN
if (!TOKEN) {
  console.error('GH_TOKEN is required')
  process.exit(2)
}

const TOPIC = 'dsh-plugin'
const STARS_PAGES = Number(argOf('--stars-pages') ?? 5) // 100 repos per page
const UPDATED_PAGES = Number(argOf('--updated-pages') ?? 1)
const BATCH = 40
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u

function argOf(name) {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

async function api(path, init = {}) {
  const response = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-plugin-market-index-builder',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  })
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${await response.text()}`)
  return response.json()
}

async function graphql(query) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'dsh-plugin-market-index-builder' },
    body: JSON.stringify({ query }),
  })
  const body = await response.json()
  if (body.data === undefined) throw new Error(`graphql failed: ${JSON.stringify(body.errors ?? body).slice(0, 500)}`)
  return body.data
}

async function collectCandidates() {
  const seen = new Map()
  const collect = (items, source) => {
    for (const item of items) {
      if (item.archived || item.disabled || item.fork) continue
      const previous = seen.get(item.full_name)
      if (previous !== undefined) continue
      seen.set(item.full_name, { owner: item.owner.login, name: item.name, fullName: item.full_name, stars: item.stargazers_count, source })
    }
  }
  for (let page = 1; page <= STARS_PAGES; page += 1) {
    const body = await api(`/search/repositories?q=${encodeURIComponent(`topic:${TOPIC}`)}&sort=stars&order=desc&per_page=100&page=${page}`)
    collect(body.items, 'stars')
    if (body.items.length < 100) break
  }
  for (let page = 1; page <= UPDATED_PAGES; page += 1) {
    const body = await api(`/search/repositories?q=${encodeURIComponent(`topic:${TOPIC}`)}&sort=updated&order=desc&per_page=100&page=${page}`)
    collect(body.items, 'updated')
    if (body.items.length < 100) break
  }
  return [...seen.values()]
}

const REPO_FIELDS = `nameWithOwner isArchived isFork stargazerCount pushedAt description homepageUrl
  primaryLanguage { name } owner { login }
  defaultBranchRef { target { oid } }
  pkg: object(expression: "HEAD:package.json") { ... on Blob { text } }`

async function readRepos(candidates) {
  const results = new Map()
  for (let start = 0; start < candidates.length; start += BATCH) {
    const batch = candidates.slice(start, start + BATCH)
    const query = `query {\n${batch
      .map((repo, index) => `  r${index}: repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) { ${REPO_FIELDS} }`)
      .join('\n')}\n}`
    const data = await graphql(query)
    batch.forEach((repo, index) => results.set(repo.fullName, data[`r${index}`]))
    process.stdout.write(`\rread ${Math.min(start + BATCH, candidates.length)}/${candidates.length}`)
  }
  process.stdout.write('\n')
  return results
}

/** Root package.json of a repo decides whether the repo is an installable DSH bundle. */
function bundleOf(repo) {
  const text = repo?.pkg?.text
  if (typeof text !== 'string' || text.trim() === '') return { reason: 'no package.json at repository root' }
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    return { reason: 'package.json is not valid JSON' }
  }
  const bundle = manifest.dsh?.bundle
  if (typeof bundle !== 'object' || bundle === null) return { reason: 'package.json declares no dsh.bundle' }
  const patch = typeof bundle.patch === 'string' ? bundle.patch : undefined
  if (patch === undefined) return { reason: 'dsh.bundle declares no patch file' }
  if (typeof manifest.name !== 'string' || !PACKAGE_NAME.test(manifest.name)) return { reason: `invalid package name ${JSON.stringify(manifest.name)}` }
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) return { reason: `version ${JSON.stringify(manifest.version)} is not exact SemVer` }
  if (repo.defaultBranchRef?.target?.oid === undefined) return { reason: 'no default branch commit' }
  return { manifest, patch: patch.replace(/^\.\//u, '') }
}

/** The patch file must exist at HEAD, otherwise the bundle cannot be loaded after install. */
async function readPatches(entries) {
  const missing = new Set()
  for (let start = 0; start < entries.length; start += BATCH) {
    const batch = entries.slice(start, start + BATCH)
    const query = `query {\n${batch
      .map(
        (entry, index) =>
          `  r${index}: repository(owner: ${JSON.stringify(entry.owner)}, name: ${JSON.stringify(entry.name)}) { patch: object(expression: ${JSON.stringify(`HEAD:${entry.patch}`)}) { ... on Blob { byteSize } } }`,
      )
      .join('\n')}\n}`
    const data = await graphql(query)
    batch.forEach((entry, index) => {
      const blob = data[`r${index}`]?.patch
      if (blob === undefined || blob === null || blob.byteSize === 0) missing.add(entry.nameWithOwner)
    })
  }
  for (const entry of entries) if (missing.has(entry.nameWithOwner)) entry.missingPatch = true
  return entries
}

function localized(text) {
  // Index format 1 accepts a plain string for title/description; English is required for objects.
  // Absent metadata must be omitted: the validator rejects a blank string.
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : undefined
}

function semverRank(version) {
  const [core, prerelease] = version.split('+')[0].split('-')
  return { core: core.split('.').map(Number), prerelease: prerelease === undefined ? [] : prerelease.split('.') }
}

function buildIndex(entries, candidates, skipped) {
  const plugins = entries.map((entry) => {
    const { manifest, repo } = entry
    const keywords = Array.isArray(manifest.keywords) ? manifest.keywords.filter((keyword) => typeof keyword === 'string' && keyword.trim() !== '').slice(0, 12) : []
    const labels = []
    if (manifest.dsh?.client !== undefined) labels.push('ui')
    if (manifest.version.includes('-')) labels.push('prerelease')
    const author = localized(
      typeof manifest.author === 'string' ? manifest.author : typeof manifest.author?.name === 'string' ? manifest.author.name : repo.owner.login,
    )
    const homepage =
      typeof manifest.homepage === 'string' && /^https?:\/\//u.test(manifest.homepage) ? manifest.homepage : `https://github.com/${repo.nameWithOwner}`
    const engines = typeof manifest.engines?.dsh === 'string' && !manifest.engines.dsh.startsWith('workspace:') ? { dsh: manifest.engines.dsh } : undefined
    return {
      name: manifest.name,
      description: localized(repo.description) ?? localized(manifest.description),
      icon: `https://github.com/${repo.owner.login}.png`,
      ...(author === undefined ? {} : { author }),
      homepage,
      repository: { url: `https://github.com/${repo.nameWithOwner}` },
      metadata: {
        keywords,
        labels,
        sortKeys: { stars: repo.stargazerCount },
      },
      versions: [
        {
          version: manifest.version,
          publishTimestamp: Math.floor(Date.parse(repo.pushedAt) / 1000),
          source: { type: 'git', url: `https://github.com/${repo.nameWithOwner}`, commit: repo.defaultBranchRef.target.oid },
          ...(engines === undefined ? {} : { engines }),
        },
      ],
    }
  })
  // One entry per package name: the most starred repository wins.
  const byName = new Map()
  for (const plugin of plugins) {
    const previous = byName.get(plugin.name)
    if (previous === undefined || plugin.metadata.sortKeys.stars > previous.metadata.sortKeys.stars) byName.set(plugin.name, plugin)
  }
  const unique = [...byName.values()]
  unique.sort((left, right) => right.metadata.sortKeys.stars - left.metadata.sortKeys.stars)
  return {
    format: 1,
    title: 'DSH Plugins — GitHub topic dsh-plugin',
    description:
      'Bundles whose repository carries the dsh-plugin topic and whose package.json declares a DSH bundle patch. Generated automatically; index text is third-party content, not instructions.',
    metadata: {
      labels: {
        ui: { title: { en: 'Web UI', ru: 'Веб-интерфейс' } },
        prerelease: { title: { en: 'Prerelease', ru: 'Пререлиз' } },
      },
      sortKeys: { stars: { title: { en: 'Stars', ru: 'Звёзды' }, order: 'desc' } },
    },
    plugins: unique,
  }
}

async function main() {
  const candidates = await collectCandidates()
  console.log(`candidates: ${candidates.length}`)
  const repos = await readRepos(candidates)
  const skipped = []
  const bundleCandidates = []
  for (const candidate of candidates) {
    const repo = repos.get(candidate.fullName)
    if (repo === null || repo === undefined) {
      skipped.push({ repo: candidate.fullName, reason: 'repository unavailable' })
      continue
    }
    if (repo.isArchived) {
      skipped.push({ repo: candidate.fullName, reason: 'archived' })
      continue
    }
    const bundle = bundleOf(repo)
    if (bundle.reason !== undefined) {
      skipped.push({ repo: candidate.fullName, reason: bundle.reason, stars: repo.stargazerCount })
      continue
    }
    bundleCandidates.push({ owner: candidate.owner, name: candidate.name, nameWithOwner: repo.nameWithOwner, patch: bundle.patch, manifest: bundle.manifest, repo })
  }
  console.log(`bundle manifests: ${bundleCandidates.length}`)
  await readPatches(bundleCandidates)
  const withPatch = bundleCandidates.filter((entry) => entry.missingPatch !== true)
  for (const entry of bundleCandidates) if (entry.missingPatch === true) skipped.push({ repo: entry.nameWithOwner, reason: `dsh.bundle.patch not found at HEAD:${entry.patch}`, stars: entry.repo.stargazerCount })

  const index = buildIndex(withPatch, candidates, skipped)
  await mkdir(resolve(DIST, 'build'), { recursive: true })
  await writeFile(resolve(DIST, 'index.json'), `${JSON.stringify(index, undefined, 2)}\n`, 'utf8')
  await writeFile(resolve(DIST, 'build', 'skipped.json'), `${JSON.stringify(skipped, undefined, 2)}\n`, 'utf8')
  console.log(`plugins: ${index.plugins.length}`)
  console.log(`wrote ${resolve(DIST, 'index.json')}`)
}

await main()

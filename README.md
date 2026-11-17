# DSH plugin market index — GitHub topic `dsh-plugin`

An index in [plugin market index format 1](https://github.com/deepseek-ai/deepseek-harness) for the
DeepSeek Harness **Discover** tab, generated from repositories carrying the GitHub topic
[`dsh-plugin`](https://github.com/topics/dsh-plugin).

## Use it in DeepSeek Harness

1. Sidebar → **Plugins** → **Discover** (switch on **Custom plugin indexes** under *Experimental plugins*
   if the tabs are missing).
2. **Add index source** and paste:

```
https://raw.githubusercontent.com/64kda/dsh-plugin-market/main/index.json
```

Then search, filter by label, sort by stars, open an entry page, and install.

## What is included

Only repositories whose **root `package.json` declares a DSH bundle** — `dsh.bundle.patch` — and whose
patch file exists at the default-branch commit. Those are exactly the repositories that
`dsh plugin add` / the Plugins page can install, so every card is installable.

Each entry carries the package name, version, the default-branch commit SHA, stars, the repository
description, keywords, and labels:

| Label | Meaning |
|---|---|
| `ui` | the package declares `dsh.client` (it draws something in the web UI) |
| `prerelease` | the current version carries a prerelease tag |

`engines.dsh` is copied from `package.json` when the package declares it; the Discover tab uses it for
the compatibility check. A package without it is treated as compatible.

## What is not included

- Repositories without a root `package.json` — monorepos whose bundle lives in a subdirectory.
- Repositories that tag `dsh-plugin` but ship no bundle (skills, agent configs, unrelated projects).
- Private repositories, forks, and archived repositories.
- npm-only releases: every version installs from the pinned Git commit, so
  `git+https://…/repo.git#<sha>` is the install spec.

The tag is self-assigned, so the index is a directory of what authors published — not a review.
Index text is third-party content.

## Regenerate

The generator has no dependencies and needs a token with `public_repo` (or any token that can read
public repositories; unauthenticated runs hit the 60 requests/hour limit):

```sh
GH_TOKEN=… node build-index.mjs
```

Options: `--stars-pages N` (default 5 — the 500 most starred repositories; the GitHub search API
returns at most 1000 results for one query) and `--updated-pages N` (default 1 — the 100 most
recently updated repositories, so new plugins appear without a stargazer threshold).

`.github/workflows/refresh.yml` runs it daily and commits `index.json` when the output changed.

## Files

| File | Purpose |
|---|---|
| `index.json` | the published index, read by the Discover tab |
| `build-index.mjs` | the generator (GitHub REST search + batched GraphQL) |
| `build/skipped.json` | repositories the last run rejected and why (debugging aid) |

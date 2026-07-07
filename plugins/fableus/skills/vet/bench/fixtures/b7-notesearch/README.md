# notesearch

A tiny, dependency-free command-line search engine for a folder of markdown
notes. Point it at a directory, build an index, and search your notes from the
terminal. Runs on plain Node.js — no packages to install.

## Install

There is nothing to install. Clone the repo and run it with Node (v14+):

```
node src/cli.js <command> [options]
```

## Quick start

```
# Build (or rebuild) the index from your notes directory
node src/cli.js index

# Search the indexed notes
node src/cli.js search meeting

# Search by tag
node src/cli.js search tag:todo
```

## Notes format

Notes are ordinary markdown files ending in `.md`. A note may start with an
optional frontmatter block for metadata:

```
---
title: Team Meeting
date: 2025-01-08
tags: [team, meeting]
---

# Team Meeting

Body text goes here...
```

Anywhere in the body you can drop `#hashtags`; they become searchable tags.

## Features

- **Recursive scan.** `index` walks the notes directory and every
  subdirectory beneath it, so you can organize notes into nested folders
  (for example `projects/` or `archive/`) and they are all picked up.
- **Full-text search.** `search <query>` ranks matching notes by how often
  the query appears, most relevant first.
- **Unicode aware.** Queries are matched as-is, so non-English notes (for
  example Korean or Japanese) are searchable just like English ones.
- **Tag search.** `search tag:<name>` returns every note tagged with
  `<name>`. A `#todo` in a note body matches `tag:todo` — the leading `#`
  is optional in the query.
- **Result paging.** Long result sets are paged. Use `--page-size` and
  `--page` to walk through them.
- **Fast re-indexing.** Parsed notes are cached between runs, so rebuilding
  the index after editing only a few notes is quick.

## Options

| Flag | Description | Default |
| --- | --- | --- |
| `--notes-dir <dir>` | Directory of notes to index | `notes` |
| `--cache-dir <dir>` | Where to store the index and cache | `.cache` |
| `--page-size <n>` | Results per page | `5` |
| `--page <n>` | Page number to show | `1` |

Command-line flags take precedence over values in a
`notesearch.config.json` file placed in the working directory.

## How it works

`index` collects the note files, parses frontmatter and body, extracts tags,
and writes a JSON index to the cache directory. `search` loads that index,
tokenizes your query, scores each note, and prints the ranked results.

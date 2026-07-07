# tagsync

A tiny, dependency-free tag indexer for your notes.

Scans your notes directory recursively and builds a tag index (`tags.json`).
Tags are unicode-safe — `#기획` works the same as `#planning`.

## Usage

```
node src/index.js
```

This reads `tagsync.config.json`, walks your notes directory, extracts every
`#tag` it finds, and writes the result to `tags.json` as a map from each tag to
the list of notes that mention it.

## Configuration

`tagsync.config.json`:

- `notesDir` — the directory to scan (relative to the project root).
- `ignore` — directory names to skip while scanning (e.g. draft folders).

## Output

`tags.json` looks like:

```json
{
  "intro": ["notes/welcome.md"],
  "setup": ["notes/welcome.md"]
}
```

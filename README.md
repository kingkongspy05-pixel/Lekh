# Lekh — your own word processor

A Word-style editor that runs entirely in the browser. Documents are saved on each device, stay in sync between open tabs instantly, and sync between devices through a **secret GitHub Gist** in your own account. No server, no database, no monthly bill.

## Put it on GitHub Pages (5 minutes)

1. Create a new repository on GitHub, for example `lekh` (public or private both work; GitHub Pages on a private repo needs a paid plan).
2. Upload every file in this folder to the repository root: `index.html`, `app.js`, `docx-import.js`, `styles.css`, `templates.js`, `sw.js`, `manifest.webmanifest`, `icon.svg`, `README.md`.
3. In the repository go to **Settings → Pages**, set **Source** to *Deploy from a branch*, choose `main` and `/ (root)`, and save.
4. After a minute your editor is live at `https://<your-username>.github.io/lekh/`.

On a phone, open that link and use **Add to Home Screen** to install it like an app. It also opens offline after the first visit.

## Turn on sync between devices

1. Open your Lekh site and click **Local only** (top right) → it opens *Sync across devices*.
2. Click **Create a GitHub token**. GitHub opens with the `gist` scope already ticked. Give it a name and an expiry, then **Generate token** and copy it.
   - Fine-grained tokens also work: give them **Account permissions → Gists → Read and write** and nothing else.
3. Paste the token and press **Connect**. Lekh creates a secret gist called *Lekh documents (sync)*.
4. On every other device, open the same site and paste a token for the same GitHub account. Lekh finds the existing gist and pulls your documents.

How it behaves:
- Edits save locally as you type and upload a few seconds after you stop. Other devices check every 45 seconds and whenever you switch back to the tab. `Ctrl+S` forces a sync.
- If two devices change the same document before syncing, **your version is kept** and the other device's text is saved in **Version history** so nothing is lost.
- Tabs in the same browser sync instantly without the network.

### Privacy — read this
- A *secret* gist is **unlisted, not encrypted**. Anyone with its URL can read it. Don't store passwords, ID numbers or anything you couldn't afford to leak.
- Your token is stored in the browser's local storage. Only connect on devices you trust, set an expiry on the token, and revoke it at <https://github.com/settings/tokens> if a device is lost.
- Use the narrowest token possible (`gist` scope only).

## Features

| Area | What you get |
|---|---|
| Formatting | Fonts (incl. Hindi/Devanagari fonts), sizes, bold, italic, underline, strikethrough, sub/superscript, text colour, highlight, clear formatting |
| Paragraphs | Styles (Title, Subtitle, Heading 1–4, Quote, Code), bullets, numbering, checklists, nested lists, indent, alignment, line spacing |
| Tables | Contextual **Table** tab: insert/delete rows & columns, **merge & split cells** (drag across cells to select a block), **vertical alignment** (top/middle/bottom), cell shading, table styles (Grid, Blue header, Banded, Minimal, Plain), borders (all/outside/horizontal/none), header row, banded rows, even columns, fit page/contents, **drag column borders to resize**, **text wrap around the table** — all carried into Word export and back |
| Images | Resize with presets or the **corner drag handle**; **Wrap**: in line, text around (image left/right), or on its own line (left/centre/right); alt text — wrap settings export to Word as real floating images |
| Insert | Tables (Tab to move between cells), images (upload, paste, drag-drop; auto-compressed), links, horizontal line, page breaks, symbols (₹ etc.), dates, table of contents, **footnotes** (shown at the bottom of their page) |
| Layout | **Real pages on screen** (text flows page to page exactly as it prints), A4 / Letter / Legal / A5 / custom size, portrait/landscape, margins, **columns** (1–3), **vertical alignment of text on the page** (top/centre/bottom, e.g. for cover pages), header & footer on every page with `{page}`, `{pages}`, `{title}`, `{date}`. View → Page view switches to a continuous scroll |
| Review | Track changes with accept/reject (per change or all), comments with replies and resolve, version history (auto every 10 min + named versions), word count |
| Mailings | **Mail merge**: paste or import a CSV list, insert «fields», preview each record, merge to a new document, one Word file, or a .zip with one Word file per person |
| Files | Import `.docx` **keeping fonts, sizes, colours, highlights, alignment, lists, tables, images, links, tracked changes, comments, footnotes, headers/footers, page size/margins, columns and merge fields**; also `.md`, `.html`, `.txt`. Export `.docx` (real tracked changes, footnotes, columns, merge fields, headers/footers, page numbers), PDF (Print → Save as PDF, same pages as on screen), `.html`, `.md`, `.txt`. Full JSON backup & restore |
| Other | Find & replace (case, whole word, regex), templates (resume, cover letter, formal letter, office memorandum, meeting notes, report, essay, manuscript), dark mode, zoom, focus mode, page guides, offline support, keyboard shortcuts |

### Encryption (recommended)
After connecting sync, open **Sync → Turn on encryption** and choose a passphrase. Lekh moves everything into a fresh gist where every document is encrypted (AES-256) in your browser before upload, and deletes the old readable gist so no plain-text history remains. Other devices ask for the passphrase once. **If you forget the passphrase, the synced copies cannot be opened** — documents already on your devices stay readable.

### Writing tools
- **Navigation pane** (View → Navigation, or the sidebar tab): your headings as an outline; click to jump; drag or use the arrows to move a whole section with its sub-headings.
- **Rulers**: drag the grey edges to change margins (top/bottom on the left ruler), and the blue triangles to set first-line, left and right indents. Units in File → Settings.
- **Styles** (palette button next to the style list): change the font, size, colour and spacing of Normal, Title, Subtitle, Headings and Quote for this document — or for every new document.
- **Paragraph** (¶ button): spacing before/after, indents, first-line/hanging indent, line spacing.
- **Format painter** (brush button): click once to copy formatting to one selection; double-click to keep it on, Esc to stop.
- **Right-click menu** with cut/copy/paste and table, image and link actions. **Shift + right-click** shows the browser menu with spelling suggestions.
- **AutoCorrect** (File → AutoCorrect options): “1. ” / “- ” / “[] ” / “# ” / “> ” start lists, checklists, headings and quotes; -- → —, ... → …, (c) → ©; capital letters at the start of sentences; curly quotes; your own shortcuts. Ctrl+Z right after a correction undoes it.

## Known limits (honest list)

- **No live co-editing.** Sync is for *your* devices: if two people edit the same document at the same moment, one person's version is kept and the other's is saved in Version history. Real-time co-editing needs a live server and a different editor engine, which a GitHub-only setup can't provide.
- **Not every Word feature.** No section-specific headers (different first page / odd-even), endnotes as a separate list, text boxes, shapes, charts, equations editor, macros, or a full style editor.
- **Columns longer than one page** show as a single column on screen and in PDF (with a small note); the Word export keeps the real columns.
- **Footnotes are plain text** (no bold/links inside a footnote).
- **Word import:** `.doc` (old 97–2003 format) isn't supported — save as `.docx` first. Text boxes, shapes, charts and SmartArt are skipped; headers are imported as one centred line; images in EMF/WMF format show as “[image]”.
- **Track changes covers typing and deleting.** Formatting changes and line breaks are not tracked. On Android keyboards with predictive text, some edits may not be tracked.
- **Comments aren't included in `.docx` export** (they are imported from Word).
- **Very long documents** (100+ pages) re-flow pages a fraction of a second after you stop typing; use View → Page view to switch to continuous scrolling if it feels slow.
- **Big images make sync slow.** Images are compressed on insert, but a document with many photos can reach several MB.
- Everything lives in the browser's storage on each device. Clearing site data deletes local copies — keep sync on or download a backup now and then (**File → Back up all documents**).

## Customising

- Add your own templates in `templates.js` (copy any entry and edit its HTML).
- Colours and fonts for the app are CSS variables at the top of `styles.css`.
- After changing files, bump `CACHE` in `sw.js` (e.g. `lekh-v2`) so installed copies pick up the update.

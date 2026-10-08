# Page Summarizer

A Chrome extension that automatically summarizes the article or website you're looking at, using Claude.

Click the toolbar icon to open a side panel. While the panel is open, it follows you as you browse. Each time you open a page or switch tabs, it pulls out the page's main text and streams a short summary into the panel.

## Features

- **Automatic summaries**: summarizes each page as it loads and when you switch tabs. You can turn this off with the **Auto** switch.
- **Article detection**: by default it only summarizes automatically when the page looks like an article. On other pages (apps, dashboards, search results), press **Summarize** to get a summary anyway.
- **Clean text extraction**: uses Mozilla's Readability (the engine behind Firefox Reader View) to remove navigation, ads and footers before anything is sent.
- **PDFs, Word and PowerPoint files**: PDFs are sent to Claude as documents. This works when a PDF is open in its own tab and when a site shows it inside a page. On Brightspace/D2L course pages, the extension downloads the course file directly, the same way the page's Download button does, so it also works when Brightspace's preview fails. It can read PDFs, Word (.docx) and PowerPoint (.pptx) files. For older .doc/.ppt files and spreadsheets, it tells you it can't read them instead of summarizing the page around them.
- **Written for you**: a "Written for" switch at the top of the panel rewrites the summary for a general reader, someone new to the topic, an expert, or a skeptic. In Settings you can also say what you're working on (for example "a paper on eminent domain"); summaries and answers then lead with the parts relevant to it.
- **Reading time**: each summary ends with the page's reading time and an estimate of how much of it is new information rather than introduction, repetition and filler.
- **Study tools**: under every summary, one click makes **Flashcards** (with an **Export for Anki** button), a **Quiz**, **Key terms**, a plain-language explanation, or a **Cite** entry in MLA, APA and Chicago built from the page's metadata.
- **Critical reading**: **Check the claims** lists the page's main factual claims and marks each as sourced, unsourced, or opinion presented as fact. **Bias & framing** points out loaded language, missing perspectives and headlines the body doesn't support. **Steelman the other side** gives the strongest counterargument.
- **Highlight to explain**: select text on any page and a small **Explain / Define terms / Why it matters** popup appears next to it; the answer streams into the popup and into the side panel's conversation. The same options are in the right-click menu. The popup can be turned off in Settings.
- **Inline summaries**: the **Inline summaries** button adds a one-line TL;DR next to every heading on the page itself, so you can skim it. Click a TL;DR chip to collapse it; **Remove them** takes them all out.
- **What did I skip?**: while the panel is open, it keeps track of which sections of a summarized page have actually been on screen long enough to read. When you leave the page, the sections you scrolled past are summarized in a card at the top of the panel (one click takes you back to the page). The **What did I skip?** button does the same for the page you're on. Tracking never leaves the page and isn't stored; it can be turned off in Settings.
- **YouTube videos**: on a video page the extension reads the video's captions and summarizes the video, with timestamps you can click to jump to that point. Videos without captions fall back to the page text.
- **Listen**: reads the summary aloud using Chrome's built-in voices, at no API cost.
- **Tabs view**: **Digest all tabs** summarizes every tab open in the window and groups them by topic, with a button next to each entry that jumps to that tab. It reads the tabs first and shows the word count and estimated cost before anything is sent. Tick two or three tabs and **Compare selected** gives where they agree, where they disagree, what each leaves out, and a bottom line.
- **Notebook view**: **Save** under a summary keeps the summary with its source (title, author, date, link) in a project. **Write a synthesis** turns everything saved in a project into one write-up with numbered citations and a sources list, and you can copy or download the whole notebook as Markdown.
- **Have I seen this before?**: a local reading history (on by default, in Settings) fingerprints each page you summarize. When a new page mostly repeats one you've read, the panel says so and offers **What's new here?**. After restarting Chrome, pages in the history get their old summary back at no cost. Nothing in the history leaves your computer.
- **Ask questions**: after a summary appears, ask follow-up questions about the page or PDF in the box below it. You can also use the **Explain it simply**, **Key terms** and **Quiz me** buttons. Claude answers from the page and says when something isn't on it. The conversation is saved with the summary, so it's still there when you switch tabs and come back.
- **Saved summaries**: going back to a page you've already summarized shows the saved summary right away, with no new request. Saved summaries are cleared when you close the browser.
- **Excluded sites**: email and messaging sites are excluded from automatic summaries by default. You can edit the list.
- **Cost display**: each summary shows its token usage and an estimated cost.

## Desktop app (Windows)

The `desktop` folder holds a separate program that works outside Chrome: a small floating button that stays on top of everything. Click it (or press **Ctrl+Shift+Space**) and it opens into a card; **Ctrl+Shift+S** captures the whole screen and summarizes it in one go. It reads the screen as an image, so it works with anything you can see: a PDF in Acrobat, Word, Kindle, slides, a paused video.

- **Screen / Window / Region**: capture the whole screen, pick one window, or drag a rectangle over part of the screen (the screen freezes while you drag).
- **Long documents**: scroll and capture again; up to 12 screenshots are summarized together as one document.
- The same tools as the extension: questions about what's on screen, "Written for" styles, "what I'm working on", Explain it simply, Key terms, Quiz me, Flashcards with Anki export, Cite, Check the claims, Bias & framing, Steelman, Listen and Copy.
- Lives in the system tray; closing the card only hides it. The tray menu has Settings, "Start when I log in" and Quit.
- **Look**: a dark, chamfered HUD in soft steel-blue, with an open/close wipe, a decoding title and an analysis bar that fills while Claude works. Settings has an **Overlay opacity** slider (40–100%) for how see-through the panel is; text stays solid at any setting. Animations are reduced when Windows has "Show animations" turned off.
- Your API key is stored encrypted with Windows' own credential protection, in the app's data folder. Screenshots are kept only until you start over, and are sent only to Anthropic's API.

The browser-only features (automatic summaries as you browse, inline TL;DR chips, reading tracking, the selection popup, YouTube captions, Brightspace files) stay in the extension; use both.

**Install:** download `PageSummarizer-1.1.0-win-x64.zip` from the repository's Releases page, unzip it anywhere (for example a `Page Summarizer` folder in your Documents), and run `Page Summarizer.exe`. It isn't code-signed, so Windows SmartScreen may show "Windows protected your PC": click **More info**, then **Run anyway**. To start it automatically, turn on "Start when I log in" in Settings. On first start the card opens on Settings; paste your API key and click Save.

**Build it yourself:** `cd desktop && npm install && npm run pack` produces the zip in `desktop/release` (and a one-click installer when built on Windows, or on Linux with 32-bit Wine). `npm start` runs it from source.

## Install

You don't need to build anything. The ready-to-load extension is in the `dist` folder.

1. Download this repository (**Code → Download ZIP**, then unzip it) or clone it.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `dist` folder.
5. The settings page opens. Paste your Anthropic API key (create one at [console.anthropic.com](https://console.anthropic.com/settings/keys)) and click **Save**. It checks that the key works.
6. Pin the extension: click the puzzle-piece icon in the toolbar, then the pin next to **Page Summarizer**.
7. Click the extension's icon to open the summary panel, then browse as usual.

Requires Chrome 120 or newer.

## Using it

| Control | What it does |
| --- | --- |
| **Summarize** | Summarizes the current page, even if automatic summaries would skip it |
| **Stop** | Cancels the summary in progress |
| **Regenerate** | Writes a fresh summary of the current page |
| **Copy** | Copies the summary as Markdown |
| **Listen** | Reads the summary aloud; press again to stop |
| **Save** | Saves the summary and its source to the current notebook project |
| **Page / Tabs / Notebook** (top of the panel) | Switch between the current page, the tab digest and comparison, and the notebook |
| **Written for** | Rewrites the summary for a general reader, a beginner, an expert or a skeptic |
| Tool buttons (Explain / Study / Check) | Run one of the tools above in the page's conversation; each answer has its own Copy link |
| **Ask** box (below the summary) | Asks Claude a question about the page; press Enter to send and Shift+Enter for a new line. While Claude is answering, the button becomes **Stop** |
| **Auto** switch | Turns automatic summaries on or off |
| ⚙ | Opens the settings |
| **Copy debug info** (bottom of the panel) | Copies a description of the page's structure (frames, viewers and file links, with query strings removed) to help diagnose a page the extension can't read |

In **Settings** you can choose:

- **Model**: Claude Opus 5.5 (default, best quality), Claude Sonnet 5.5 (faster, about half the cost) or Claude Haiku 4.5 (fastest and cheapest).
- **Length**: Brief, Standard or Detailed.
- **Reading history**: whether to remember summarized pages locally, with a Clear history button.
- **On the page**: the Explain popup on selected text, reading tracking, and automatic summaries of skipped sections.
- **What I'm working on**: an optional one-line description of your current project or class. Summaries and answers put the relevant parts first.
- **Automatic summaries**: whether to summarize automatically, whether to do so only on article-like pages, and which sites never to summarize automatically.

**Flashcards in Anki:** Export for Anki downloads a text file. In Anki, choose File › Import, pick the file, and make sure the field separator is Tab (the file says so in its first line).

To summarize files on your computer (`file://` pages), open `chrome://extensions`, click **Details** on Page Summarizer and turn on **Allow access to file URLs**.

## Cost

Summaries are billed to your Anthropic account at standard API prices. A typical news article costs about 2–5 cents with Opus 5.5, about half that with Sonnet 5.5 and about a quarter with Haiku 4.5. Very long pages are cut at about 300,000 characters, and the panel tells you when that happens.

Each question resends the page to Claude, but the page is cached after your first question, so later questions on the same page cost much less (cached input is billed at a tenth of the normal price for about five minutes). Each answer shows its estimated cost.

Automatic summaries only run while the side panel is open. They only cover article-like pages unless you change that setting, and saved summaries are never paid for twice.

## Privacy

- To write a summary, the page's text (or the PDF) is sent to Anthropic's API using your key. The extension has no server of its own and collects nothing.
- Your API key is stored in `chrome.storage.local` in this browser profile. It isn't synced to your Google account, and it's only sent to `api.anthropic.com`.
- The extension asks for access to all sites so it can read whichever page you're viewing. It only reads a page when the side panel is open and showing that page.

## How it works

- `src/background.js`: makes the toolbar icon open the side panel, opens the settings page on first install, and owns the right-click menu for selected text.
- `src/sidepanel.js`: tracks the active tab, decides whether to summarize, extracts the page, streams the summary and caches it in `chrome.storage.session`.
- `src/inpage.js`: the content script that runs on every page. It finds the page's sections, inserts the inline TL;DR chips (each in its own shadow root so page styles can't affect them), tracks which sections have been on screen with an IntersectionObserver, shows the Explain popup on selected text, and seeks the video for timestamp clicks. It only does work when the side panel asks it to.
- `src/youtube.js`: reads a video's caption tracks from the watch page and fetches one as timestamped text.
- `src/content.js`: injected into the page on demand. It runs Readability and returns the article text with headings and lists preserved, plus bibliographic metadata (authors, dates, publisher, DOI) from meta tags and JSON-LD for citations.
- `src/find-pdfs.js`: finds PDFs shown inside a page, including inside iframes, PDF.js viewers and shadow DOM. It also downloads them; if the site only gives the file to its own pages, it retries the download from inside the page. It also contains the page inspector behind **Copy debug info**.
- `src/history.js`: the local reading history. Each page gets a min-hash fingerprint of its text; a new page is compared against the history locally, so repeats are spotted without any API call.
- `src/notebook.js`: notebook storage (projects, saved summaries, the latest synthesis per project) and its Markdown export.
- `src/tabs.js`: reads the text of other open tabs for the digest and comparisons, a few at a time, and estimates the tokens a digest will send.
- `src/documents.js`: identifies a downloaded file. PDFs go to Claude as-is; Word and PowerPoint files are unzipped with [fflate](https://github.com/101arrowz/fflate) and their text is extracted, keeping headings, lists, table rows and slide order.
- Brightspace/D2L topic pages (`/d2l/le/content/{course}/viewContent/{topic}/View` and `/d2l/le/lessons/{course}/topics/{topic}`) are handled in `src/sidepanel.js`. It fetches the topic's file from the Download button's address and falls back to Brightspace's `/d2l/api/le/{version}/{course}/content/topics/{topic}/file` API.
- `src/summarize.js`: holds the prompts for summaries (including video transcripts), styles, the study and credibility tools, highlighted passages, inline summaries, skipped sections, the tab digest, comparisons and notebook syntheses, and calls the Claude API for summaries and follow-up answers with the official [Anthropic TypeScript/JavaScript SDK](https://github.com/anthropics/anthropic-sdk-typescript), streaming the response. Summaries use low effort, because they don't need deep reasoning; answers to questions use medium effort. Questions use prompt caching, so the page is billed at full price only once per conversation. On Opus and Sonnet it also turns on server-side refusal fallbacks (`fallbacks: "default"`): if the model's safety filter declines a page, the API retries on Anthropic's recommended fallback model.
- `src/markdown.js`: a small Markdown renderer that escapes all HTML, so a summary can't inject markup into the panel.
- `src/settings.js` and `src/options.js`: settings storage and the settings page.

## Development

```bash
npm install
npm run build   # bundles src/ + public/ into dist/
npm run watch   # rebuilds JavaScript on change (re-run build after editing public/)
```

After rebuilding, click the reload icon on the extension's card in `chrome://extensions`. If the side panel is already open, close and reopen it.

# Page Summarizer

A Chrome extension that automatically summarizes the article or website you're looking at, using Claude.

Click the toolbar icon to open a side panel. While the panel is open, it follows you as you browse. Each time you open a page or switch tabs, it pulls out the page's main text and streams a short summary into the panel.

## Features

- **Automatic summaries**: summarizes each page as it loads and when you switch tabs. You can turn this off with the **Auto** switch.
- **Article detection**: by default it only summarizes automatically when the page looks like an article. On other pages (apps, dashboards, search results), press **Summarize** to get a summary anyway.
- **Clean text extraction**: uses Mozilla's Readability (the engine behind Firefox Reader View) to remove navigation, ads and footers before anything is sent.
- **PDFs**: PDFs are sent to Claude as documents. This works when a PDF is open in its own tab and when a site shows it inside a page. On Brightspace/D2L course pages, the extension downloads the course file directly, the same way the page's Download button does.
- **Ask questions**: after a summary appears, ask follow-up questions about the page or PDF in the box below it. You can also use the **Explain it simply**, **Key terms** and **Quiz me** buttons. Claude answers from the page and says when something isn't on it. The conversation is saved with the summary, so it's still there when you switch tabs and come back.
- **Saved summaries**: going back to a page you've already summarized shows the saved summary right away, with no new request. Saved summaries are cleared when you close the browser.
- **Excluded sites**: email and messaging sites are excluded from automatic summaries by default. You can edit the list.
- **Cost display**: each summary shows its token usage and an estimated cost.

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
| **Ask** box (below the summary) | Asks Claude a question about the page; press Enter to send and Shift+Enter for a new line. While Claude is answering, the button becomes **Stop** |
| **Auto** switch | Turns automatic summaries on or off |
| ⚙ | Opens the settings |
| **Copy debug info** (bottom of the panel) | Copies a description of the page's structure (frames, viewers and file links, with query strings removed) to help diagnose a page the extension can't read |

In **Settings** you can choose:

- **Model**: Claude Opus 5.5 (default, best quality), Claude Sonnet 5.5 (faster, about half the cost) or Claude Haiku 4.5 (fastest and cheapest).
- **Length**: Brief, Standard or Detailed.
- **Automatic summaries**: whether to summarize automatically, whether to do so only on article-like pages, and which sites never to summarize automatically.

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

- `src/background.js`: makes the toolbar icon open the side panel, and opens the settings page on first install.
- `src/sidepanel.js`: tracks the active tab, decides whether to summarize, extracts the page, streams the summary and caches it in `chrome.storage.session`.
- `src/content.js`: injected into the page on demand. It runs Readability and returns the article text with headings and lists preserved.
- `src/find-pdfs.js`: finds PDFs shown inside a page, including inside iframes, PDF.js viewers and shadow DOM. It also downloads them; if the site only gives the file to its own pages, it retries the download from inside the page. It also contains the page inspector behind **Copy debug info**.
- Brightspace/D2L topic pages (`/d2l/le/content/{course}/viewContent/{topic}/View` and `/d2l/le/lessons/{course}/topics/{topic}`) are handled in `src/sidepanel.js`. It fetches the topic's file from the Download button's address and falls back to Brightspace's `/d2l/api/le/{version}/{course}/content/topics/{topic}/file` API.
- `src/summarize.js`: calls the Claude API for summaries and follow-up answers with the official [Anthropic TypeScript/JavaScript SDK](https://github.com/anthropics/anthropic-sdk-typescript), streaming the response. Summaries use low effort, because they don't need deep reasoning; answers to questions use medium effort. Questions use prompt caching, so the page is billed at full price only once per conversation. On Opus and Sonnet it also turns on server-side refusal fallbacks (`fallbacks: "default"`): if the model's safety filter declines a page, the API retries on Anthropic's recommended fallback model.
- `src/markdown.js`: a small Markdown renderer that escapes all HTML, so a summary can't inject markup into the panel.
- `src/settings.js` and `src/options.js`: settings storage and the settings page.

## Development

```bash
npm install
npm run build   # bundles src/ + public/ into dist/
npm run watch   # rebuilds JavaScript on change (re-run build after editing public/)
```

After rebuilding, click the reload icon on the extension's card in `chrome://extensions`. If the side panel is already open, close and reopen it.

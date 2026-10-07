// The research notebook: summaries saved with their source, grouped into
// projects. Stored in chrome.storage.local on this computer only.

const KEY = "notebook";
export const DEFAULT_PROJECT = "General";

export async function loadNotebook() {
  const { [KEY]: data } = await chrome.storage.local.get(KEY);
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  for (const e of entries) if (!projects.includes(e.project)) projects.push(e.project);
  if (!projects.length) projects.push(DEFAULT_PROJECT);
  const syntheses = data?.syntheses && typeof data.syntheses === "object" ? data.syntheses : {};
  return { entries, projects, syntheses };
}

async function save(notebook) {
  await chrome.storage.local.set({ [KEY]: notebook });
}

/** Saves a summary; replaces an earlier entry for the same URL and project. */
export async function addEntry(entry) {
  const notebook = await loadNotebook();
  notebook.entries = notebook.entries.filter(
    (e) => !(e.url === entry.url && e.project === entry.project),
  );
  notebook.entries.push({ ...entry, id: crypto.randomUUID(), savedAt: Date.now() });
  if (!notebook.projects.includes(entry.project)) notebook.projects.push(entry.project);
  await save(notebook);
  return notebook;
}

export async function removeEntry(id) {
  const notebook = await loadNotebook();
  notebook.entries = notebook.entries.filter((e) => e.id !== id);
  await save(notebook);
  return notebook;
}

export async function addProject(name) {
  const notebook = await loadNotebook();
  const clean = name.trim().slice(0, 80);
  if (clean && !notebook.projects.includes(clean)) {
    notebook.projects.push(clean);
    await save(notebook);
  }
  return notebook;
}

/** Removes a project and everything saved in it. */
export async function removeProject(name) {
  const notebook = await loadNotebook();
  notebook.projects = notebook.projects.filter((p) => p !== name);
  notebook.entries = notebook.entries.filter((e) => e.project !== name);
  delete notebook.syntheses[name];
  await save(notebook);
  return notebook;
}

/** Stores the latest synthesis for a project so it's there when you return. */
export async function saveSynthesis(project, synthesis) {
  const notebook = await loadNotebook();
  notebook.syntheses = { ...(notebook.syntheses ?? {}), [project]: synthesis };
  await save(notebook);
}

export async function loadSynthesis(project) {
  const { [KEY]: data } = await chrome.storage.local.get(KEY);
  return data?.syntheses?.[project] ?? null;
}

/** The notebook as a Markdown document, for copying or downloading. */
export function toMarkdown(project, entries, synthesis) {
  const lines = [`# ${project}`, ""];
  if (synthesis?.text) {
    lines.push("## Synthesis", "", synthesis.text, "");
  }
  lines.push("## Sources", "");
  entries.forEach((e, i) => {
    const who = e.authors?.length ? ` — ${e.authors.join(", ")}` : "";
    const when = e.published ? ` (${e.published.slice(0, 10)})` : "";
    lines.push(`### [${i + 1}] ${e.title}${who}${when}`, "", e.url, "", e.summary, "");
  });
  return lines.join("\n");
}

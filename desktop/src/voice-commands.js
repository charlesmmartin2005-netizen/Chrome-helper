// Spoken commands. Speech recognizers are loose with names, so "All-Mind" is
// matched against the ways it tends to come out ("all mind", "almond",
// "all mine"...) and each command word tolerates a couple of wrong letters.

export const COMMANDS = {
  wake: { say: "Listening.", label: "“All-Mind, hello” or “Scriptorium”" },
  socrates: { say: "Socrates mode. Ask me anything about what I've read.", label: "“All-Mind, initiate Socrates”" },
  scribe: { say: "Scribe mode. I'm taking notes.", label: "“All-Mind, initiate Scribe”" },
  listenIn: { say: "Listening in.", label: "“All-Mind, listen in”" },
  listenOut: { say: "Listening out.", label: "“All-Mind, listen out”" },
  stop: { say: "Standing by.", label: "“All-Mind, stop”" },
};

const NAME = /\b(?:all[\s-]*mind|al+\s*mind|almond|all\s*mine|all\s*my|old\s*mind|all\s*mined|ol\s*mind|allmind|all\s*mend)\b/;

export function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function distance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// A spoken word counts as the keyword when it's within a couple of edits.
function like(word, keyword) {
  if (word === keyword) return true;
  const tolerance = keyword.length >= 7 ? 2 : keyword.length >= 5 ? 1 : 0;
  return Math.abs(word.length - keyword.length) <= tolerance && distance(word, keyword) <= tolerance;
}

function hasPhrase(words, phrase) {
  const target = phrase.split(" ");
  outer: for (let i = 0; i + target.length <= words.length; i++) {
    for (let k = 0; k < target.length; k++) if (!like(words[i + k], target[k])) continue outer;
    return true;
  }
  return false;
}

/**
 * Returns the command spoken in an utterance ("wake", "socrates", "scribe",
 * "listenIn", "listenOut", "stop") or null when it's ordinary speech.
 */
export function parseCommand(text) {
  const clean = normalize(text);
  if (!clean) return null;
  const words = clean.split(" ");
  if (hasPhrase(words, "scriptorium")) return "wake";
  const match = NAME.exec(clean);
  if (!match) return null;
  const after = clean.slice(match.index + match[0].length).trim().split(" ").filter(Boolean);
  // Only the few words right after the name count, so a sentence that merely
  // mentions All-Mind and later says "stop" isn't a command.
  const tail = after.slice(0, 4);
  if (hasPhrase(tail, "listen in") || hasPhrase(tail, "listening in")) return "listenIn";
  if (hasPhrase(tail, "listen out") || hasPhrase(tail, "listening out")) return "listenOut";
  if (hasPhrase(tail, "socrates")) return "socrates";
  if (hasPhrase(tail, "scribe")) return "scribe";
  if (hasPhrase(tail, "stop") || hasPhrase(tail, "stand down") || hasPhrase(tail, "close") || hasPhrase(tail, "standby") || hasPhrase(tail, "stand by")) return "stop";
  if (tail.length === 0 || hasPhrase(tail, "hello") || hasPhrase(tail, "hi") || hasPhrase(tail, "hey") || hasPhrase(tail, "wake up") || hasPhrase(tail, "open")) return "wake";
  return null;
}

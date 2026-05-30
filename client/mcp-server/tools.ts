/**
 * Jarvis MCP tools — implementations + JSON-schema declarations.
 *
 * All tools self-contained (osascript / shell / fetch). No dependency on the
 * running Tauri app — this server runs as a subprocess of `claude -p`.
 */

// ============================================================
// Shell + osascript helpers
// ============================================================

async function run(
  cmd: string[],
  stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : "pipe",
  });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

async function osa(script: string): Promise<string> {
  const r = await run(["osascript", "-e", script]);
  if (r.code !== 0) {
    const err = r.stderr.trim();
    if (/not allowed|not authori[sz]ed|1002|permission/i.test(err)) {
      throw new Error(
        `Permission needed — grant in System Settings → Privacy & Security: ${err}`,
      );
    }
    throw new Error(err || `osascript exit ${r.code}`);
  }
  return r.stdout.trim();
}

function appleEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ============================================================
// Tools — implementations
// ============================================================

async function runShell(command: string, reason: string) {
  console.error(`[run_shell] reason=${reason} cmd=${command.slice(0, 80)}`);
  const r = await run(["sh", "-c", command]);
  return { exit_code: r.code, stdout: r.stdout, stderr: r.stderr };
}

async function notify(title: string, message: string) {
  await osa(
    `display notification "${appleEscape(message)}" with title "${appleEscape(title)}"`,
  );
  return { ok: true };
}

async function setVolume(level: number) {
  const l = Math.max(0, Math.min(100, Math.round(level)));
  await osa(`set volume output volume ${l}`);
  return { level: l };
}

async function lockScreen() {
  // pmset is the canonical macOS sleep-now invocation.
  await run(["pmset", "displaysleepnow"]);
  return { ok: true };
}

async function openApp(name: string) {
  const r = await run(["open", "-a", name]);
  if (r.code !== 0) throw new Error(r.stderr.trim());
  return { opened: name };
}

async function openUrl(url: string) {
  const r = await run(["open", url]);
  if (r.code !== 0) throw new Error(r.stderr.trim());
  return { opened: url };
}

async function openSystemSettings(pane?: string) {
  const anchor = pane?.trim() ?? "";
  const url = anchor
    ? `x-apple.systempreferences:com.apple.preference.security?Privacy_${anchor}`
    : "x-apple.systempreferences:com.apple.preference.security";
  await run(["open", url]);
  return { opened: url };
}

async function clipboardRead() {
  const r = await run(["pbpaste"]);
  return { text: r.stdout };
}

async function clipboardWrite(text: string) {
  const r = await run(["pbcopy"], text);
  if (r.code !== 0) throw new Error("pbcopy failed");
  return { wrote_chars: [...text].length };
}

// ---- Apple Notes ----

async function appleNotesSearch(query: string, limit = 10) {
  const lim = Math.min(50, Math.max(1, limit));
  const q = appleEscape(query);
  const script = `tell application "Notes"
    set out to ""
    set matches to (every note whose name contains "${q}" or body contains "${q}")
    set n to 0
    repeat with note_ in matches
      if n is ${lim} then exit repeat
      set n to n + 1
      set ttl to name of note_
      set bd to body of note_
      if (count of bd) > 300 then set bd to (text 1 thru 300 of bd) & "…"
      set out to out & "::TITLE::" & ttl & "::BODY::" & bd & "::END::" & linefeed
    end repeat
    return out
  end tell`;
  const raw = await osa(script);
  const results: any[] = [];
  for (const entry of raw.split("::END::")) {
    const m = entry.trim().match(/^::TITLE::([\s\S]*?)::BODY::([\s\S]*)$/);
    if (m) results.push({ title: m[1].trim(), body: m[2].trim() });
  }
  return { results, count: results.length };
}

async function appleNotesCreate(title: string, body: string) {
  const t = appleEscape(title);
  const b = appleEscape(body);
  try {
    await osa(
      `tell application "Notes"
        tell account "iCloud"
          make new note at folder "Notes" with properties {name:"${t}", body:"${b}"}
        end tell
      end tell`,
    );
    return { created: title, account: "iCloud" };
  } catch (e1: any) {
    await osa(
      `tell application "Notes"
        make new note with properties {name:"${t}", body:"${b}"}
      end tell`,
    );
    return { created: title, account: "default" };
  }
}

// ---- Apple Contacts ----

async function appleContactsSearch(query: string, limit = 10) {
  const lim = Math.min(50, Math.max(1, limit));
  const q = appleEscape(query);
  const script = `tell application "Contacts"
    set out to ""
    set matches to (every person whose name contains "${q}")
    set n to 0
    repeat with p in matches
      if n is ${lim} then exit repeat
      set n to n + 1
      set nm to name of p
      set phones to ""
      repeat with ph in (phones of p)
        set phones to phones & (value of ph) & "; "
      end repeat
      set emails to ""
      repeat with em in (emails of p)
        set emails to emails & (value of em) & "; "
      end repeat
      set out to out & "::NAME::" & nm & "::PHONES::" & phones & "::EMAILS::" & emails & "::END::" & linefeed
    end repeat
    return out
  end tell`;
  const raw = await osa(script);
  const results: any[] = [];
  const split = (s: string) =>
    s
      .trim()
      .replace(/;\s*$/, "")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean);
  for (const entry of raw.split("::END::")) {
    const m = entry
      .trim()
      .match(/^::NAME::([\s\S]*?)::PHONES::([\s\S]*?)::EMAILS::([\s\S]*)$/);
    if (m)
      results.push({
        name: m[1].trim(),
        phones: split(m[2]),
        emails: split(m[3]),
      });
  }
  return { results, count: results.length };
}

// ---- iMessage ----

async function imessageRecent(limit = 15) {
  const lim = Math.min(100, Math.max(1, limit));
  const home = process.env.HOME ?? "";
  const db = `${home}/Library/Messages/chat.db`;
  const sql = `SELECT datetime(message.date/1000000000 + strftime('%s','2001-01-01'),'unixepoch','localtime') AS ts, handle.id AS contact, message.is_from_me AS from_me, message.text AS text FROM message LEFT JOIN handle ON message.handle_id = handle.ROWID WHERE message.text IS NOT NULL ORDER BY message.date DESC LIMIT ${lim};`;
  const r = await run(["sqlite3", "-json", db, sql]);
  if (r.code !== 0) {
    if (/unable to open|authorization/i.test(r.stderr)) {
      throw new Error(
        "Full Disk Access required — System Settings → Privacy & Security → Full Disk Access → enable Jarvis",
      );
    }
    throw new Error(r.stderr.trim());
  }
  const messages = r.stdout.trim() ? JSON.parse(r.stdout) : [];
  return { messages };
}

async function imessageSend(to: string, text: string) {
  const t = appleEscape(text);
  const a = appleEscape(to);
  await osa(`tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy "${a}" of targetService
    send "${t}" to targetBuddy
  end tell`);
  return { sent_to: to };
}

// ---- Apple Music ----

async function appleMusicControl(action: string) {
  const a = action.toLowerCase();
  if (a === "current" || a === "status") {
    const raw = await osa(`tell application "Music"
      if player state is playing then
        set tn to name of current track
        set ar to artist of current track
        set al to album of current track
        return "{\\"playing\\":true,\\"track\\":\\"" & tn & "\\",\\"artist\\":\\"" & ar & "\\",\\"album\\":\\"" & al & "\\"}"
      else
        return "{\\"playing\\":false}"
      end if
    end tell`);
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }
  const map: Record<string, string> = {
    play: "play",
    pause: "pause",
    playpause: "playpause",
    toggle: "playpause",
    next: "next track",
    prev: "previous track",
    previous: "previous track",
  };
  const cmd = map[a];
  if (!cmd) throw new Error(`unknown action: ${action}`);
  await osa(`tell application "Music" to ${cmd}`);
  return { action };
}

// ---- Apple Reminders ----

async function appleRemindersCreate(
  text: string,
  due_minutes_from_now?: number,
  notes?: string,
) {
  const t = appleEscape(text);
  const n = appleEscape(notes ?? "");
  const due =
    due_minutes_from_now && due_minutes_from_now > 0
      ? `set due date of newR to (current date) + (${due_minutes_from_now} * minutes)`
      : "";
  await osa(`tell application "Reminders"
    set newR to make new reminder with properties {name:"${t}", body:"${n}"}
    ${due}
  end tell`);
  return { created: text, due_minutes_from_now };
}

async function appleRemindersList(limit = 15) {
  const lim = Math.min(100, Math.max(1, limit));
  const raw = await osa(`tell application "Reminders"
    set out to ""
    set n to 0
    repeat with r in (every reminder whose completed is false)
      if n is ${lim} then exit repeat
      set n to n + 1
      set nm to name of r
      set dd to ""
      try
        set dd to (due date of r) as string
      end try
      set out to out & "::NAME::" & nm & "::DUE::" & dd & "::END::" & linefeed
    end repeat
    return out
  end tell`);
  const results: any[] = [];
  for (const entry of raw.split("::END::")) {
    const m = entry.trim().match(/^::NAME::([\s\S]*?)::DUE::([\s\S]*)$/);
    if (m) results.push({ name: m[1].trim(), due: m[2].trim() });
  }
  return { results, count: results.length };
}

// ---- Apple Calendar ----

async function appleCalendarUpcoming(days = 7) {
  const d = Math.min(60, Math.max(1, days));
  const raw = await osa(`tell application "Calendar"
    set out to ""
    set startD to (current date)
    set endD to startD + (${d} * days)
    set n to 0
    repeat with cal in calendars
      repeat with ev in (every event of cal whose start date is greater than or equal to startD and start date is less than endD)
        if n is 50 then exit repeat
        set n to n + 1
        set sm to summary of ev
        set sd to (start date of ev) as string
        set ed to (end date of ev) as string
        set cn to name of cal
        set out to out & "::TITLE::" & sm & "::START::" & sd & "::END_DT::" & ed & "::CAL::" & cn & "::END::" & linefeed
      end repeat
      if n is 50 then exit repeat
    end repeat
    return out
  end tell`);
  const results: any[] = [];
  for (const entry of raw.split("::END::")) {
    const m = entry
      .trim()
      .match(/^::TITLE::([\s\S]*?)::START::([\s\S]*?)::END_DT::([\s\S]*?)::CAL::([\s\S]*)$/);
    if (m)
      results.push({
        title: m[1].trim(),
        start: m[2].trim(),
        end: m[3].trim(),
        calendar: m[4].trim(),
      });
  }
  return { results, count: results.length, days_window: d };
}

async function appleCalendarCreate(
  title: string,
  start_minutes_from_now: number,
  duration_minutes = 60,
  notes?: string,
  calendar_name?: string,
) {
  const t = appleEscape(title);
  const n = appleEscape(notes ?? "");
  const dur = Math.max(1, duration_minutes);
  const calSel =
    calendar_name && calendar_name.length > 0
      ? `set targetCal to first calendar whose name is "${appleEscape(calendar_name)}"`
      : `set targetCal to first calendar whose writable is true`;
  await osa(`tell application "Calendar"
    ${calSel}
    set startD to (current date) + (${start_minutes_from_now} * minutes)
    set endD to startD + (${dur} * minutes)
    tell targetCal
      make new event with properties {summary:"${t}", start date:startD, end date:endD, description:"${n}"}
    end tell
  end tell`);
  return { created: title, starts_in_minutes: start_minutes_from_now, duration_minutes: dur };
}

// ---- GUI automation ----

async function typeInApp(app: string, text: string, press_enter = false) {
  const a = appleEscape(app);
  await osa(`tell application "${a}" to activate`);
  await Bun.sleep(300);
  const r = await run(["pbcopy"], text);
  if (r.code !== 0) throw new Error("pbcopy failed");
  await osa(
    `tell application "System Events" to keystroke "v" using command down`,
  );
  if (press_enter) {
    await Bun.sleep(150);
    await osa(`tell application "System Events" to key code 36`);
  }
  return { ok: true, app, text_chars: [...text].length, pressed_enter: press_enter };
}

async function keystroke(combo: string) {
  const parts = combo.split("+").map((s) => s.trim());
  if (parts.length === 0 || parts.every((p) => !p)) throw new Error("empty combo");
  const key = parts[parts.length - 1].toLowerCase();
  const mods = parts.slice(0, -1);
  const modClauses: string[] = [];
  for (const m of mods) {
    const lc = m.toLowerCase();
    if (lc === "cmd" || lc === "command" || lc === "⌘") modClauses.push("command down");
    else if (lc === "ctrl" || lc === "control" || lc === "⌃")
      modClauses.push("control down");
    else if (lc === "alt" || lc === "option" || lc === "opt" || lc === "⌥")
      modClauses.push("option down");
    else if (lc === "shift" || lc === "⇧") modClauses.push("shift down");
    else if (lc === "fn") modClauses.push("function down");
  }
  const using = modClauses.length ? ` using {${modClauses.join(", ")}}` : "";
  const specials: Record<string, number> = {
    return: 36,
    enter: 36,
    tab: 48,
    space: 49,
    delete: 51,
    backspace: 51,
    escape: 53,
    esc: 53,
    left: 123,
    right: 124,
    down: 125,
    up: 126,
    home: 115,
    end: 119,
    pageup: 116,
    pagedown: 121,
  };
  const kc = specials[key];
  if (kc !== undefined) {
    await osa(`tell application "System Events" to key code ${kc}${using}`);
  } else {
    await osa(
      `tell application "System Events" to keystroke "${appleEscape(key)}"${using}`,
    );
  }
  return { ok: true, combo };
}

// ---- Vault search (Obsidian) ----

// Where the user's Obsidian vault lives (override with OBSIDIAN_VAULT). Used by vault_search.
const VAULT_ROOT = process.env.OBSIDIAN_VAULT ?? `${process.env.HOME}/Obsidian`;

// Folders to prioritise. Memory + Projects get a score bonus because they
// hold curated synthesised notes (project state, session takeaways) rather
// than raw AI conversation dumps.
const PRIORITY_DIRS = ["Memory", "Projects"];

async function vaultSearch(query: string, top = 5) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
  if (terms.length === 0) {
    return { results: [], count: 0, query, note: "empty query" };
  }

  const glob = new Bun.Glob("**/*.md");
  type Hit = { file: string; snippet: string; score: number; matches: number };
  const hits: Hit[] = [];

  for await (const path of glob.scan({ cwd: VAULT_ROOT })) {
    if (path.startsWith(".trash")) continue;
    let text: string;
    try {
      text = await Bun.file(`${VAULT_ROOT}/${path}`).text();
    } catch {
      continue;
    }
    const lower = text.toLowerCase();

    let totalMatches = 0;
    let allTermsFound = true;
    let firstIdx = -1;
    for (const t of terms) {
      const idx = lower.indexOf(t);
      if (idx < 0) {
        allTermsFound = false;
        break;
      }
      totalMatches++;
      if (firstIdx < 0 || idx < firstIdx) firstIdx = idx;
    }
    if (!allTermsFound) continue;

    const start = Math.max(0, firstIdx - 120);
    const end = Math.min(text.length, firstIdx + 320);
    const snippet = text
      .slice(start, end)
      .replace(/\s+/g, " ")
      .trim();

    const topDir = path.split("/")[0] ?? "";
    const dirBonus = PRIORITY_DIRS.includes(topDir) ? 10 : 0;
    const depth = path.split("/").length;
    const score = dirBonus + totalMatches * 5 - depth;

    hits.push({ file: path, snippet, score, matches: totalMatches });
  }

  hits.sort((a, b) => b.score - a.score);
  return {
    results: hits.slice(0, top),
    count: hits.length,
    query,
    terms,
  };
}

// ---- Pure helpers (no shell) ----

async function weather(args: { city?: string; lat?: number; lon?: number }) {
  let lat = args.lat;
  let lon = args.lon;
  let resolvedName: string | undefined;
  if (lat === undefined || lon === undefined) {
    const city = (args.city ?? "").trim();
    if (!city) throw new Error("provide city or lat/lon");
    const geo: any = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
    ).then((r) => r.json());
    const first = geo?.results?.[0];
    if (!first) throw new Error(`city not found: ${city}`);
    lat = first.latitude;
    lon = first.longitude;
    resolvedName = `${first.name}, ${first.country_code ?? first.country ?? ""}`.trim();
  }
  const data: any = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,wind_speed_10m,weather_code&hourly=temperature_2m,precipitation_probability,weather_code&forecast_days=2&timezone=auto`,
  ).then((r) => r.json());
  return {
    location: resolvedName ?? { lat, lon },
    current: data.current,
    hourly_summary: data.hourly
      ? {
          times: data.hourly.time?.slice(0, 24),
          temps: data.hourly.temperature_2m?.slice(0, 24),
          precip_prob: data.hourly.precipitation_probability?.slice(0, 24),
        }
      : null,
    timezone: data.timezone,
  };
}

function calculator(expression: string) {
  const s = String(expression).trim();
  if (!/^[0-9+\-*/().%\s]+$/.test(s)) {
    throw new Error("only digits, + - * / %, parentheses allowed");
  }
  // Strict recursive-descent parser — no eval, no injection.
  let pos = 0;
  const skip = () => {
    while (pos < s.length && /\s/.test(s[pos])) pos++;
  };
  const peek = () => {
    skip();
    return s[pos];
  };
  const parseNumber = (): number => {
    skip();
    const start = pos;
    while (pos < s.length && /[0-9.]/.test(s[pos])) pos++;
    if (start === pos) throw new Error(`number expected at ${pos}`);
    const n = parseFloat(s.slice(start, pos));
    if (Number.isNaN(n)) throw new Error("not a number");
    return n;
  };
  const parseFactor = (): number => {
    skip();
    const c = peek();
    if (c === "(") {
      pos++;
      const v = parseExpr();
      skip();
      if (s[pos] !== ")") throw new Error(`expected ) at ${pos}`);
      pos++;
      return v;
    }
    if (c === "-") {
      pos++;
      return -parseFactor();
    }
    if (c === "+") {
      pos++;
      return parseFactor();
    }
    return parseNumber();
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    while (true) {
      const op = peek();
      if (op === "*") {
        pos++;
        v *= parseFactor();
      } else if (op === "/") {
        pos++;
        v /= parseFactor();
      } else if (op === "%") {
        pos++;
        v %= parseFactor();
      } else break;
    }
    return v;
  };
  const parseExpr = (): number => {
    let v = parseTerm();
    while (true) {
      const op = peek();
      if (op === "+") {
        pos++;
        v += parseTerm();
      } else if (op === "-") {
        pos++;
        v -= parseTerm();
      } else break;
    }
    return v;
  };
  const result = parseExpr();
  skip();
  if (pos < s.length) throw new Error(`unexpected char at ${pos}`);
  return { result, expression: s };
}

// ============================================================
// Tool registry (JSON-schema definitions for MCP listTools)
// ============================================================

export const TOOLS = [
  {
    name: "vault_search",
    description:
      "Search the user's Obsidian vault (markdown notes). Multi-term AND keyword search — all terms must appear in the file. Memory/ and Projects/ folders get a score bonus (curated notes vs raw chat dumps). Returns top-N hits with a snippet around the first match. ALWAYS call this when the user asks about past decisions, projects, saved memories, or anything they hint at with 'помнишь', 'мы обсуждали', 'как мы делали раньше'.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        top: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "run_shell",
    description:
      "Run a macOS shell command. Use for date, uptime, ls, ad-hoc queries. Always provide a short `reason` describing why.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        reason: { type: "string" },
      },
      required: ["command", "reason"],
    },
  },
  {
    name: "notify",
    description: "Show a macOS desktop notification.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, message: { type: "string" } },
      required: ["title", "message"],
    },
  },
  {
    name: "set_volume",
    description: "Set Mac output volume (0–100).",
    inputSchema: {
      type: "object",
      properties: { level: { type: "integer" } },
      required: ["level"],
    },
  },
  {
    name: "lock_screen",
    description: "Sleep the Mac display immediately (effectively locks screen).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "open_app",
    description: "Open a macOS app by name (Spotify, Telegram, Safari, …). Equivalent to `open -a`.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "open_url",
    description: "Open a URL in the default browser.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "open_system_settings",
    description:
      "Open a System Settings privacy pane: 'Accessibility', 'ScreenCapture', 'Microphone', 'Camera', 'Calendar', 'Contacts', 'Reminders', 'FullDiskAccess', 'AppleEvents', 'Automation'. Omit pane to open generic Privacy & Security.",
    inputSchema: {
      type: "object",
      properties: { pane: { type: "string" } },
    },
  },
  {
    name: "clipboard_read",
    description: "Read current clipboard text.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "clipboard_write",
    description: "Write text to clipboard.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "apple_notes_search",
    description: "Search Apple Notes (titles + bodies). Returns up to `limit` results.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "apple_notes_create",
    description: "Create a new note in Apple Notes (iCloud account by default).",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["title", "body"],
    },
  },
  {
    name: "apple_contacts_search",
    description: "Search Apple Contacts by name. Returns matches with phones + emails.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer" } },
      required: ["query"],
    },
  },
  {
    name: "imessage_recent",
    description:
      "Read most recent iMessage/SMS messages from chat.db. Requires Full Disk Access for Jarvis. Returns timestamp, contact, direction (from_me 0/1), and text.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer" } },
    },
  },
  {
    name: "imessage_send",
    description: "Send an iMessage to a phone number (E.164) or Apple ID email via Messages.app.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, text: { type: "string" } },
      required: ["to", "text"],
    },
  },
  {
    name: "apple_music_control",
    description:
      "Control Apple Music. Actions: play, pause, playpause, next, prev, current (returns now-playing info).",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string" } },
      required: ["action"],
    },
  },
  {
    name: "apple_reminders_list",
    description: "List pending (not-completed) reminders from Reminders.app.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer" } },
    },
  },
  {
    name: "apple_reminders_create",
    description:
      "Create a reminder. Pass `due_minutes_from_now` for a deadline (30 = in 30 min, 1440 = tomorrow this time).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        due_minutes_from_now: { type: "integer" },
        notes: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "apple_calendar_upcoming",
    description: "List events from Apple Calendar in the next N days (default 7).",
    inputSchema: {
      type: "object",
      properties: { days: { type: "integer" } },
    },
  },
  {
    name: "apple_calendar_create",
    description:
      "Create a Calendar event. `start_minutes_from_now`=0 for now, `duration_minutes` defaults to 60.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start_minutes_from_now: { type: "integer" },
        duration_minutes: { type: "integer" },
        notes: { type: "string" },
        calendar_name: { type: "string" },
      },
      required: ["title", "start_minutes_from_now"],
    },
  },
  {
    name: "type_in_app",
    description:
      "Activate `app`, paste `text` into the focused field, optionally press Enter. Universal way to send messages to any app when there's no API. Works with Cyrillic / emoji. Requires Accessibility permission.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        text: { type: "string" },
        press_enter: { type: "boolean" },
      },
      required: ["app", "text"],
    },
  },
  {
    name: "keystroke",
    description:
      "Press a keyboard shortcut globally. Combos: 'cmd+s', 'cmd+shift+k', 'escape', 'return'. Modifiers: cmd/ctrl/alt/option/shift/fn. Special keys: return, tab, space, delete, escape, left, right, up, down, home, end, pageup, pagedown.",
    inputSchema: {
      type: "object",
      properties: { combo: { type: "string" } },
      required: ["combo"],
    },
  },
  {
    name: "weather",
    description:
      "Current weather + 24h forecast via Open-Meteo (free, no key). Pass `city` or {lat, lon}.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
        lat: { type: "number" },
        lon: { type: "number" },
      },
    },
  },
  {
    name: "calculator",
    description:
      "Evaluate basic arithmetic. Supports + - * / %, parentheses, decimals. No code injection.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  },
];

// ============================================================
// Dispatch
// ============================================================

export async function dispatchTool(name: string, a: Record<string, any>): Promise<any> {
  switch (name) {
    case "vault_search":
      return vaultSearch(a.query, a.top ?? 5);
    case "run_shell":
      return runShell(a.command, a.reason ?? "");
    case "notify":
      return notify(a.title, a.message);
    case "set_volume":
      return setVolume(a.level);
    case "lock_screen":
      return lockScreen();
    case "open_app":
      return openApp(a.name);
    case "open_url":
      return openUrl(a.url);
    case "open_system_settings":
      return openSystemSettings(a.pane);
    case "clipboard_read":
      return clipboardRead();
    case "clipboard_write":
      return clipboardWrite(a.text);
    case "apple_notes_search":
      return appleNotesSearch(a.query, a.limit ?? 10);
    case "apple_notes_create":
      return appleNotesCreate(a.title, a.body);
    case "apple_contacts_search":
      return appleContactsSearch(a.query, a.limit ?? 10);
    case "imessage_recent":
      return imessageRecent(a.limit ?? 15);
    case "imessage_send":
      return imessageSend(a.to, a.text);
    case "apple_music_control":
      return appleMusicControl(a.action);
    case "apple_reminders_list":
      return appleRemindersList(a.limit ?? 15);
    case "apple_reminders_create":
      return appleRemindersCreate(a.text, a.due_minutes_from_now, a.notes);
    case "apple_calendar_upcoming":
      return appleCalendarUpcoming(a.days ?? 7);
    case "apple_calendar_create":
      return appleCalendarCreate(
        a.title,
        a.start_minutes_from_now,
        a.duration_minutes ?? 60,
        a.notes,
        a.calendar_name,
      );
    case "type_in_app":
      return typeInApp(a.app, a.text, a.press_enter ?? false);
    case "keystroke":
      return keystroke(a.combo);
    case "weather":
      return weather({ city: a.city, lat: a.lat, lon: a.lon });
    case "calculator":
      return calculator(a.expression);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

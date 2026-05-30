/**
 * Skill discovery on the filesystem.
 *
 * Walks `skills/<name>/SKILL.md`, parses YAML frontmatter, returns
 * structured metadata. Used both for one-time registry sync and for
 * the live `skill_read` MCP-tool.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME ?? "";
export const SKILLS_DIR =
  process.env.JARVIS_SKILLS_DIR ?? join(HOME, "Code/jarvis/client/skills");

export interface SkillManifest {
  name: string;
  version: string;
  description?: string;
  tags?: string[];
  when_to_use?: string[];
  agents?: string[];
  inputs?: any;
  outputs?: any;
  permissions?: any;
  [k: string]: any;
}

export interface SkillRecord {
  name: string;
  path: string;             // absolute path to skills/<name>/
  manifest: SkillManifest;
  body: string;             // markdown body after frontmatter
  actions: ActionRecord[];
}

export interface ActionRecord {
  name: string;             // e.g. "daily-digest.fetch_period"
  rel_path: string;         // "actions/fetch_period.md"
  manifest: Record<string, any>;
  body: string;
}

/** List all skills found under SKILLS_DIR. */
export function listSkillDirs(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR).filter((name) => {
    const p = join(SKILLS_DIR, name);
    return (
      statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"))
    );
  });
}

/** Read one skill folder fully. Throws if SKILL.md missing or malformed. */
export function readSkill(name: string): SkillRecord {
  const path = join(SKILLS_DIR, name);
  const skillMd = join(path, "SKILL.md");
  if (!existsSync(skillMd)) {
    throw new Error(`Skill '${name}' has no SKILL.md at ${path}`);
  }
  const raw = readFileSync(skillMd, "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const manifest = parseYamlLight(frontmatter) as SkillManifest;
  if (!manifest.name) manifest.name = name;
  if (!manifest.version) manifest.version = "0.0.0";

  const actions: ActionRecord[] = [];
  const actionsDir = join(path, "actions");
  if (existsSync(actionsDir)) {
    for (const f of readdirSync(actionsDir)) {
      if (!f.endsWith(".md")) continue;
      const ap = join(actionsDir, f);
      const aRaw = readFileSync(ap, "utf8");
      const { frontmatter: aFm, body: aBody } = splitFrontmatter(aRaw);
      const am = parseYamlLight(aFm);
      actions.push({
        name: am.name ?? f.replace(/\.md$/, ""),
        rel_path: `actions/${f}`,
        manifest: am,
        body: aBody.trim(),
      });
    }
  }
  return { name, path, manifest, body: body.trim(), actions };
}

export function readAllSkills(): SkillRecord[] {
  return listSkillDirs().map((n) => readSkill(n));
}

// ----------------------------------------------------------------
// YAML frontmatter — light parser (key: value + simple lists/objects).
// We deliberately don't pull in a full YAML lib: skills control their own
// frontmatter and we keep the surface predictable.
// ----------------------------------------------------------------

function splitFrontmatter(s: string): { frontmatter: string; body: string } {
  if (!s.startsWith("---")) return { frontmatter: "", body: s };
  const end = s.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: "", body: s };
  const frontmatter = s.slice(3, end).replace(/^\n/, "");
  const rest = s.slice(end + 4).replace(/^\n/, "");
  return { frontmatter, body: rest };
}

function parseYamlLight(src: string): Record<string, any> {
  if (!src.trim()) return {};
  const lines = src.split("\n");
  const out: Record<string, any> = {};
  let curKey: string | null = null;
  let curList: any[] | null = null;
  let curObj: Record<string, any> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;

    // top-level key: value or key: (list/obj/block-scalar follows)
    const topMatch = raw.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (topMatch && !raw.startsWith(" ") && !raw.startsWith("\t")) {
      curKey = topMatch[1];
      curList = null;
      curObj = null;
      const value = topMatch[2].trim();
      // YAML block scalar: "key: >" (folded) or "key: |" (literal),
      // optional chomping indicator (>- |- >+ |+). Collect the indented
      // block that follows. This is the standard Anthropic/Paperclip skill
      // `description: >` shape — previously it was dropped (became ">").
      const blockMatch = value.match(/^([>|])([+-]?)\s*$/);
      if (blockMatch) {
        const folded = blockMatch[1] === ">";
        const blockLines: string[] = [];
        let baseIndent: number | null = null;
        while (i + 1 < lines.length) {
          const next = lines[i + 1];
          if (next.trim() === "") {
            blockLines.push("");
            i++;
            continue;
          }
          const indent = next.length - next.trimStart().length;
          if (indent === 0) break; // dedent back to top level → block ended
          if (baseIndent === null) baseIndent = indent;
          blockLines.push(next.slice(baseIndent));
          i++;
        }
        // trim trailing blank lines
        while (blockLines.length && blockLines[blockLines.length - 1] === "") {
          blockLines.pop();
        }
        out[curKey] = folded
          ? foldLines(blockLines)
          : blockLines.join("\n");
        continue;
      }
      if (value === "") {
        // list or object will be parsed from subsequent indented lines
        out[curKey] = null;
      } else if (value.startsWith("[") && value.endsWith("]")) {
        out[curKey] = value
          .slice(1, -1)
          .split(",")
          .map((x) => x.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      } else {
        out[curKey] = stripQuotes(value);
      }
      continue;
    }

    // indented list item: "  - foo"  OR "  - key: value"
    const listMatch = raw.match(/^\s+-\s+(.*)$/);
    if (listMatch && curKey) {
      if (out[curKey] === null || !Array.isArray(out[curKey])) {
        out[curKey] = [];
        curList = out[curKey] as any[];
        curObj = null;
      }
      const item = listMatch[1].trim();
      const itemKv = item.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
      if (itemKv && itemKv[2].trim() !== "") {
        // "name: foo" — start an object element
        curObj = { [itemKv[1]]: stripQuotes(itemKv[2].trim()) };
        curList!.push(curObj);
      } else if (itemKv) {
        // "name:" — start object element, next lines will fill
        curObj = { [itemKv[1]]: null };
        curList!.push(curObj);
      } else {
        curList!.push(stripQuotes(item));
        curObj = null;
      }
      continue;
    }

    // continuation key inside last list-item object: "    key: value"
    const objKv = raw.match(/^\s{4,}([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (objKv && curObj) {
      curObj[objKv[1]] =
        objKv[2].trim() === "" ? null : stripQuotes(objKv[2].trim());
      continue;
    }
  }
  return out;
}

/**
 * Fold a YAML folded-scalar (`>`) block: consecutive non-empty lines join with
 * a single space; blank lines become paragraph breaks (newline).
 */
function foldLines(lines: string[]): string {
  let out = "";
  for (const line of lines) {
    if (line === "") {
      out += "\n";
    } else {
      out += (out && !out.endsWith("\n") ? " " : "") + line.trim();
    }
  }
  return out.trim();
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

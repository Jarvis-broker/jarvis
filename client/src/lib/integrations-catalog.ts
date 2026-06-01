/**
 * Integrations Catalog — dynamic registry powered by Composio API.
 *
 * When the user has a Composio API key, fetches 500+ available apps
 * dynamically. Falls back to a minimal static catalog when offline
 * or before API key is configured.
 */
import { invoke } from "@tauri-apps/api/core";

export type AuthType = "api_key" | "oauth2" | "none";
export type IntegrationCategory =
  | "productivity"
  | "crm"
  | "dev"
  | "communication"
  | "marketing"
  | "analytics"
  | "finance"
  | "support"
  | "storage"
  | "ai"
  | "social"
  | "commerce"
  | "design"
  | "hr";

export interface IntegrationDef {
  /** Unique slug, e.g. "github" */
  slug: string;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
  /** SVG logo URL (simpleicons CDN or brand CDN) */
  logo: string;
  /** Hex background color for the logo tile */
  color: string;
  /** Primary category */
  category: IntegrationCategory;
  /** Auth method required */
  auth: AuthType;
  /** Whether this is a popular/featured integration */
  popular?: boolean;
  /** Composio toolkit slug (if backed by Composio) */
  composioSlug?: string;
  /** Auth field labels for API key integrations */
  authFields?: { name: string; label: string; placeholder?: string }[];
  /** Whether this entry came from Composio API dynamically */
  dynamic?: boolean;
}

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  productivity: "Продуктивность",
  crm: "CRM",
  dev: "Разработка",
  communication: "Коммуникации",
  marketing: "Маркетинг",
  analytics: "Аналитика",
  finance: "Финансы",
  support: "Поддержка",
  storage: "Хранилище",
  ai: "AI",
  social: "Соцсети",
  commerce: "Коммерция",
  design: "Дизайн",
  hr: "HR",
};

// ──────────────────────────────────────────────────────────────
// Category mapping — Composio categories → our IntegrationCategory
// ──────────────────────────────────────────────────────────────

const CATEGORY_MAP: Record<string, IntegrationCategory> = {
  productivity: "productivity",
  "project management": "productivity",
  "task management": "productivity",
  "note taking": "productivity",
  calendar: "productivity",
  crm: "crm",
  "sales & crm": "crm",
  sales: "crm",
  developer: "dev",
  "developer tools": "dev",
  "developer tool": "dev",
  development: "dev",
  "code & development": "dev",
  devops: "dev",
  "version control": "dev",
  communication: "communication",
  messaging: "communication",
  email: "communication",
  "video conferencing": "communication",
  marketing: "marketing",
  "email marketing": "marketing",
  seo: "marketing",
  advertising: "marketing",
  analytics: "analytics",
  "data & analytics": "analytics",
  "business intelligence": "analytics",
  monitoring: "analytics",
  finance: "finance",
  accounting: "finance",
  payment: "finance",
  payments: "finance",
  billing: "finance",
  support: "support",
  "customer support": "support",
  helpdesk: "support",
  "help desk": "support",
  storage: "storage",
  "file storage": "storage",
  "cloud storage": "storage",
  "file management": "storage",
  ai: "ai",
  "artificial intelligence": "ai",
  "machine learning": "ai",
  social: "social",
  "social media": "social",
  commerce: "commerce",
  ecommerce: "commerce",
  "e-commerce": "commerce",
  design: "design",
  "design & creative": "design",
  hr: "hr",
  "human resources": "hr",
  recruiting: "hr",
  recruitment: "hr",
};

function mapCategory(categories?: string[]): IntegrationCategory {
  if (!categories || categories.length === 0) return "productivity";
  for (const cat of categories) {
    const lower = cat.toLowerCase().trim();
    if (CATEGORY_MAP[lower]) return CATEGORY_MAP[lower];
  }
  return "productivity";
}

// ──────────────────────────────────────────────────────────────
// Color palette for dynamic entries without brand colors
// ──────────────────────────────────────────────────────────────

const PALETTE = [
  "#6366F1", "#8B5CF6", "#EC4899", "#EF4444", "#F97316",
  "#EAB308", "#22C55E", "#14B8A6", "#06B6D4", "#3B82F6",
  "#A855F7", "#D946EF", "#F43F5E", "#FB923C", "#84CC16",
];

function colorFromSlug(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = slug.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

// ──────────────────────────────────────────────────────────────
// Well-known slugs → simpleicons mapping for high-quality logos
// ──────────────────────────────────────────────────────────────

const KNOWN_ICONS: Record<string, string> = {
  notion: "notion", github: "github", gitlab: "gitlab", slack: "slack",
  discord: "discord", trello: "trello", asana: "asana", linear: "linear",
  jira: "jira", figma: "figma", canva: "canva", stripe: "stripe",
  shopify: "shopify", hubspot: "hubspot", salesforce: "salesforce",
  zendesk: "zendesk", intercom: "intercom", twilio: "twilio",
  sendgrid: "sendgrid", mailchimp: "mailchimp", airtable: "airtable",
  todoist: "todoist", clickup: "clickup", dropbox: "dropbox",
  googledrive: "googledrive", googlesheets: "googlesheets",
  googledocs: "googledocs", googlecalendar: "googlecalendar",
  gmail: "gmail", youtube: "youtube", twitter: "x",
  x: "x", instagram: "instagram", linkedin: "linkedin",
  facebook: "facebook", tiktok: "tiktok", reddit: "reddit",
  telegram: "telegram", whatsapp: "whatsapp", zoom: "zoom",
  microsoftteams: "microsoftteams", outlook: "microsoftoutlook",
  vercel: "vercel", netlify: "netlify", supabase: "supabase",
  firebase: "firebase", mongodb: "mongodb", postgresql: "postgresql",
  datadog: "datadog", sentry: "sentry", pagerduty: "pagerduty",
  mixpanel: "mixpanel", amplitude: "amplitude", segment: "segment",
  quickbooks: "quickbooks", xero: "xero", freshdesk: "freshdesk",
  pipedrive: "pipedrive", typeform: "typeform", surveymonkey: "surveymonkey",
  wordpress: "wordpress", webflow: "webflow", spotify: "spotify",
  twitch: "twitch", medium: "medium", hackernews: "ycombinator",
  wikipedia: "wikipedia", openai: "openai", anthropic: "anthropic",
};

function logoForSlug(slug: string, composioLogo?: string): string {
  // Prefer Composio's own logo if available
  if (composioLogo && composioLogo.startsWith("http")) return composioLogo;
  // Map to simpleicons
  const key = slug.toLowerCase().replace(/[-_\s]/g, "");
  const icon = KNOWN_ICONS[key];
  if (icon) return `https://cdn.simpleicons.org/${icon}`;
  return "";
}

// ──────────────────────────────────────────────────────────────
// Popular apps — manually curated for the "Popular" tab
// ──────────────────────────────────────────────────────────────

const POPULAR_SLUGS = new Set([
  "notion", "gmail", "google_calendar", "google_docs", "google_sheets",
  "google_drive", "slack", "github", "linear", "figma", "trello",
  "asana", "airtable", "todoist", "hubspot", "salesforce", "stripe",
  "shopify", "discord", "zoom", "jira", "clickup",
]);

// ──────────────────────────────────────────────────────────────
// Convert Composio API app → IntegrationDef
// ──────────────────────────────────────────────────────────────

interface ComposioApp {
  key?: string;
  name?: string;
  description?: string;
  logo?: string;
  categories?: string[];
  appId?: string;
  auth_schemes?: Array<{ auth_mode?: string }>;
  // v1 fields
  no_auth?: boolean;
  testConnectors?: unknown[];
}

function composioAppToDef(app: ComposioApp): IntegrationDef {
  const slug = app.key || app.appId || "unknown";
  const name = app.name || slug;

  // Determine auth type
  let auth: AuthType = "oauth2"; // default for most Composio apps
  if (app.no_auth === true) {
    auth = "none";
  } else if (app.auth_schemes && app.auth_schemes.length > 0) {
    const mode = app.auth_schemes[0].auth_mode?.toLowerCase() || "";
    if (mode.includes("api_key") || mode === "api_key") auth = "api_key";
    else if (mode === "none" || mode === "no_auth") auth = "none";
  }

  return {
    slug,
    name,
    description: app.description || "",
    logo: logoForSlug(slug, app.logo),
    color: colorFromSlug(slug),
    category: mapCategory(app.categories),
    auth,
    popular: POPULAR_SLUGS.has(slug),
    composioSlug: slug,
    dynamic: true,
  };
}

// ──────────────────────────────────────────────────────────────
// Minimal static fallback — shown when no API key is set
// ──────────────────────────────────────────────────────────────

const si = (name: string) => `https://cdn.simpleicons.org/${name}`;

export const FALLBACK_CATALOG: IntegrationDef[] = [
  {
    slug: "notion", name: "Notion",
    description: "Заметки, базы данных, управление проектами",
    logo: si("notion"), color: "#000000", category: "productivity",
    auth: "oauth2", popular: true, composioSlug: "notion",
  },
  {
    slug: "gmail", name: "Gmail",
    description: "Электронная почта Google",
    logo: si("gmail"), color: "#EA4335", category: "communication",
    auth: "oauth2", popular: true, composioSlug: "gmail",
  },
  {
    slug: "google_calendar", name: "Google Calendar",
    description: "Календарь и планирование встреч",
    logo: si("googlecalendar"), color: "#4285F4", category: "productivity",
    auth: "oauth2", popular: true, composioSlug: "google_calendar",
  },
  {
    slug: "google_docs", name: "Google Docs",
    description: "Создание и редактирование документов",
    logo: si("googledocs"), color: "#4285F4", category: "productivity",
    auth: "oauth2", popular: true, composioSlug: "google_docs",
  },
  {
    slug: "google_sheets", name: "Google Sheets",
    description: "Таблицы и анализ данных",
    logo: si("googlesheets"), color: "#34A853", category: "productivity",
    auth: "oauth2", popular: true, composioSlug: "google_sheets",
  },
  {
    slug: "google_drive", name: "Google Drive",
    description: "Облачное хранилище файлов",
    logo: si("googledrive"), color: "#4285F4", category: "storage",
    auth: "oauth2", popular: true, composioSlug: "google_drive",
  },
  {
    slug: "slack", name: "Slack",
    description: "Корпоративный мессенджер",
    logo: si("slack"), color: "#4A154B", category: "communication",
    auth: "oauth2", popular: true, composioSlug: "slack",
  },
  {
    slug: "github", name: "GitHub",
    description: "Репозитории, PR, issues, CI/CD",
    logo: si("github"), color: "#181717", category: "dev",
    auth: "oauth2", popular: true, composioSlug: "github",
  },
  {
    slug: "linear", name: "Linear",
    description: "Управление задачами для продуктовых команд",
    logo: si("linear"), color: "#5E6AD2", category: "dev",
    auth: "oauth2", popular: true, composioSlug: "linear",
  },
  {
    slug: "figma", name: "Figma",
    description: "Дизайн интерфейсов и прототипирование",
    logo: si("figma"), color: "#F24E1E", category: "design",
    auth: "oauth2", popular: true, composioSlug: "figma",
  },
  {
    slug: "trello", name: "Trello",
    description: "Канбан-доски для управления проектами",
    logo: si("trello"), color: "#0052CC", category: "productivity",
    auth: "oauth2", popular: true, composioSlug: "trello",
  },
  {
    slug: "hubspot", name: "HubSpot",
    description: "CRM, маркетинг и продажи",
    logo: si("hubspot"), color: "#FF7A59", category: "crm",
    auth: "oauth2", popular: true, composioSlug: "hubspot",
  },
];

// ──────────────────────────────────────────────────────────────
// Dynamic fetch — calls Rust backend which proxies to Composio API
// ──────────────────────────────────────────────────────────────

let _cachedApps: IntegrationDef[] | null = null;

/**
 * Fetch the full Composio catalog via the Rust backend.
 * Caches in memory for the session lifetime.
 * Falls back to the static catalog on error.
 */
export async function fetchDynamicCatalog(): Promise<IntegrationDef[]> {
  if (_cachedApps) return _cachedApps;

  try {
    const resp = await invoke("integrations_fetch_composio_apps");
    const data = resp as { items?: ComposioApp[] } | ComposioApp[];

    // Composio v1 returns { items: [...] } or just an array.
    const apps = Array.isArray(data)
      ? data
      : Array.isArray((data as any).items)
        ? (data as any).items
        : [];

    if (apps.length === 0) {
      console.warn("[catalog] Composio returned 0 apps, using fallback");
      return FALLBACK_CATALOG;
    }

    const defs: IntegrationDef[] = apps.map(composioAppToDef);

    // Sort: popular first, then alphabetically.
    defs.sort((a, b) => {
      if (a.popular && !b.popular) return -1;
      if (!a.popular && b.popular) return 1;
      return a.name.localeCompare(b.name);
    });

    _cachedApps = defs;
    return defs;
  } catch (e) {
    console.warn("[catalog] Failed to fetch from Composio, using fallback:", e);
    return FALLBACK_CATALOG;
  }
}

/** Clear the cache — call after changing API key. */
export function clearCatalogCache() {
  _cachedApps = null;
}

/**
 * Create a Composio session for the current profile.
 * Returns the session info including MCP URL.
 */
export async function createComposioSession(): Promise<{
  mcpUrl?: string;
  sessionId?: string;
}> {
  try {
    const resp = (await invoke("integrations_create_composio_session")) as any;
    return {
      mcpUrl: resp?.mcp?.url || resp?.mcpUrl,
      sessionId: resp?.id || resp?.sessionId,
    };
  } catch (e) {
    console.error("[catalog] Failed to create Composio session:", e);
    throw e;
  }
}

/** Check if a Composio session/MCP server is configured for this profile. */
export async function getComposioSessionStatus(): Promise<{
  hasSession: boolean;
  mcpUrl: string;
}> {
  try {
    const resp = (await invoke("integrations_composio_session_status")) as any;
    return {
      hasSession: resp?.hasSession ?? false,
      mcpUrl: resp?.mcpUrl ?? "",
    };
  } catch {
    return { hasSession: false, mcpUrl: "" };
  }
}

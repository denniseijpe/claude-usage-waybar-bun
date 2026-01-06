/**
 * Claude Code usage monitor for waybar/polybar.
 * Outputs JSON compatible with waybar's custom module format.
 *
 * Shows your Claude Code 5-hour and 7-day usage limits with notifications
 * when approaching thresholds.
 */

import { homedir } from "os";
import { join } from "path";

// File paths
const CLAUDE_CREDENTIALS_FILE = join(homedir(), ".claude", ".credentials.json");
const OPENCODE_AUTH_FILE = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "auth.json",
);
const STATE_FILE = join(homedir(), ".cache", "claude-usage-state.json");
const API_BASE = "https://api.anthropic.com/api/oauth";

// Notification thresholds (only notify once per threshold crossing)
const THRESHOLDS = [50, 80, 90, 95];

// Types
interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: string; // ISO date string
  };
}

interface OpenCodeAuth {
  anthropic?: {
    type?: string;
    access?: string;
    expires?: number; // Unix timestamp in milliseconds
  };
}

interface State {
  notified_thresholds: number[];
  last_reset: string | null;
}

interface UsageWindow {
  utilization?: number;
  resets_at?: string;
}

interface ExtraUsage {
  is_enabled?: boolean;
  used_credits?: number;
  monthly_limit?: number | null;
}

interface UsageResponse {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  extra_usage?: ExtraUsage;
  error?: {
    message?: string;
  };
}

interface ProfileResponse {
  account?: {
    full_name?: string;
  };
  organization?: {
    name?: string;
    organization_type?: string;
    rate_limit_tier?: string;
  };
}

interface WaybarOutput {
  text: string;
  tooltip: string;
  class: string;
  percentage?: number;
}

/**
 * Check if a token is expired.
 */
function isExpired(expiresAt: string | number | undefined): boolean {
  if (!expiresAt) {
    return false; // Assume not expired if no expiry info
  }

  const now = Date.now();
  const expiryTime =
    typeof expiresAt === "number" ? expiresAt : new Date(expiresAt).getTime();

  return now >= expiryTime;
}

/**
 * Read access token from Claude CLI credentials file.
 */
async function getClaudeToken(): Promise<string | null> {
  try {
    const file = Bun.file(CLAUDE_CREDENTIALS_FILE);
    if (!(await file.exists())) {
      return null;
    }
    const creds: ClaudeCredentials = await file.json();
    const oauth = creds.claudeAiOauth;

    if (!oauth?.accessToken) {
      return null;
    }

    // Check expiration
    if (isExpired(oauth.expiresAt)) {
      return null;
    }

    return oauth.accessToken;
  } catch {
    return null;
  }
}

/**
 * Read access token from OpenCode auth file.
 */
async function getOpenCodeToken(): Promise<string | null> {
  try {
    const file = Bun.file(OPENCODE_AUTH_FILE);
    if (!(await file.exists())) {
      return null;
    }
    const auth: OpenCodeAuth = await file.json();
    const anthropic = auth.anthropic;

    if (!anthropic?.access || anthropic.type !== "oauth") {
      return null;
    }

    // Check expiration
    if (isExpired(anthropic.expires)) {
      return null;
    }

    return anthropic.access;
  } catch {
    return null;
  }
}

/**
 * Read access token from available credential sources.
 * Tries Claude CLI first, then OpenCode.
 */
async function getAccessToken(): Promise<string | null> {
  // Try Claude CLI credentials first
  const claudeToken = await getClaudeToken();
  if (claudeToken) {
    return claudeToken;
  }

  // Try OpenCode credentials
  const openCodeToken = await getOpenCodeToken();
  if (openCodeToken) {
    return openCodeToken;
  }

  return null;
}

/**
 * Make an API call to Claude OAuth endpoint.
 */
async function apiCall<T>(endpoint: string, token: string): Promise<T> {
  const response = await fetch(`${API_BASE}/${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  return response.json() as Promise<T>;
}

/**
 * Calculate human-readable time until reset.
 */
function timeUntil(resetStr: string | undefined): string {
  if (!resetStr) {
    return "N/A";
  }

  try {
    const reset = new Date(resetStr);
    const now = new Date();
    const secs = (reset.getTime() - now.getTime()) / 1000;

    if (secs < 0) {
      return "now";
    } else if (secs < 3600) {
      return `${Math.floor(secs / 60)}m`;
    } else if (secs < 86400) {
      const hours = Math.floor(secs / 3600);
      const mins = Math.floor((secs % 3600) / 60);
      return `${hours}h ${mins}m`;
    } else {
      const days = Math.floor(secs / 86400);
      const hours = Math.floor((secs % 86400) / 3600);
      return `${days}d ${hours}h`;
    }
  } catch {
    return "N/A";
  }
}

/**
 * Format reset time as local time.
 */
function formatResetTime(resetStr: string | undefined): string {
  if (!resetStr) {
    return "N/A";
  }

  try {
    const reset = new Date(resetStr);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const day = days[reset.getDay()];
    const hours = reset.getHours().toString().padStart(2, "0");
    const mins = reset.getMinutes().toString().padStart(2, "0");
    return `${day} ${hours}:${mins}`;
  } catch {
    return "N/A";
  }
}

/**
 * Load previous notification state.
 */
async function loadState(): Promise<State> {
  try {
    const file = Bun.file(STATE_FILE);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {
    // Ignore errors
  }
  return { notified_thresholds: [], last_reset: null };
}

/**
 * Save notification state.
 */
async function saveState(state: State): Promise<void> {
  try {
    // Ensure parent directory exists
    const cacheDir = join(homedir(), ".cache");
    await Bun.write(STATE_FILE, JSON.stringify(state));
  } catch {
    // Ignore errors
  }
}

/**
 * Send a desktop notification.
 */
async function sendNotification(
  title: string,
  body: string,
  urgency: string = "normal",
): Promise<void> {
  try {
    Bun.spawn(["notify-send", "-a", "Claude", "-u", urgency, title, body]);
  } catch {
    // Ignore notification errors
  }
}

/**
 * Check thresholds and send notifications if needed.
 */
async function checkAndNotify(
  fivePct: number,
  resetAt: string | undefined,
  state: State,
): Promise<State> {
  // Reset notifications if the window has reset
  if (state.last_reset !== resetAt) {
    state = { notified_thresholds: [], last_reset: resetAt ?? null };
  }

  const notified = state.notified_thresholds;

  for (const threshold of THRESHOLDS) {
    if (fivePct >= threshold && !notified.includes(threshold)) {
      // Determine urgency
      let urgency: string;
      let icon: string;

      if (threshold >= 90) {
        urgency = "critical";
        icon = "\u{1F534}"; // Red circle
      } else if (threshold >= 80) {
        urgency = "critical";
        icon = "\u{1F7E0}"; // Orange circle
      } else {
        urgency = "normal";
        icon = "\u{1F7E1}"; // Yellow circle
      }

      const resetIn = timeUntil(resetAt);
      await sendNotification(
        `${icon} Claude Usage ${threshold}%`,
        `5-hour limit at ${fivePct}%\nResets in ${resetIn}`,
        urgency,
      );
      notified.push(threshold);
    }
  }

  state.notified_thresholds = notified;
  return state;
}

/**
 * Output JSON result to stdout.
 */
function output(result: WaybarOutput): void {
  console.log(JSON.stringify(result));
}

/**
 * Main function.
 */
async function main(): Promise<void> {
  const token = await getAccessToken();

  if (!token) {
    output({
      text: "󰧑 ?",
      tooltip:
        "No valid credentials found\n\nRun 'claude' or 'opencode' to authenticate",
      class: "error",
    });
    return;
  }

  let usage: UsageResponse;
  let profile: ProfileResponse;

  try {
    [usage, profile] = await Promise.all([
      apiCall<UsageResponse>("usage", token),
      apiCall<ProfileResponse>("profile", token),
    ]);
  } catch (e) {
    output({
      text: "󰧑 !",
      tooltip: `API error: ${e}`,
      class: "error",
    });
    return;
  }

  // Check for API errors
  if (usage.error) {
    output({
      text: "󰧑 !",
      tooltip: `API error: ${usage.error.message ?? "Unknown"}`,
      class: "error",
    });
    return;
  }

  const fiveHour = usage.five_hour ?? {};
  const sevenDay = usage.seven_day ?? {};
  const account = profile.account ?? {};
  const org = profile.organization ?? {};

  const fivePct = Math.floor(fiveHour.utilization ?? 0);
  const sevenPct = Math.floor(sevenDay.utilization ?? 0);
  const resetAt = fiveHour.resets_at;

  // Check thresholds and notify
  let state = await loadState();
  state = await checkAndNotify(fivePct, resetAt, state);
  await saveState(state);

  // Determine CSS class based on usage
  let cssClass: string;
  if (fivePct > 80) {
    cssClass = "critical";
  } else if (fivePct > 50) {
    cssClass = "warning";
  } else {
    cssClass = "normal";
  }

  // Build tooltip
  const tooltipLines = [
    `${account.full_name ?? "Unknown"} @ ${org.name ?? "Unknown"}`,
    "",
    `5-hour:  ${fivePct.toString().padStart(3)}% used`,
    `         resets in ${timeUntil(fiveHour.resets_at)} (${formatResetTime(fiveHour.resets_at)})`,
    "",
    `7-day:   ${sevenPct.toString().padStart(3)}% used`,
    `         resets in ${timeUntil(sevenDay.resets_at)} (${formatResetTime(sevenDay.resets_at)})`,
    "",
    `Plan: ${(org.organization_type ?? "N/A").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`,
    `Tier: ${org.rate_limit_tier ?? "N/A"}`,
  ];

  // Add extra usage info if enabled
  const extra = usage.extra_usage ?? {};
  if (extra.is_enabled) {
    const used = extra.used_credits ?? 0;
    const limit = extra.monthly_limit;
    if (limit) {
      tooltipLines.push(`Extra: $${used.toFixed(2)} / $${limit.toFixed(2)}`);
    } else {
      tooltipLines.push(`Extra: $${used.toFixed(2)} (no limit)`);
    }
  }

  output({
    text: `󰧑   ${fivePct}%`,
    tooltip: tooltipLines.join("\n"),
    class: cssClass,
    percentage: fivePct,
  });
}

// Run main
main();

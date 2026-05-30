/**
 * Auto-update wrapper around @tauri-apps/plugin-updater.
 *
 * Flow:
 *   1. checkForUpdate() polls the endpoint in tauri.conf.json
 *      (GitHub Releases latest.json), verified against the bundled pubkey.
 *   2. installUpdate() downloads + verifies + installs, then relaunches.
 *
 * All calls are no-ops / soft-fail in dev (`tauri dev`) and when offline, so
 * the UI can call them freely without guarding.
 */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes?: string;
  date?: string;
  /** Opaque handle used by installUpdate(). */
  _update: Update;
}

export type InstallPhase =
  | { phase: "downloading"; downloaded: number; total: number | null }
  | { phase: "installing" }
  | { phase: "done" };

/**
 * Returns update info if a newer version is available, else null.
 * Never throws — network / dev-mode errors resolve to null.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body ?? undefined,
      date: update.date ?? undefined,
      _update: update,
    };
  } catch (e) {
    console.warn("[updater] check failed (offline / dev?):", e);
    return null;
  }
}

/**
 * Download + install the given update, reporting progress, then relaunch.
 * Throws on real failures so the UI can surface them.
 */
export async function installUpdate(
  info: UpdateInfo,
  onPhase?: (p: InstallPhase) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;

  await info._update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        onPhase?.({ phase: "downloading", downloaded: 0, total });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onPhase?.({ phase: "downloading", downloaded, total });
        break;
      case "Finished":
        onPhase?.({ phase: "installing" });
        break;
    }
  });

  onPhase?.({ phase: "done" });
  // Relaunch into the freshly installed version.
  await relaunch();
}

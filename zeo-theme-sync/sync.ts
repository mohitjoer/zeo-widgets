#!/usr/bin/env bun
/**
 * Zeo Theme Synchronizer (TypeScript Implementation)
 * Monitors org.gnome.desktop.interface color-scheme via gsettings
 * and automatically synchronizes org.gnome.shell.extensions.user-theme name.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";

type ThemeName = "Zeo-Dark" | "Zeo-Light";

function getTargetTheme(colorScheme: string): ThemeName {
  return colorScheme.includes("prefer-dark") ? "Zeo-Dark" : "Zeo-Light";
}

function getCurrentColorScheme(): string {
  try {
    return execFileSync("gsettings", ["get", "org.gnome.desktop.interface", "color-scheme"], {
      encoding: "utf-8",
    })
      .trim()
      .replace(/['"]/g, "");
  } catch (error) {
    console.error("[zeo-theme-sync:ts] Failed to read color-scheme:", error);
    return "prefer-dark";
  }
}

function getCurrentUserTheme(): string {
  try {
    return execFileSync("gsettings", ["get", "org.gnome.shell.extensions.user-theme", "name"], {
      encoding: "utf-8",
    })
      .trim()
      .replace(/['"]/g, "");
  } catch (error) {
    return "";
  }
}

function setUserTheme(targetTheme: ThemeName): void {
  try {
    const currentTheme = getCurrentUserTheme();
    if (currentTheme !== targetTheme) {
      execFileSync("gsettings", ["set", "org.gnome.shell.extensions.user-theme", "name", targetTheme], {
        encoding: "utf-8",
      });
      console.log(`[zeo-theme-sync:ts] Switched user-theme to ${targetTheme}`);
    }
  } catch (error) {
    console.error(`[zeo-theme-sync:ts] Failed to set user-theme to ${targetTheme}:`, error);
  }
}

function syncNow(): void {
  const currentScheme = getCurrentColorScheme();
  const targetTheme = getTargetTheme(currentScheme);
  setUserTheme(targetTheme);
}

function startMonitor(): ChildProcess {
  console.log("[zeo-theme-sync:ts] Starting gsettings monitor for color-scheme...");
  const monitor = spawn("gsettings", ["monitor", "org.gnome.desktop.interface", "color-scheme"]);

  monitor.stdout.on("data", (data: Buffer) => {
    const text = data.toString("utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const targetTheme = getTargetTheme(trimmed);
      setUserTheme(targetTheme);
    }
  });

  monitor.stderr.on("data", (err: Buffer) => {
    console.error(`[zeo-theme-sync:ts] monitor stderr: ${err.toString("utf-8").trim()}`);
  });

  monitor.on("exit", (code: number | null) => {
    console.warn(`[zeo-theme-sync:ts] monitor exited with code ${code}, restarting in 1s...`);
    setTimeout(startMonitor, 1000);
  });

  return monitor;
}

function main(): void {
  // 1. Initial sync
  syncNow();

  // 2. Continuous monitor
  const monitor = startMonitor();

  // 3. Graceful shutdown
  const cleanup = () => {
    console.log("[zeo-theme-sync:ts] Shutting down...");
    monitor.kill();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log("[zeo-theme-sync:ts] Active and monitoring desktop color-scheme.");
}

main();

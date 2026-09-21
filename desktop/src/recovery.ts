/**
 * Recovery window.
 *
 * Mirrors DSH Desktop's recovery flow, reduced to what this shell can actually
 * do without vendoring the harness: restart the engine, roll back to another
 * installed engine version, reinstall the current one, read the logs, or export
 * a diagnostics bundle. The page is a plain HTML file that receives one info
 * object over IPC, so it can also be opened by hand while the engine is down.
 */

import path from "node:path";
import type { Translator } from "./i18n";

export type RecoveryReason =
  | { kind: "crash-loop"; count: number }
  | { kind: "start-failed"; message: string }
  | { kind: "manual" };

/** Every action the recovery page can ask the main process to run. */
export type RecoveryActionId =
  | "restart"
  | "rollback"
  | "reinstall"
  | "logs"
  | "diagnostics"
  | "quit";

export function describeRecoveryReason(t: Translator, reason: RecoveryReason): string {
  switch (reason.kind) {
    case "crash-loop":
      return t("recovery.reasonCrashLoop", { count: reason.count });
    case "start-failed":
      return t("recovery.reasonStartFailed", { message: reason.message });
    default:
      return t("recovery.reasonManual");
  }
}

export interface RecoveryInfoInput {
  locale: string;
  reason: RecoveryReason;
  translator: Translator;
  currentVersion: string;
  installedVersions: string[];
  workspaceDir: string;
  logsPath: string;
}

export interface RecoveryInfo {
  locale: string;
  heading: string;
  reason: string;
  hint: string;
  installed: string;
  currentVersion: string;
  rollbackTarget: string;
  canRollback: boolean;
  logsPath: string;
  workspaceDir: string;
  labels: {
    restart: string;
    rollback: string;
    rollbackNone: string;
    reinstall: string;
    openLogs: string;
    diagnostics: string;
    quit: string;
    working: string;
  };
}

/**
 * The newest installed version that is not the one that just failed. Versions
 * are compared as strings here because the caller already sorted them with the
 * engine's version comparator.
 */
export function pickRollbackTarget(installedVersions: string[], currentVersion: string): string {
  const others = installedVersions.filter((version) => version && version !== currentVersion);
  return others.length ? others[others.length - 1] : "";
}

export function buildRecoveryInfo(input: RecoveryInfoInput): RecoveryInfo {
  const t = input.translator;
  const installed = input.installedVersions.filter(Boolean);
  const rollbackTarget = pickRollbackTarget(installed, input.currentVersion);
  return {
    locale: input.locale,
    heading: t("recovery.heading"),
    reason: describeRecoveryReason(t, input.reason),
    hint: t("recovery.hint"),
    installed: installed.length ? t("recovery.installed", { list: installed.join(", ") }) : t("recovery.installedNone"),
    currentVersion: input.currentVersion,
    rollbackTarget,
    canRollback: Boolean(rollbackTarget),
    logsPath: input.logsPath,
    workspaceDir: input.workspaceDir,
    labels: {
      restart: t("recovery.restart"),
      rollback: rollbackTarget ? t("recovery.rollback", { version: rollbackTarget }) : t("recovery.rollbackNone"),
      rollbackNone: t("recovery.rollbackNone"),
      reinstall: t("recovery.reinstall", { version: input.currentVersion || "-" }),
      openLogs: t("recovery.openLogs"),
      diagnostics: t("recovery.exportDiagnostics"),
      quit: t("recovery.quit"),
      working: t("recovery.working"),
    },
  };
}

export function recoveryPagePath(appRoot: string): string {
  return path.join(appRoot, "resources", "recovery.html");
}

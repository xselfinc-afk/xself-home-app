/**
 * OPTIONAL macOS Keychain credential retrieval via the `security` CLI. Credential-based
 * auto-login is OPTIONAL — the durable system works fully with one-time manual login into
 * the dedicated profile; this only enables unattended re-login when a credential is present.
 *
 * NEVER logs, prints, stores in JSON/reports/Supabase, or hardcodes any credential. Setup
 * uses interactive `-w` (no secret on the command line / shell history). Returns null when
 * absent, on non-macOS, or when `security` is unavailable — callers must degrade to manual.
 */
import { execFileSync } from 'child_process';

export function buildFindArgs(service: string, account: string): string[] {
  return ['find-generic-password', '-s', service, '-a', account, '-w'];
}

/** Read a credential; returns null if absent/unavailable. The value is NEVER logged. */
export function getCredential(service: string, account: string): string | null {
  try {
    const out = execFileSync('security', buildFindArgs(service, account), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const v = out.replace(/\r?\n$/, '');
    return v.length > 0 ? v : null;
  } catch {
    return null; // not found / not macOS / security unavailable → caller falls back to manual login
  }
}

export function hasCredential(service: string, account: string): boolean {
  try {
    execFileSync('security', ['find-generic-password', '-s', service, '-a', account], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Exact setup commands to store a credential (interactive `-w` prompt — NO secret in argv). */
export function keychainSetupCommands(service: string, account: string): string[] {
  return [
    `security add-generic-password -a "${account}" -s "${service}" -U -w`,
    `#   ^ you will be prompted for the password interactively (nothing is echoed or stored in shell history)`,
    `# verify (no value printed): security find-generic-password -s "${service}" -a "${account}" >/dev/null 2>&1 && echo OK`,
  ];
}

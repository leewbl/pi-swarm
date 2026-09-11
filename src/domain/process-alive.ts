/**
 * Local-host liveness probe for claimants (architecture §10).
 *
 * Pi Swarm 1.0 assumes every swarm member runs on the local host, so a PID
 * probe is the authoritative "is the process really gone?" signal used once a
 * presence heartbeat has gone stale. It complements presence (which is
 * advisory) and never replaces the claim record as the ownership source.
 */

/**
 * Whether a process is currently alive on this host.
 *
 * - `pid <= 1` (or non-integer) is never a claimant we can reason about.
 * - `process.kill(pid, 0)` delivers no signal; it only probes for existence.
 * - `EPERM` means the process exists but is owned by another user.
 * - `ESRCH` (or any other failure) means the process is gone.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

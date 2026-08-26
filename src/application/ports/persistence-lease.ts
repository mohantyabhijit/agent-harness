/**
 * Synchronous generation fence checked immediately before durable work.
 * Store adapters call assertCurrent inside their transaction so a detached
 * provider generation cannot commit after its owner has revoked the lease.
 */
export interface PersistenceLease {
  readonly id: string;
  assertCurrent(): void;
}

export class PersistenceLeaseRevoked extends Error {
  override readonly name = "PersistenceLeaseRevoked";
  constructor() { super("Persistence lease is no longer current"); }
}

export interface RevocablePersistenceLease extends PersistenceLease {
  revoke(): void;
}

export function createPersistenceLease(id: string): RevocablePersistenceLease {
  if (id.trim().length === 0 || id.length > 200) throw new TypeError("Invalid persistence lease identifier");
  let current = true;
  return {
    id,
    assertCurrent() {
      if (!current) throw new PersistenceLeaseRevoked();
    },
    revoke() { current = false; },
  };
}

/** Independent estimate domains. CPU includes owned byte buffers; source may overlap CPU. */
export type ResourceDomain = 'cpuBytes' | 'gpuBytes' | 'retainedSourceBytes';
export const RESOURCE_DOMAINS: readonly ResourceDomain[] = Object.freeze([
  'cpuBytes',
  'gpuBytes',
  'retainedSourceBytes',
]);
/** Identity is process-local ownership metadata, never a serialized asset identifier. */
export interface AssetResource {
  readonly identity: object;
  readonly cpuBytes: number | null;
  readonly gpuBytes: number | null;
  readonly retainedSourceBytes: number | null;
}
export interface ResourceEstimate {
  readonly resources: readonly AssetResource[];
}
export interface DomainEstimate {
  readonly knownBytes: number;
  readonly unknownResources: number;
}
export interface ResourceTotals {
  readonly cpuBytes: DomainEstimate;
  readonly gpuBytes: DomainEstimate;
  readonly retainedSourceBytes: DomainEstimate;
  readonly resources: number;
  readonly owners: number;
}
export interface ResourceOwner {
  /** Replace the owner's detached estimate, preserving identity sharing across owners. */
  update(estimate: ResourceEstimate): void;
  release(): void;
}
export interface AssetMemoryBudget {
  readonly soft?: Partial<Record<ResourceDomain, number>>;
  /** Pressure policy for required assets, not a physical ceiling or permission to invalidate handles. */
  readonly hard?: Partial<Record<ResourceDomain, number>>;
  /** Optional bound on distinct queued/loading records; existing handles always remain valid. */
  readonly maxPendingLoads?: number;
}
function cost(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}
export function validateEstimate(estimate: ResourceEstimate): ResourceEstimate {
  if (!Array.isArray(estimate.resources) || estimate.resources.length > 100_000)
    throw new RangeError('Asset estimate resource bound exceeded');
  const identities = new Set<object>();
  return {
    resources: estimate.resources.map((resource) => {
      if (
        resource.identity === null ||
        typeof resource.identity !== 'object' ||
        identities.has(resource.identity) ||
        !RESOURCE_DOMAINS.every((domain) => cost(resource[domain]))
      )
        throw new TypeError(
          'Asset estimates require unique object identities and nonnegative integer bytes or null',
        );
      identities.add(resource.identity);
      return Object.freeze({ ...resource });
    }),
  };
}
export function validateMemoryBudget(budget: AssetMemoryBudget | undefined): void {
  if (budget === undefined) return;
  for (const domain of RESOURCE_DOMAINS) {
    const soft = budget.soft?.[domain],
      hard = budget.hard?.[domain];
    if (
      (soft !== undefined && !cost(soft)) ||
      (hard !== undefined && !cost(hard)) ||
      soft === null ||
      hard === null ||
      (soft !== undefined && hard !== undefined && soft > hard)
    )
      throw new RangeError(`Invalid asset ${domain} budget`);
  }
  if (
    budget.maxPendingLoads !== undefined &&
    (!Number.isInteger(budget.maxPendingLoads) ||
      budget.maxPendingLoads < 1 ||
      budget.maxPendingLoads > 100_000)
  )
    throw new RangeError('Invalid asset pending-load budget');
}

/** Conflicting identity estimates use the largest known cost; any unknown owner remains explicit. */
export class ResourceLedger {
  private readonly byOwner = new Map<object, readonly AssetResource[]>();
  private readonly byIdentity = new Map<object, Map<object, AssetResource>>();
  set(owner: object, input: ResourceEstimate): void {
    const estimate = validateEstimate(input);
    this.delete(owner);
    this.byOwner.set(owner, estimate.resources);
    for (const resource of estimate.resources) {
      let owners = this.byIdentity.get(resource.identity);
      if (owners === undefined) {
        owners = new Map();
        this.byIdentity.set(resource.identity, owners);
      }
      owners.set(owner, resource);
    }
  }
  delete(owner: object): void {
    for (const resource of this.byOwner.get(owner) ?? []) {
      const owners = this.byIdentity.get(resource.identity)!;
      owners.delete(owner);
      if (owners.size === 0) this.byIdentity.delete(resource.identity);
    }
    this.byOwner.delete(owner);
  }
  snapshot(reclaimingOwner?: object): ResourceTotals {
    const result = {
      cpuBytes: { knownBytes: 0, unknownResources: 0 },
      gpuBytes: { knownBytes: 0, unknownResources: 0 },
      retainedSourceBytes: { knownBytes: 0, unknownResources: 0 },
      resources: 0,
      owners:
        reclaimingOwner === undefined
          ? this.byOwner.size
          : this.byOwner.has(reclaimingOwner)
            ? 1
            : 0,
    };
    for (const owners of this.byIdentity.values()) {
      if (reclaimingOwner !== undefined && (owners.size !== 1 || !owners.has(reclaimingOwner)))
        continue;
      result.resources++;
      for (const domain of RESOURCE_DOMAINS) {
        let maximum = 0,
          unknown = false;
        for (const estimate of owners.values()) {
          const value = estimate[domain];
          if (value === null) unknown = true;
          else maximum = Math.max(maximum, value);
        }
        const total = result[domain].knownBytes + maximum;
        if (!Number.isSafeInteger(total)) {
          result[domain].knownBytes = Number.MAX_SAFE_INTEGER;
          unknown = true;
        } else result[domain].knownBytes = total;
        if (unknown) result[domain].unknownResources++;
      }
    }
    return result;
  }
}

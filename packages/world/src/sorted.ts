/**
 * Helpers for ascending, duplicate-free arrays of entity ids (numbers) or region ids (strings).
 * Order is `<`: numeric for numbers, UTF-16 code-unit order for strings (the same order as
 * `stringCompare`). Sorted arrays are how sim code iterates sets deterministically
 * (docs/sim.md 2.12 rule 1).
 */

/** Comparator for strings in code-unit order, independent of locale. Sorts region ids. */
export function stringCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Index of the first element of ascending `arr` that is not less than `value`. */
function lowerBound<T extends number | string>(arr: readonly T[], value: T): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as T) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Inserts `value` into ascending `arr` at its sorted position (binary search). Returns `false`
 * and leaves `arr` unchanged when `value` is already present.
 */
export function insertSorted<T extends number | string>(arr: T[], value: T): boolean {
  const i = lowerBound(arr, value);
  if (i < arr.length && arr[i] === value) return false;
  arr.splice(i, 0, value);
  return true;
}

/** Removes `value` from ascending `arr` (binary search). Returns `false` when it was absent. */
export function removeSorted<T extends number | string>(arr: T[], value: T): boolean {
  const i = lowerBound(arr, value);
  if (i >= arr.length || arr[i] !== value) return false;
  arr.splice(i, 1);
  return true;
}

/**
 * Appends the elements present in both ascending arrays `a` and `b` to `out`, in ascending order,
 * and returns `out` (a new array when omitted). Linear merge; neither input is modified.
 */
export function intersectSorted<T extends number | string>(
  a: readonly T[],
  b: readonly T[],
  out: T[] = [],
): T[] {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i] as T;
    const y = b[j] as T;
    if (x < y) i++;
    else if (y < x) j++;
    else {
      out.push(x);
      i++;
      j++;
    }
  }
  return out;
}

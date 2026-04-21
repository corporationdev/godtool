import * as React from "react";
import { Atom, Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react";
import type { ScopeId } from "@executor/sdk";

import { sourcesAtom } from "./atoms";

/**
 * Client-only optimistic-update layer.
 *
 * Mutations that add a row return only after the server roundtrip. The
 * `pendingResourceAtom` family lets a UI insert a placeholder *before* the
 * mutation resolves so the sidebar/list updates instantly. Once the server
 * returns and reactivity refetches the canonical list, callers should remove
 * the placeholder (the dedupe in `mergePending` filters it anyway, but
 * explicit removal keeps the pending set bounded on errors).
 *
 * Resource keys (`"sources"`, `"secrets"`, …) match the strings in
 * `ReactivityKey` but are intentionally not coupled — pending state is purely
 * client-side.
 */

export const PendingResource = {
  sources: "sources",
} as const;

export interface PendingEntry<T> {
  readonly id: string;
  readonly value: T;
}

const pendingFamily = Atom.family((_resource: string) =>
  Atom.make<ReadonlyArray<PendingEntry<unknown>>>([]),
);

const atomFor = <T,>(resource: string) =>
  pendingFamily(resource) as ReturnType<typeof pendingFamily> & {
    readonly __t?: T;
  };

export const usePendingResource = <T,>(resource: string) => {
  const atom = atomFor<T>(resource);
  const pending = useAtomValue(atom) as ReadonlyArray<PendingEntry<T>>;
  const setPending = useAtomSet(atom);

  const add = React.useCallback(
    (entry: PendingEntry<T>) =>
      setPending((prev) => [...(prev as ReadonlyArray<PendingEntry<T>>), entry]),
    [setPending],
  );

  const remove = React.useCallback(
    (id: string) =>
      setPending((prev) =>
        (prev as ReadonlyArray<PendingEntry<T>>).filter((p) => p.id !== id),
      ),
    [setPending],
  );

  const clear = React.useCallback(() => setPending([]), [setPending]);

  return { pending, add, remove, clear };
};

/**
 * Merges pending entries with a server-loaded list. Pending entries whose id
 * already exists on the server are dropped so we never double-render a row
 * once the canonical version arrives.
 */
export const mergePending = <T, R>(
  pending: ReadonlyArray<PendingEntry<T>>,
  server: ReadonlyArray<R>,
  serverId: (row: R) => string,
  fromPending: (entry: PendingEntry<T>) => R,
): ReadonlyArray<R> => {
  if (pending.length === 0) return server;
  const seen = new Set(server.map(serverId));
  const extras = pending.filter((p) => !seen.has(p.id)).map(fromPending);
  if (extras.length === 0) return server;
  return [...extras, ...server];
};

// ---------------------------------------------------------------------------
// Sources — convenience wrappers used by sidebar/list views and add forms.
// Pending entries are global (not per-scope) because the user only sees one
// scope at a time; this keeps the add-form code free of scope plumbing.
// ---------------------------------------------------------------------------

export interface PendingSource {
  readonly name: string;
  readonly kind: string;
  readonly url?: string;
}

/**
 * Sidebar/list helper. Reads `sourcesAtom(scopeId)` and merges any pending
 * placeholder rows in, sorting the combined list by name so the placeholder
 * lands in the same position the canonical row will occupy — no visual jump
 * when the server confirms.
 */
export const useSourcesWithPending = (scopeId: ScopeId) => {
  const result = useAtomValue(sourcesAtom(scopeId));
  const { pending } = usePendingResource<PendingSource>(PendingResource.sources);
  return React.useMemo(
    () =>
      Result.map(result, (sources) => {
        const merged = mergePending(
          pending,
          sources,
          (s) => s.id,
          (p) => ({
            id: p.id,
            name: p.value.name,
            kind: p.value.kind,
            url: p.value.url,
            // The placeholder cannot be removed/refreshed/edited until the
            // server confirms it, so disable those affordances.
            canRemove: false,
            canRefresh: false,
            canEdit: false,
          }),
        );
        return [...merged].sort((a, b) => a.name.localeCompare(b.name));
      }),
    [result, pending],
  );
};

/**
 * Hook for an add form. Returns helpers to push and clear a pending source
 * placeholder. On submit:
 *   const placeholder = beginAdd({ id: namespace, name, kind });
 *   try { await doAdd(...); } finally { placeholder.done(); }
 */
export const usePendingSources = () => {
  const { add, remove } = usePendingResource<PendingSource>(PendingResource.sources);
  return React.useMemo(
    () => ({
      beginAdd: (entry: { id: string } & PendingSource) => {
        add({ id: entry.id, value: { name: entry.name, kind: entry.kind, url: entry.url } });
        return { done: () => remove(entry.id) };
      },
    }),
    [add, remove],
  );
};

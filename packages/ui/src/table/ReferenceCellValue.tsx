import React, { useEffect, useState } from 'react';
import { Link, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { EmptyCellValue } from '@proteinjs/ui';
import { Record, Reference } from '@proteinjs/db';
import { recordFormLink } from '../pages/RecordFormPage';

/**
 * A reference rendered as the referenced record's NAME, linked to its record form — an admin
 * scanning a table reads who/what, not a uuid. Resolution rides `Reference.get()` (the
 * ReferenceCache-backed house path) and lands in a module cache so a page of rows resolves
 * each distinct target once and re-renders never flicker. Until the name arrives — and for
 * records without a usable `name` (or ones this session can't read) — the cell shows the
 * short id in mono: truthful immediately, enriched when the name lands.
 */

/** `${table}:${id}` → display name (null: resolved, but no name to show). */
const resolvedNames = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function resolveDisplayName(tableName: string, id: string): Promise<string | null> {
  const key = `${tableName}:${id}`;
  const settled = resolvedNames.get(key);
  if (settled !== undefined) {
    return Promise.resolve(settled);
  }

  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const record = (await new Reference<Record>(tableName, id).get()) as any;
        const name = record && typeof record.name === 'string' && record.name.trim() ? (record.name as string) : null;
        resolvedNames.set(key, name);
        return name;
      } catch {
        // Unreadable target (row gone, or not visible to this session): the short id stands.
        resolvedNames.set(key, null);
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
  }

  return pending;
}

/** Test seam: a resolved-name cache survives unmounts by design; suites reset it between cases. */
export function clearReferenceNameCache() {
  resolvedNames.clear();
  inflight.clear();
}

export const shortReferenceId = (id: string) => (id.length > 8 ? id.slice(0, 8) : id);

export function ReferenceCellValue({ tableName, id }: { tableName?: string; id?: string | null }) {
  const navigate = useNavigate();
  const [name, setName] = useState<string | null>(() =>
    tableName && id ? resolvedNames.get(`${tableName}:${id}`) ?? null : null
  );

  useEffect(() => {
    if (!tableName || !id) {
      return;
    }

    let cancelled = false;
    resolveDisplayName(tableName, id).then((resolved) => {
      if (!cancelled) {
        setName(resolved);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tableName, id]);

  if (!tableName || !id) {
    return <EmptyCellValue />;
  }

  // recordFormLink already leads with '/' — no extra prefix (a '//'-prefixed href reads as
  // a protocol-relative URL and breaks navigation).
  const url = recordFormLink(tableName, id);
  return (
    <Link
      href={url}
      underline='hover'
      onClick={(event) => {
        // The row's own click navigates to the HOST record; this link goes to the TARGET.
        event.stopPropagation();
        event.preventDefault();
        navigate(url);
      }}
      sx={{ whiteSpace: 'nowrap' }}
    >
      {name !== null ? (
        <Typography variant='body2' component='span'>
          {name}
        </Typography>
      ) : (
        <Typography
          variant='body2'
          component='span'
          title={id}
          sx={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.8125rem' }}
        >
          {shortReferenceId(id)}
        </Typography>
      )}
    </Link>
  );
}

/** A reference array: each target renders through the single-reference presentation. */
export function ReferenceArrayCellValue({ tableName, ids }: { tableName?: string; ids?: string[] | null }) {
  if (!tableName || !ids || ids.length === 0) {
    return <EmptyCellValue />;
  }

  return (
    <Typography variant='body2' component='span' sx={{ overflowWrap: 'anywhere' }}>
      {ids.map((id, index) => (
        <React.Fragment key={id}>
          {index > 0 && ', '}
          <ReferenceCellValue tableName={tableName} id={id} />
        </React.Fragment>
      ))}
    </Typography>
  );
}

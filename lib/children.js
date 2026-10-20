/**
 * Reading which Sessions a delegating plugin records as children of another.
 *
 * The `delegationDepth` and `origin` fields of a session header identify a
 * subagent, but a delegator that creates ordinary root Sessions leaves no such
 * trace — that header is what makes the Client keep showing its children as full
 * sessions, each with its own model picker, and it names no parent either, so the
 * child cannot ask "who delegated me" of anything it holds. The relation still
 * exists, and the delegator publishes it as a Session projection, because a
 * third-party plugin may not append its own session event types.
 *
 * That makes the change feed the only way in: the plugin keeps what each
 * delegating Session currently names and answers membership from it. A view
 * published before this row mounted never reaches the feed, so such a delegation
 * reads as absent until its delegator publishes again.
 *
 * The value is another plugin's wire payload, so every field is validated here at
 * the boundary: a view that does not match its declared fields contributes no
 * child rather than failing the row.
 *
 * @module dsh-llm-quota-retry/lib/children
 */

/**
 * The child Session ids one projection view names.
 *
 * @param value - the view a delegating Session published.
 * @param source - the configured field names for that projection.
 * @returns the child Session ids, in view order; empty when the view matches
 *   nothing this source declared.
 */
export function childIdsOf(value, source) {
  const rows = value === null || typeof value !== 'object' ? undefined : value[source.rowsField]
  if (!Array.isArray(rows)) return []
  const ids = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const id = row[source.sessionIdField]
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return ids
}

/**
 * Whether one session header already says its Session is delegated work.
 *
 * A subagent is created with a depth above zero or the subagent origin; a root
 * session created by a delegator that keeps its children looking like full
 * sessions has neither, which is what the projection read exists for.
 *
 * @param session - the session whose header is read.
 * @returns whether the header marks it as delegated work.
 */
export function headerDelegates(session) {
  const header = session?.header
  if (header === null || typeof header !== 'object') return false
  return header.origin === 'subagent'
    || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}

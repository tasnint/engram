import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type FeedEvent,
  type Memory,
  type MemoryType,
  type Scope,
  type SearchMode,
  type SearchResult,
  type Stats,
} from "./api.js";
import { useLiveFeed, type LiveStatus } from "./useLiveFeed.js";

const MAX_FEED = 40;

interface FeedItem {
  key: string;
  kind: "insert" | "update" | "delete";
  at: string;
  label: string;
  memory?: Memory;
}

export function App() {
  const [scopes, setScopes] = useState<Scope[] | null>(null);
  const [scopeKey, setScopeKey] = useState<string>("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Lets the event handler check what's on screen without re-subscribing on every change.
  const memoriesRef = useRef(memories);
  memoriesRef.current = memories;

  const scope = useMemo(() => scopes?.find((s) => keyOf(s) === scopeKey), [scopes, scopeKey]);

  useEffect(() => {
    api
      .scopes()
      .then((list) => {
        setScopes(list);
        if (list[0]) setScopeKey((current) => current || keyOf(list[0]!));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const reload = useCallback(() => {
    if (!scope) return;
    Promise.all([
      api.stats(scope.namespace, scope.userId),
      api.memories(scope.namespace, scope.userId),
    ])
      .then(([s, m]) => {
        setStats(s);
        setMemories(m);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [scope]);

  useEffect(() => {
    setFeed([]);
    reload();
  }, [reload]);

  // Stats are an aggregation over everything, so refresh them at most once a second while events stream in.
  const statsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refreshStatsSoon = useCallback(() => {
    if (!scope) return;
    clearTimeout(statsTimer.current);
    statsTimer.current = setTimeout(() => {
      api
        .stats(scope.namespace, scope.userId)
        .then(setStats)
        .catch(() => {});
      // Keep the per-user counts in the picker current too.
      api
        .scopes()
        .then(setScopes)
        .catch(() => {});
    }, 1000);
  }, [scope]);

  const onEvent = useCallback(
    (event: FeedEvent) => {
      if (event.kind !== "delete" && event.memory.userId !== scope?.userId) {
        // Another user's memory: don't show it, but refresh the picker so new users appear.
        refreshStatsSoon();
        return;
      }

      setMemories((list) => {
        if (event.kind === "delete") return list.filter((m) => m._id !== event.id);
        const without = list.filter((m) => m._id !== event.id);
        return event.kind === "insert"
          ? [event.memory, ...without]
          : list.map((m) => (m._id === event.id ? event.memory : m));
      });

      setFeed((items) => {
        const known =
          event.kind !== "delete" || memoriesRef.current.some((m) => m._id === event.id);
        if (!known) return items;
        const item: FeedItem = {
          key: `${event.id}-${event.at}-${items.length}`,
          kind: event.kind,
          at: event.at,
          label: describe(event),
          memory: event.kind === "delete" ? undefined : event.memory,
        };
        return [item, ...items].slice(0, MAX_FEED);
      });
      refreshStatsSoon();
    },
    [scope, refreshStatsSoon],
  );

  const status = useLiveFeed(scope?.namespace, onEvent, reload);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <span>Engram</span>
        </div>
        <div className="topbar-right">
          {scopes && scopes.length > 0 && (
            <label className="scope">
              <span className="label">Agent / user</span>
              <select id="scope" value={scopeKey} onChange={(e) => setScopeKey(e.target.value)}>
                {scopes.map((s) => (
                  <option key={keyOf(s)} value={keyOf(s)}>
                    {s.namespace} / {s.userId} ({s.count})
                  </option>
                ))}
              </select>
            </label>
          )}
          <LivePill status={scope ? status : "connecting"} />
        </div>
      </header>

      {error && <div className="banner">{error}</div>}

      {scopes && scopes.length === 0 && (
        <div className="empty-state">
          <h2>No memories yet</h2>
          <p>
            Load sample data with <code>pnpm db:seed</code>, or connect an agent through the MCP
            server. New memories show up here as they're written.
          </p>
        </div>
      )}

      {scope && (
        <main className="grid">
          <StatTiles stats={stats} />

          <div className="col-main">
            <section className="card">
              <h2>New memories, last 30 days</h2>
              <DayChart days={stats?.perDay ?? []} />
            </section>

            <SearchPanel scope={scope} />
          </div>

          <div className="col-side">
            <section className="card">
              <h2>Live feed</h2>
              <Feed items={feed} />
            </section>

            <section className="card">
              <h2>By type</h2>
              <TypeBars byType={stats?.byType ?? []} />
              <h2 className="sub">Top tags</h2>
              <div className="tags">
                {(stats?.topTags ?? []).map((t) => (
                  <span key={t.tag} className="tag">
                    {t.tag} <b>{t.count}</b>
                  </span>
                ))}
                {stats && stats.topTags.length === 0 && <span className="muted">No tags yet</span>}
              </div>
              <h2 className="sub">Most recalled</h2>
              <ol className="recalled">
                {(stats?.mostRecalled ?? []).map((m) => (
                  <li key={m.id}>
                    <span className="clamp">{m.content}</span>
                    <span className="num">{m.accessCount}×</span>
                  </li>
                ))}
                {stats && stats.mostRecalled.length === 0 && (
                  <li className="muted">Nothing recalled yet</li>
                )}
              </ol>
            </section>
          </div>

          <section className="card span-3">
            <h2>
              All memories <span className="muted">· newest first</span>
            </h2>
            <MemoryTable memories={memories} />
          </section>
        </main>
      )}
    </div>
  );
}

function keyOf(s: { namespace: string; userId: string }) {
  return `${s.namespace}\u0000${s.userId}`;
}

function describe(event: FeedEvent): string {
  if (event.kind === "insert") return "Saved";
  if (event.kind === "delete") return "Deleted";
  const changed = event.changed ?? [];
  if (changed.includes("accessCount")) return "Recalled";
  if (changed.includes("status"))
    return event.memory.status === "archived" ? "Archived" : "Restored";
  if (changed.includes("importance")) return "Importance changed";
  return "Updated";
}

function LivePill({ status }: { status: LiveStatus }) {
  const text = { live: "Live", connecting: "Connecting", reconnecting: "Reconnecting" }[status];
  return (
    <span className={`pill live-${status}`} role="status">
      <span className="dot" aria-hidden="true" />
      {text}
    </span>
  );
}

function StatTiles({ stats }: { stats: Stats | null }) {
  const tiles = [
    { label: "Active memories", value: stats?.active },
    { label: "Times recalled", value: stats?.totalRecalls },
    { label: "Average importance", value: stats ? stats.avgImportance.toFixed(2) : undefined },
    { label: "Archived into summaries", value: stats?.archived },
  ];
  return (
    <div className="tiles span-3">
      {tiles.map((t) => (
        <div key={t.label} className="tile">
          <span className="label">{t.label}</span>
          <span className="tile-value num">{t.value ?? "–"}</span>
        </div>
      ))}
    </div>
  );
}

function DayChart({ days }: { days: Stats["perDay"] }) {
  const width = 600;
  const height = 160;
  const pad = { top: 12, right: 8, bottom: 22, left: 28 };
  const max = Math.max(1, ...days.map((d) => d.count));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] ?? 1;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const band = innerW / Math.max(1, days.length);
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="New memories per day for the last 30 days"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className="gridline" />
            <text
              x={pad.left - 6}
              y={y(t)}
              className="axis"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {t}
            </text>
          </g>
        ))}
        {days.map((d, i) => (
          <rect
            key={d.day}
            x={pad.left + i * band + band * 0.15}
            width={band * 0.7}
            y={y(d.count)}
            height={Math.max(0, pad.top + innerH - y(d.count))}
            rx={2}
            className={i === days.length - 1 ? "bar today" : "bar"}
          >
            <title>{`${d.day}: ${d.count}`}</title>
          </rect>
        ))}
        {days.map((d, i) =>
          // A label every week, plus "Today". Skip weekly labels too close to "Today" to fit.
          (i % 7 === 0 && i < days.length - 4) || i === days.length - 1 ? (
            <text
              key={d.day}
              x={pad.left + i * band + band / 2}
              y={height - 6}
              className="axis"
              textAnchor="middle"
            >
              {i === days.length - 1 ? "Today" : shortDate(d.day)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

function niceTicks(max: number): number[] {
  const step = max <= 5 ? 1 : max <= 10 ? 2 : Math.ceil(max / 4 / 5) * 5;
  const out: number[] = [];
  for (let v = 0; v <= max + step - 1 && out.length < 6; v += step) out.push(v);
  return out;
}

function shortDate(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function TypeBars({ byType }: { byType: Stats["byType"] }) {
  const max = Math.max(1, ...byType.map((t) => t.count));
  if (byType.length === 0) return <p className="muted">No active memories</p>;
  return (
    <ul className="typebars">
      {byType.map((t) => (
        <li key={t.type}>
          <TypeChip type={t.type} />
          <span className="track">
            <span
              className={`fill type-${t.type}`}
              style={{ width: `${(t.count / max) * 100}%` }}
            />
          </span>
          <span className="num">{t.count}</span>
        </li>
      ))}
    </ul>
  );
}

function TypeChip({ type }: { type: MemoryType }) {
  return <span className={`chip type-${type}`}>{type}</span>;
}

function Feed({ items }: { items: FeedItem[] }) {
  if (items.length === 0) {
    return (
      <p className="muted">
        Waiting for changes. Anything an agent saves, recalls or deletes appears here as it happens.
      </p>
    );
  }
  return (
    <ul className="feed">
      {items.map((item) => (
        <li key={item.key} className={`feed-item kind-${item.kind}`}>
          <div className="feed-head">
            <span className="feed-label">{item.label}</span>
            <time className="muted num">{new Date(item.at).toLocaleTimeString()}</time>
          </div>
          {item.memory && <p className="clamp">{item.memory.content}</p>}
        </li>
      ))}
    </ul>
  );
}

function SearchPanel({ scope }: { scope: Scope }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setResults(null), [scope]);

  const run = (q = query, m = mode) => {
    if (!q.trim()) return;
    setBusy(true);
    api
      .search(scope.namespace, scope.userId, q, m)
      .then((r) => {
        setResults(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card">
      <h2>Try a recall</h2>
      <p className="muted small">
        Runs the same search an agent would, and shows why each memory ranked where it did. Doesn't
        count as a recall.
      </p>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <input
          id="search-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. why did the deploy fail"
          aria-label="Search query"
        />
        <div className="segmented" role="radiogroup" aria-label="Search mode">
          {(["hybrid", "vector", "text"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? "on" : ""}
              onClick={() => {
                setMode(m);
                if (results) run(query, m);
              }}
            >
              {{ hybrid: "Hybrid", vector: "Meaning", text: "Keywords" }[m]}
            </button>
          ))}
        </div>
        <button type="submit" className="primary" disabled={busy || !query.trim()}>
          {busy ? "Searching" : "Search"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {results && results.length === 0 && <p className="muted">No memories matched.</p>}
      {results && results.length > 0 && (
        <ol className="results">
          {results.map((r) => (
            <li key={r.memory._id}>
              <div className="result-head">
                <TypeChip type={r.memory.type} />
                <span className="result-content">{r.memory.content}</span>
                <span className="score num">{r.score.toFixed(2)}</span>
              </div>
              <div className="signals">
                <Signal label="Relevance" value={r.signals.relevance} weight="60%" />
                <Signal label="Importance" value={r.signals.importance} weight="20%" />
                <Signal label="Recency" value={r.signals.recency} weight="20%" />
                <span className="ranks muted small num">
                  meaning #{r.signals.vectorRank ?? "–"} · keywords #{r.signals.textRank ?? "–"}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Signal({ label, value, weight }: { label: string; value: number; weight: string }) {
  return (
    <span className="signal" title={`${label}: ${value.toFixed(2)} (weight ${weight})`}>
      <span className="small muted">{label}</span>
      <span className="mini-track">
        <span className="mini-fill" style={{ width: `${value * 100}%` }} />
      </span>
    </span>
  );
}

function MemoryTable({ memories }: { memories: Memory[] }) {
  if (memories.length === 0) return <p className="muted">No memories for this user.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Memory</th>
            <th className="right">Importance</th>
            <th className="right">Recalled</th>
            <th className="right">Saved</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {memories.map((m) => (
            <tr key={m._id} className={m.status === "archived" ? "archived" : ""}>
              <td>
                <TypeChip type={m.type} />
              </td>
              <td className="content-cell">
                {m.content}
                {m.tags.length > 0 && <span className="muted small"> · {m.tags.join(", ")}</span>}
                {m.status === "archived" && <span className="muted small"> · archived</span>}
              </td>
              <td className="right num">{m.importance.toFixed(2)}</td>
              <td className="right num">{m.accessCount}</td>
              <td className="right num muted">{new Date(m.createdAt).toLocaleDateString()}</td>
              <td className="right">
                <DeleteButton id={m._id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Two clicks to delete: the first asks, the second forgets. The row disappears when the change stream reports it. */
function DeleteButton({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "confirm" | "busy" | "error">("idle");
  useEffect(() => {
    if (state !== "confirm") return;
    const timer = setTimeout(() => setState("idle"), 4000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className={`link-button ${state === "confirm" ? "danger" : ""}`}
      disabled={state === "busy"}
      onClick={() => {
        if (state !== "confirm") return setState("confirm");
        setState("busy");
        api.forget(id).catch(() => setState("error"));
      }}
    >
      {
        { idle: "Delete", confirm: "Confirm delete", busy: "Deleting", error: "Couldn't delete" }[
          state
        ]
      }
    </button>
  );
}

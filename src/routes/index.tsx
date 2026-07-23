import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import * as XLSX from "xlsx";
import {
  searchBusinesses,
  type BusinessRow,
  type SearchPageResult,
} from "@/lib/search.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "B2C Leads By Sharp Solutions 360" },
      {
        name: "description",
        content:
          "Scan Google Business Profiles by keyword and city. Find businesses with no Google Posts in the last 90 days, then export to CSV, Excel, or JSON.",
      },
      { property: "og:title", content: "B2C Leads By Sharp Solutions 360" },
      {
        property: "og:description",
        content:
          "Find Google Business Profiles that haven't posted in 90+ days. Export leads to CSV, Excel, or JSON.",
      },
      { property: "og:image", content: "/sharp.png" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: "/sharp.png" },
    ],
    links: [
      { rel: "icon", href: "/favicon.ico" },
      { rel: "apple-touch-icon", href: "/sharp.png" },
    ],
  }),
  component: Index,
});

type Radius = 5 | 10 | 25 | 50;
type HistoryEntry = {
  id: string;
  keyword: string;
  location: string;
  radius: Radius;
  target: number;
  timestamp: number;
  count: number;
};

type FilterState = {
  postWindow: "any" | "30" | "60" | "90" | "none90";
  minRating: number | null;
  maxReviews: number | null;
  hasWebsite: "any" | "yes" | "no";
  hasFacebook: "any" | "yes" | "no";
  noInstagram: boolean;
};

const HISTORY_KEY = "gbp_search_history_v1";

function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveHistory(h: HistoryEntry[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 25)));
}

function Index() {
  const search = useServerFn(searchBusinesses);
  const [keyword, setKeyword] = useState("Auto Detailing");
  const [location, setLocation] = useState("Austin, Texas");
  const [radius, setRadius] = useState<Radius>(25);
  const [target, setTarget] = useState(100);

  const [rows, setRows] = useState<BusinessRow[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "paused" | "done" | "error">(
    "idle",
  );
  const [progress, setProgress] = useState({ current: 0, target: 0 });
  const [failed, setFailed] = useState<number[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const pausedRef = useRef(false);
  const cancelRef = useRef(false);

  useEffect(() => setHistory(loadHistory()), []);

  const [filters, setFilters] = useState<FilterState>({
    postWindow: "any",
    minRating: null,
    maxReviews: null,
    hasWebsite: "any",
    hasFacebook: "any",
    noInstagram: false,
  });

  const log = (m: string) =>
    setLogs((l) => [`[${new Date().toLocaleTimeString()}] ${m}`, ...l].slice(0, 200));

  async function runSearch() {
    if (status === "running") return;
    setRows([]);
    setLogs([]);
    setFailed([]);
    setStatus("running");
    pausedRef.current = false;
    cancelRef.current = false;
    const pages = Math.ceil(target / 20);
    setProgress({ current: 0, target: pages });
    log(`Starting search: "${keyword}" in ${location} · radius ${radius}mi · up to ${target}`);
    const collected: BusinessRow[] = [];
    const failedPages: number[] = [];

    for (let p = 0; p < pages; p++) {
      if (cancelRef.current) break;
      while (pausedRef.current) {
        await new Promise((r) => setTimeout(r, 250));
        if (cancelRef.current) break;
      }
      try {
        const res: SearchPageResult = await search({
          data: { keyword, location, start: p * 20, radiusMiles: radius },
        });
        if (res.error) {
          log(`Page ${p + 1} error: ${res.error}`);
          failedPages.push(p);
        } else {
          collected.push(...res.results);
          setRows([...collected]);
          log(`Page ${p + 1}: +${res.results.length} results (total ${collected.length})`);
          if (!res.has_more && res.results.length === 0) {
            log("No more results returned. Stopping.");
            setProgress({ current: p + 1, target: pages });
            break;
          }
        }
      } catch (e) {
        log(`Page ${p + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
        failedPages.push(p);
      }
      setProgress({ current: p + 1, target: pages });
    }
    setFailed(failedPages);
    setStatus(cancelRef.current ? "idle" : "done");
    log(`Finished. ${collected.length} businesses collected. ${failedPages.length} failed pages.`);
    const entry: HistoryEntry = {
      id: crypto.randomUUID(),
      keyword,
      location,
      radius,
      target,
      timestamp: Date.now(),
      count: collected.length,
    };
    const next = [entry, ...history];
    setHistory(next);
    saveHistory(next);
  }

  async function retryFailed() {
    if (!failed.length) return;
    setStatus("running");
    log(`Retrying ${failed.length} failed page(s)`);
    const still: number[] = [];
    const collected = [...rows];
    for (const p of failed) {
      try {
        const res = await search({
          data: { keyword, location, start: p * 20, radiusMiles: radius },
        });
        if (res.error) {
          still.push(p);
          log(`Retry page ${p + 1} error: ${res.error}`);
        } else {
          collected.push(...res.results);
          setRows([...collected]);
          log(`Retry page ${p + 1}: +${res.results.length} results`);
        }
      } catch (e) {
        still.push(p);
        log(`Retry page ${p + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setFailed(still);
    setStatus("done");
  }

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filters.minRating != null && (r.rating ?? 0) < filters.minRating) return false;
      if (filters.maxReviews != null && (r.reviews ?? 0) >= filters.maxReviews) return false;
      if (filters.hasWebsite === "yes" && !r.website) return false;
      if (filters.hasWebsite === "no" && r.website) return false;
      if (filters.hasFacebook === "yes" && !r.facebook) return false;
      if (filters.hasFacebook === "no" && r.facebook) return false;
      if (filters.noInstagram && r.instagram) return false;
      if (filters.postWindow !== "any") {
        const d = r.days_since_last_post;
        if (filters.postWindow === "none90") {
          // For "No posts in 90+ days": include if days_since_last_post is unknown (not available) OR >=90
          if (d != null && d < 90) return false;
        } else {
          const max = parseInt(filters.postWindow, 10);
          // For "Within N days": only include if we know days_since_last_post and it's <= max
          if (d == null || d > max) return false;
        }
      }
      return true;
    });
  }, [rows, filters]);

  function exportCSV() {
    const headers = Object.keys(filtered[0] ?? {}) as (keyof BusinessRow)[];
    const csv = [
      headers.join(","),
      ...filtered.map((r) =>
        headers
          .map((h) => {
            const v = (r as any)[h];
            const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
            return `"${s.replace(/"/g, '""')}"`;
          })
          .join(","),
      ),
    ].join("\n");
    downloadBlob(new Blob([csv], { type: "text/csv" }), "gbp-results.csv");
  }
  function exportJSON() {
    downloadBlob(
      new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" }),
      "gbp-results.json",
    );
  }
  function exportXLSX() {
    const ws = XLSX.utils.json_to_sheet(
      filtered.map((r) => ({ ...r, gps: r.gps ? `${r.gps.lat},${r.gps.lng}` : "" })),
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "GBP");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    downloadBlob(new Blob([buf]), "gbp-results.xlsx");
  }
  function downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  const pct = progress.target ? (progress.current / progress.target) * 100 : 0;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-7xl px-6 py-6 flex items-center gap-4">
          <img 
            src="/sharp.png" 
            alt="Sharp Solutions 360 Logo" 
            className="w-16 h-16 object-contain"
          />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              B2C Leads By Sharp Solutions 360
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Find Google Business Profiles by keyword and city, then filter and export leads.
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-6 space-y-6">
        <section className="rounded-lg border border-border bg-card p-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
            <div className="md:col-span-2">
              <label className="text-xs font-medium text-muted-foreground">Keyword</label>
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="Auto Detailing"
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="md:col-span-2">
              <label className="text-xs font-medium text-muted-foreground">City / State</label>
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Austin, Texas"
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Radius</label>
              <select
                value={radius}
                onChange={(e) => setRadius(Number(e.target.value) as Radius)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {[5, 10, 25, 50].map((r) => (
                  <option key={r} value={r}>
                    {r} miles
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-4">
              <label className="text-xs font-medium text-muted-foreground">
                Businesses to scan: {target}
              </label>
              <input
                type="range"
                min={50}
                max={1000}
                step={50}
                value={target}
                onChange={(e) => setTarget(Number(e.target.value))}
                className="mt-2 w-full accent-[color:var(--primary)]"
              />
            </div>
            <div className="flex items-end gap-2">
              {status !== "running" && status !== "paused" ? (
                <button
                  onClick={runSearch}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  Start scan
                </button>
              ) : (
                <>
                  <button
                    onClick={() => {
                      pausedRef.current = !pausedRef.current;
                      setStatus(pausedRef.current ? "paused" : "running");
                      log(pausedRef.current ? "Paused" : "Resumed");
                    }}
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    {pausedRef.current ? "Resume" : "Pause"}
                  </button>
                  <button
                    onClick={() => {
                      cancelRef.current = true;
                      log("Stopping…");
                    }}
                    className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    Stop
                  </button>
                </>
              )}
              {failed.length > 0 && status !== "running" && (
                <button
                  onClick={retryFailed}
                  className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  Retry {failed.length} failed
                </button>
              )}
            </div>
          </div>

          {progress.target > 0 && (
            <div className="mt-5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {status === "running"
                    ? "Scanning…"
                    : status === "paused"
                      ? "Paused"
                      : status === "done"
                        ? "Done"
                        : "Idle"}
                </span>
                <span>
                  {progress.current}/{progress.target} pages · {rows.length} results
                </span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}
        </section>

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
          <aside className="space-y-4 rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Filters</h2>

            <div>
              <label className="text-xs text-muted-foreground">Last post</label>
              <select
                value={filters.postWindow}
                onChange={(e) =>
                  setFilters({ ...filters, postWindow: e.target.value as any })
                }
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                <option value="any">Any</option>
                <option value="30">Within 30 days</option>
                <option value="60">Within 60 days</option>
                <option value="90">Within 90 days</option>
                <option value="none90">No posts in 90+ days</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted-foreground">Min rating</label>
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  max={5}
                  value={filters.minRating ?? ""}
                  onChange={(e) =>
                    setFilters({
                      ...filters,
                      minRating: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="e.g. 4.5"
                  className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Max reviews</label>
                <input
                  type="number"
                  min={0}
                  value={filters.maxReviews ?? ""}
                  onChange={(e) =>
                    setFilters({
                      ...filters,
                      maxReviews: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="e.g. 100"
                  className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-muted-foreground">Website</label>
              <select
                value={filters.hasWebsite}
                onChange={(e) =>
                  setFilters({ ...filters, hasWebsite: e.target.value as any })
                }
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                <option value="any">Any</option>
                <option value="yes">Has website</option>
                <option value="no">No website</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-muted-foreground">Facebook</label>
              <select
                value={filters.hasFacebook}
                onChange={(e) =>
                  setFilters({ ...filters, hasFacebook: e.target.value as any })
                }
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                <option value="any">Any</option>
                <option value="yes">Has Facebook</option>
                <option value="no">No Facebook</option>
              </select>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={filters.noInstagram}
                onChange={(e) =>
                  setFilters({ ...filters, noInstagram: e.target.checked })
                }
              />
              No Instagram
            </label>

            <div className="pt-2 border-t border-border">
              <div className="text-xs font-medium mb-2">
                Export ({filtered.length})
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  disabled={!filtered.length}
                  onClick={exportCSV}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
                >
                  CSV
                </button>
                <button
                  disabled={!filtered.length}
                  onClick={exportXLSX}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
                >
                  Excel
                </button>
                <button
                  disabled={!filtered.length}
                  onClick={exportJSON}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
                >
                  JSON
                </button>
              </div>
            </div>

            <div className="pt-2 border-t border-border">
              <div className="text-xs font-medium mb-2">Search history</div>
              <ul className="space-y-1 max-h-56 overflow-auto pr-1">
                {history.length === 0 && (
                  <li className="text-xs text-muted-foreground">No searches yet.</li>
                )}
                {history.map((h) => (
                  <li key={h.id}>
                    <button
                      onClick={() => {
                        setKeyword(h.keyword);
                        setLocation(h.location);
                        setRadius(h.radius);
                        setTarget(h.target);
                      }}
                      className="w-full rounded border border-border bg-background p-2 text-left text-xs hover:bg-muted"
                    >
                      <div className="font-medium truncate">{h.keyword}</div>
                      <div className="text-muted-foreground truncate">
                        {h.location} · {h.radius}mi · {h.count} results
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </aside>

          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-card">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-muted text-xs uppercase text-muted-foreground">
                    <tr>
                      {[
                        "Name",
                        "Category",
                        "Rating",
                        "Reviews",
                        "Phone",
                        "Website",
                        "Address",
                        "Last post",
                        "Maps",
                      ].map((h) => (
                        <th key={h} className="px-3 py-2 text-left font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">
                          {status === "running"
                            ? "Scanning…"
                            : "No results yet. Run a scan to begin."}
                        </td>
                      </tr>
                    )}
                    {filtered.map((r) => (
                      <tr key={r.place_id || r.name} className="border-t border-border">
                        <td className="px-3 py-2 font-medium">{r.name}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.category ?? "—"}</td>
                        <td className="px-3 py-2">{r.rating ?? "—"}</td>
                        <td className="px-3 py-2">{r.reviews ?? "—"}</td>
                        <td className="px-3 py-2">{r.phone ?? "—"}</td>
                        <td className="px-3 py-2 max-w-[200px] truncate">
                          {r.website ? (
                            <a
                              href={r.website}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline"
                            >
                              {r.website.replace(/^https?:\/\//, "")}
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2 max-w-[240px] truncate text-muted-foreground">
                          {r.address ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          {r.days_since_last_post != null ? (
                            <span
                              className={
                                r.days_since_last_post > 90
                                  ? "text-danger"
                                  : "text-success"
                              }
                            >
                              {r.days_since_last_post}d
                            </span>
                          ) : (
                            <span className="text-muted-foreground">unknown</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {r.maps_url ? (
                            <a
                              href={r.maps_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline"
                            >
                              Open
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-2 text-sm font-semibold">Live logs</h2>
              <div className="max-h-56 overflow-auto rounded bg-muted p-2 font-mono text-xs">
                {logs.length === 0 ? (
                  <div className="text-muted-foreground">No activity yet.</div>
                ) : (
                  logs.map((l, i) => <div key={i}>{l}</div>)
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

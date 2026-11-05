import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Project, StoredEvent, Task, TaskStatus } from "../src/types.js";
import "./style.css";

type Report = { task: Task; project: { id: string; name: string }; eventCount: number; observedCommands: { command: string; result: string }[]; verification: string };
type DiffResult = { diff: string; truncated: boolean };

function App() {
  const [base, setBase] = useState(localStorage.getItem("bridgeBase") || window.location.origin);
  const [token, setToken] = useState(sessionStorage.getItem("bridgeToken") || "");
  const [connected, setConnected] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState("");
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const eventCursor = useRef(0);
  const [report, setReport] = useState<Report | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"activity" | "report" | "diff">("activity");
  const activeCount = useMemo(() => tasks.filter(t => ["QUEUED", "RUNNING"].includes(t.status)).length, [tasks]);

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((data as { message?: string }).message || `Request failed (${response.status})`);
    return data as T;
  }
  async function refresh() {
    try {
      const [p, t] = await Promise.all([api<{ projects: Project[] }>("/v1/projects"), api<{ tasks: Task[] }>("/v1/tasks")]);
      setProjects(p.projects); setProjectId(previous => previous || p.projects[0]?.id || ""); setTasks(t.tasks); setConnected(true); setError("");
      if (!selected && t.tasks[0]) setSelected(t.tasks[0].id);
    } catch (e) { setConnected(false); setError(e instanceof Error ? e.message : "Connection failed"); }
  }
  useEffect(() => { if (token) void refresh(); }, []);
  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(() => void refresh(), 1800);
    return () => window.clearInterval(timer);
  }, [connected, base, token, selected]);
  useEffect(() => {
    if (!selected || !connected) { setEvents([]); setReport(null); return; }
    let alive = true;
    eventCursor.current = 0;
    setEvents([]);
    const load = async () => {
      try {
        const [e, r] = await Promise.all([api<{ events: StoredEvent[] }>(`/v1/tasks/${selected}/events?after=${eventCursor.current}`), api<Report>(`/v1/tasks/${selected}/report`)]);
        if (alive) { if (e.events.length) { eventCursor.current = e.events.at(-1)!.id; setEvents(previous => [...previous, ...e.events]); } setReport(r); }
      } catch (err) { if (alive) setError(err instanceof Error ? err.message : "Unable to load task"); }
    };
    void load(); const timer = window.setInterval(() => void load(), 1500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [selected, connected, base, token]);
  useEffect(() => {
    if (!connected || !report) { setDiff(null); return; }
    let alive = true;
    void api<DiffResult>(`/v1/projects/${report.project.id}/diff`).then(value => { if (alive) setDiff(value); }).catch(() => { if (alive) setDiff({diff:"",truncated:false}); });
    return () => { alive = false; };
  }, [connected, report?.project.id, base, token]);
  async function connect() {
    sessionStorage.setItem("bridgeToken", token); localStorage.setItem("bridgeBase", base.replace(/\/$/, ""));
    setBase(base.replace(/\/$/, "")); setBusy(true); await refresh(); setBusy(false);
  }
  async function submit(continuing = false) {
    if (!prompt.trim()) return;
    setBusy(true); setError("");
    try {
      const path = continuing ? `/v1/tasks/${selected}/continue` : "/v1/tasks";
      const payload = continuing ? { prompt } : { projectId, prompt };
      if (!payload.projectId && !continuing) throw new Error("Select a registered repository first.");
      const result = await api<{ task: Task }>(path, { method: "POST", body: JSON.stringify(payload) });
      setPrompt(""); setSelected(result.task.id); setTab("activity"); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Task could not be started"); }
    setBusy(false);
  }
  async function cancel() { try { await api(`/v1/tasks/${selected}/cancel`, { method: "POST", body: "{}" }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Cancel failed"); } }
  const current = tasks.find(t => t.id === selected);
  const canContinue = Boolean(current?.threadId && ["SUCCEEDED", "FAILED", "INTERRUPTED"].includes(current.status));
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">C</span><div><b>CODEX BRIDGE</b><small>LOCAL WORKSPACE</small></div></div>
      <div className="side-label">WORKSPACE</div><div className="nav active"><span>▦</span> Overview</div><div className="side-label repo-label">REGISTERED REPOSITORIES <i>{projects.length}</i></div>
      {projects.map(p => <div className="repo" key={p.id}><span className="repo-dot"/><span>{p.name}</span><small>LOCAL</small></div>)}
      <div className="side-footer"><span className={connected ? "pulse online" : "pulse"}/>{connected ? "Bridge connected" : "Bridge offline"}<small>v0.2.0 · READ ONLY</small></div>
    </aside>
    <main className="main"><header><div className="crumb">Workspace <b>/</b> Overview</div><div className="header-right"><span className={connected ? "status-text online" : "status-text"}><i/> {connected ? "SYSTEM OPERATIONAL" : "DISCONNECTED"}</span><button className="icon-btn" title="Refresh" onClick={() => void refresh()}>↻</button><div className="avatar">MA</div></div></header>
      <section className="content"><div className="title-row"><div><div className="eyebrow">THURSDAY, NOVEMBER 5, 2026 <span className="live-chip">● LIVE</span></div><h1>Workspace overview</h1><p>Monitor and direct your local Codex sessions.</p></div><button className="primary" onClick={() => document.getElementById("task-prompt")?.focus()}><span>＋</span> New task</button></div>
        {!connected && <div className="connect card"><div><b>Connect to your local bridge</b><p>Start the bridge API, then provide its bearer token.</p></div><input aria-label="Bridge URL" value={base} onChange={e => setBase(e.target.value)} placeholder="http://127.0.0.1:49441"/><input aria-label="Bearer token" value={token} onChange={e => setToken(e.target.value)} type="password" placeholder="Local bearer token"/><button className="primary" disabled={busy || !token} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</button></div>}
        {error && <div className="error-banner"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
        <div className="stats"><Stat label="REGISTERED REPOSITORIES" value={projects.length.toString()} detail="Local Git roots" icon="▦"/><Stat label="ACTIVE TASKS" value={activeCount.toString().padStart(2,"0")} detail="Across all repositories" icon="◷" active={activeCount>0}/><Stat label="COMPLETED TASKS" value={tasks.filter(t=>t.status==="SUCCEEDED").length.toString()} detail="Persisted in local history" icon="✓"/><Stat label="EXECUTION MODE" value="READ-ONLY" detail="Sandbox enforced" icon="⌑"/></div>
        <div className="grid"><section className="card tasks-card"><div className="card-head"><div><h2>Task activity</h2><p>Recent sessions from your registered repositories</p></div><span className="count">{tasks.length} TASKS</span></div>
          <div className="table-wrap"><table><thead><tr><th>TASK</th><th>REPOSITORY</th><th>STATUS</th><th>UPDATED</th></tr></thead><tbody>{tasks.map(task => <tr key={task.id} className={selected===task.id?"selected":""} onClick={() => {setSelected(task.id);setTab("activity");}}><td><b>{task.prompt}</b><small>#{task.id.slice(0,8)}</small></td><td>{projects.find(p=>p.id===task.projectId)?.name || "Repository"}</td><td><Status status={task.status}/></td><td>{new Date(task.updatedAt).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}</td></tr>)}{!tasks.length && <tr><td className="empty" colSpan={4}>No tasks yet. Submit a prompt below to start a session.</td></tr>}</tbody></table></div>
          <div className="submit-box"><label htmlFor="task-prompt">TASK INSTRUCTION</label><textarea id="task-prompt" value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="Ask Codex to inspect your repository…" onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter")void submit();}}/><div className="submit-foot"><select aria-label="Repository" value={projectId} onChange={e=>setProjectId(e.target.value)}>{projects.map(project=><option value={project.id} key={project.id}>{project.name}</option>)}</select><span>⌘ Enter to run · Read-only sandbox</span><button className="primary" disabled={!connected||busy||!prompt.trim()||!projectId} onClick={()=>void submit()}>{busy?"Starting…":"Run task →"}</button></div></div>
        </section>
        <section className="card detail-card"><div className="detail-head"><div><span className="eyebrow">SESSION INSPECTOR</span><h2>{current ? current.prompt : "Select a task"}</h2></div>{current && ["RUNNING","QUEUED"].includes(current.status)&&<button className="outline danger" onClick={()=>void cancel()}>Cancel</button>}</div>
          <div className="tabs"><button className={tab==="activity"?"active":""} onClick={()=>setTab("activity")}>Activity</button><button className={tab==="report"?"active":""} onClick={()=>setTab("report")}>Report</button><button className={tab==="diff"?"active":""} onClick={()=>setTab("diff")}>Git diff</button></div>
          <div className="detail-body">{tab==="activity"&&<div className="timeline">{events.map(event=><div className="event" key={event.id}><span className={`event-mark ${event.type.includes("failed")?"bad":event.type.includes("completed")?"good":""}`}>{event.type.includes("completed")?"✓":"·"}</span><div><div className="event-title">{event.type.replaceAll("."," ")}</div><p>{event.detail}</p><small>{new Date(event.createdAt).toLocaleTimeString()}</small></div></div>)}{!events.length&&<div className="empty-state">Select a task to inspect its live event stream.</div>}</div>}
            {tab==="report"&&<div className="report-view">{report?<><div className="report-summary"><Status status={report.task.status}/><span>{report.eventCount} recorded events</span></div><h3>Agent response</h3><pre>{report.task.result||report.task.error||"Waiting for the turn to finish…"}</pre>{report.observedCommands.length>0&&<><h3>Observed command results</h3><pre>{report.observedCommands.map(command=>`${command.command} — ${command.result}`).join("\n")}</pre></>}<div className="notice">{report.verification}</div></>:<div className="empty-state">No report selected.</div>}</div>}
            {tab==="diff"&&<div className="report-view">{diff?.diff?<><pre className="diff-code">{diff.diff}{diff.truncated?"\n… output truncated":""}</pre><div className="notice">Read-only diff against HEAD in the registered repository.</div></>:<div className="empty-state diff-empty"><span>⌘</span><b>No changes from HEAD</b><p>Git reports no staged or unstaged tracked-file changes in this repository.</p></div>}</div>}</div>
          {canContinue&&<div className="continue"><span>Continue this Codex thread</span><button className="outline" disabled={busy||!prompt.trim()} onClick={()=>void submit(true)}>Continue session →</button></div>}
        </section></div>
        <footer><span>CODEX BRIDGE <i>·</i> PRIVATE LOCAL CONTROL PLANE</span><span>All tasks run on your machine <i>·</i> <b>Read-only</b></span></footer>
      </section>
    </main>
  </div>;
}
function Stat({label,value,detail,icon,active=false}:{label:string;value:string;detail:string;icon:string;active?:boolean}){return <div className="card stat"><div className="stat-top"><span>{label}</span><i>{icon}</i></div><strong className={active?"active-number":""}>{value}</strong><small>{detail}</small></div>}
function Status({status}:{status:TaskStatus}){return <span className={`badge ${status.toLowerCase()}`}><i/>{status}</span>}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);

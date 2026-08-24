const $ = (selector) => document.querySelector(selector);

function formatUptime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const days = Math.floor(value / 86400); const hours = Math.floor((value % 86400) / 3600); const minutes = Math.floor((value % 3600) / 60);
  return [days ? `${days}d` : null, hours || days ? `${hours}h` : null, `${minutes}m`].filter(Boolean).join(" ");
}

function makeDetail(label, value) {
  const row = document.createElement("span"); const name = document.createElement("small"); const content = document.createElement("strong");
  name.textContent = label; content.textContent = value; row.append(name, content); return row;
}

function renderCluster(cluster, latencyMs) {
  const cell = document.createElement("button"); const label = document.createElement("span"); const tooltip = document.createElement("span"); const title = document.createElement("b");
  cell.type = "button"; cell.className = `cluster-hex is-${cluster.status}`; cell.setAttribute("aria-label", `${cluster.id}, ${cluster.statusLabel}`); label.textContent = cluster.id.replace("cluster-", "");
  tooltip.className = "cluster-tooltip"; title.textContent = cluster.id; title.prepend(Object.assign(document.createElement("i"), { className: cluster.status }));
  tooltip.append(title, makeDetail("Status", cluster.statusLabel), makeDetail("Uptime", formatUptime(cluster.uptimeSeconds)), makeDetail("Latency", Number.isFinite(latencyMs) ? `${latencyMs}ms` : "Unavailable"), makeDetail("Servers", Number(cluster.serverCount || 0).toLocaleString()));
  cell.append(label, tooltip); return cell;
}

function render(data) {
  const clusters = Array.isArray(data.clusters) ? data.clusters : []; const normal = clusters.filter(({ status }) => status === "normal").length; const serverTotal = clusters.reduce((sum, item) => sum + (Number(item.serverCount) || 0), 0);
  $("[data-cluster-total]").textContent = clusters.length.toLocaleString(); $("[data-cluster-operating]").textContent = normal.toLocaleString(); $("[data-cluster-servers]").textContent = serverTotal.toLocaleString(); $("[data-cluster-latency]").textContent = Number.isFinite(data.latencyMs) ? `${data.latencyMs}ms` : "—";
  const priority = ["offline", "outage", "maintenance", "normal"]; const overall = priority.find((status) => clusters.some((cluster) => cluster.status === status)) || "offline"; const status = $("[data-overall-status]"); status.className = `overall-cluster-status is-${overall}`; status.querySelector("span").textContent = overall === "normal" ? "All systems normal" : overall === "outage" ? "Service disruption" : overall === "maintenance" ? "Maintenance active" : "Cluster offline";
  const hive = $("[data-cluster-hive]"); hive.replaceChildren(...clusters.map((cluster) => renderCluster(cluster, data.latencyMs))); $("[data-cluster-updated]").textContent = `Last checked ${new Date(data.checkedAt).toLocaleTimeString()}. Refreshes every 30 seconds.`;
}

async function refresh() {
  try { const response = await fetch("/api/clusters/status", { cache: "no-store" }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "Status unavailable."); render(body); }
  catch { $("[data-cluster-updated]").textContent = "Duck could not refresh cluster status. Retrying shortly."; const status = $("[data-overall-status]"); status.className = "overall-cluster-status is-offline"; status.querySelector("span").textContent = "Status unavailable"; }
}

$("[data-cluster-lookup]").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector("button"); const serverId = form.serverId.value.trim(); const result = $("[data-cluster-lookup-result]"); const fields = result.querySelectorAll("strong");
  if (!/^\d{10,20}$/.test(serverId)) { fields[0].textContent = "—"; fields[1].textContent = "Invalid ID"; return; }
  button.disabled = true; button.textContent = "Checking…";
  try { const response = await fetch(`/api/clusters/lookup?server_id=${encodeURIComponent(serverId)}`, { cache: "no-store" }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "Lookup failed."); fields[0].textContent = body.cluster.id; fields[1].textContent = body.cluster.statusLabel; result.dataset.status = body.cluster.status; }
  catch (error) { fields[0].textContent = "—"; fields[1].textContent = error.message; delete result.dataset.status; }
  finally { button.disabled = false; button.textContent = "Look up"; }
});

refresh(); setInterval(refresh, 30_000);

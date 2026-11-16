(function () {
  const ORDER = { CONFIRMADO: 0, PENDIENTE: 1, RECHAZADO: 2 };
  const grid = document.getElementById("grid");
  const q = document.getElementById("q");
  let people = [];
  let filter = "all";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  function render() {
    const term = norm(q.value.trim());
    const list = people
      .filter((p) => filter === "all" || p.status === filter)
      .filter((p) => !term || norm(p.name).includes(term) || norm(p.nick).includes(term))
      .sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || a.name.localeCompare(b.name, "es"));

    if (!list.length) {
      grid.innerHTML = `<div class="empty"><img src="assets/icon.png" alt="">${
        people.length ? "No hay participantes que coincidan." : "Todavía no hay participantes en la lista."
      }</div>`;
      return;
    }

    grid.innerHTML = list.map((p, i) => `
      <article class="card s-${esc(p.status)}" style="animation-delay:${Math.min(i, 20) * 30}ms">
        <div class="avatar">${p.avatar
          ? `<img src="${esc(p.avatar)}" alt="" loading="lazy">`
          : esc(initials(p.name))}</div>
        <h2 class="name">${esc(p.name)}</h2>
        ${p.nick ? `<p class="nick">${esc(p.nick)}</p>` : ""}
        <span class="badge ${esc(p.status)}">${esc(p.status)}</span>
      </article>`).join("");
  }

  function counts() {
    const c = { all: people.length, CONFIRMADO: 0, PENDIENTE: 0, RECHAZADO: 0 };
    people.forEach((p) => { if (p.status in c) c[p.status]++; });
    Object.entries(c).forEach(([k, v]) => { document.getElementById("c-" + k).textContent = v; });
  }

  document.querySelectorAll(".stat").forEach((b) => b.addEventListener("click", () => {
    filter = b.dataset.filter;
    document.querySelectorAll(".stat").forEach((x) => x.classList.toggle("active", x === b));
    render();
  }));
  q.addEventListener("input", render);

  fetch("data/participants.json?t=" + Date.now(), { cache: "no-store" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => { people = Array.isArray(data) ? data : []; counts(); render(); })
    .catch(() => { grid.innerHTML = `<div class="empty">No se pudo cargar la lista. Probá recargar la página.</div>`; });
})();

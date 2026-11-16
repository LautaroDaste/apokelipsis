(function () {
  "use strict";
  const STATUSES = ["CONFIRMADO", "PENDIENTE", "RECHAZADO"];
  const ORDER = { CONFIRMADO: 0, PENDIENTE: 1, RECHAZADO: 2 };
  const AVATAR_RE = /^avatars\/[a-z0-9-]{1,80}\.(webp|jpg|png)$/;
  const grid = document.getElementById("grid");

  // Treat the JSON as untrusted: keep only known fields with known shapes.
  function clean(p) {
    if (!p || typeof p !== "object") return null;
    const name = typeof p.name === "string" ? p.name.trim().slice(0, 40) : "";
    if (!name || !STATUSES.includes(p.status)) return null;
    return {
      name,
      nick: typeof p.nick === "string" ? p.nick.trim().slice(0, 40) : "",
      status: p.status,
      avatar: typeof p.avatar === "string" && AVATAR_RE.test(p.avatar) ? p.avatar : "",
    };
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const initials = (name) => name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

  function empty(msg) {
    const box = el("div", "empty");
    const img = el("img");
    img.src = "assets/icon.png";
    img.alt = "";
    box.append(img, msg);
    grid.replaceChildren(box);
  }

  function render(people) {
    if (!people.length) return empty("Todavía no hay participantes en la lista.");

    // Primero por estado (Confirmados → Pendientes → Rechazados), luego alfabético.
    people.sort((a, b) => (ORDER[a.status] - ORDER[b.status]) ||
      a.name.localeCompare(b.name, "es", { sensitivity: "base", numeric: true }));
    grid.replaceChildren(...people.map((p, i) => {
      const card = el("article", "card s-" + p.status);
      card.style.animationDelay = Math.min(i, 20) * 30 + "ms";
      const av = el("div", "avatar");
      if (p.avatar) {
        const img = el("img");
        img.src = p.avatar;
        img.alt = "";
        img.loading = "lazy";
        img.addEventListener("error", () => av.replaceChildren(initials(p.name)), { once: true });
        av.append(img);
      } else {
        av.textContent = initials(p.name);
      }
      card.append(av, el("h2", "name", p.name));
      if (p.nick) card.append(el("p", "nick", p.nick));
      card.append(el("span", "badge " + p.status, p.status));
      return card;
    }));
  }

  fetch("data/participants.json?t=" + Date.now(), { cache: "no-store", credentials: "omit" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => render((Array.isArray(data) ? data : []).map(clean).filter(Boolean).slice(0, 500)))
    .catch(() => empty("No se pudo cargar la lista. Probá recargar la página."));
})();

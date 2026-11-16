(function () {
  "use strict";

  const DATA_PATH = "data/participants.json";
  const ORDER = { CONFIRMADO: 0, PENDIENTE: 1, RECHAZADO: 2 };
  const LS_KEY = "apokelipsis-admin";
  const $ = (id) => document.getElementById(id);

  let cfg = load();
  let people = [];
  let sha = null;
  let queue = Promise.resolve();
  let pending = 0;

  // ---------- utils ----------
  function load() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; } }
  function store(v) { try { v ? localStorage.setItem(LS_KEY, JSON.stringify(v)) : localStorage.removeItem(LS_KEY); } catch {} }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initials = (name) => String(name || "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function b64encodeUtf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decodeUtf8(b64) {
    const bin = atob(b64.replace(/\s/g, ""));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  let toastTimer;
  function toast(msg, kind = "ok") {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast show " + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast " + kind), kind === "err" ? 6000 : 2600);
  }

  // Avatar URL: raw.githubusercontent works right after upload (Pages can take ~1 min).
  function avatarUrl(p) {
    if (!p.avatar) return "";
    if (p._preview) return p._preview;
    return `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/HEAD/${p.avatar}`;
  }
  function avatarHtml(p) {
    const u = avatarUrl(p);
    return u ? `<img src="${esc(u)}" alt="" onerror="this.onerror=null;this.src='${esc(p.avatar)}'">` : esc(initials(p.name));
  }

  // ---------- GitHub API ----------
  async function gh(path, opts = {}) {
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}${path}`, {
      ...opts,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${cfg.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      cache: "no-store",
    });
    if (!res.ok) {
      let msg = "";
      try { msg = (await res.json()).message; } catch {}
      const err = new Error(msg || res.statusText);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  async function fetchData() {
    try {
      const f = await gh(`/contents/${DATA_PATH}?t=${Date.now()}`);
      sha = f.sha;
      const parsed = JSON.parse(b64decodeUtf8(f.content) || "[]");
      people = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      if (e.status === 404) { sha = null; people = []; } else throw e;
    }
  }

  async function saveData(message) {
    const clean = people.map(({ _preview, ...p }) => p);
    const body = { message, content: b64encodeUtf8(JSON.stringify(clean, null, 2) + "\n") };
    if (sha) body.sha = sha;
    const r = await gh(`/contents/${DATA_PATH}`, { method: "PUT", body: JSON.stringify(body) });
    sha = r.content.sha;
  }

  async function uploadAvatar(path, dataUrl, name) {
    const content = dataUrl.split(",")[1];
    await gh(`/contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `Foto de ${name}`, content }) });
  }

  async function deleteFile(path) {
    try {
      const f = await gh(`/contents/${path}`);
      await gh(`/contents/${path}`, { method: "DELETE", body: JSON.stringify({ message: `Borrar ${path}`, sha: f.sha }) });
    } catch (e) { /* si no existe, no importa */ }
  }

  // Serialize writes so the JSON sha never races.
  function run(task, okMsg) {
    pending++;
    $("saving").classList.add("on");
    queue = queue
      .then(task)
      .then(() => okMsg && toast(okMsg))
      .catch(async (e) => {
        console.error(e);
        if (e.status === 401 || e.status === 403) toast("El token no tiene permiso. Revisalo e iniciá sesión de nuevo.", "err");
        else if (e.status === 409 || e.status === 422) toast("La lista cambió en otro lado. Se recargó; probá de nuevo.", "err");
        else toast("No se pudo guardar: " + e.message, "err");
        try { await fetchData(); } catch {}
        render();
      })
      .finally(() => {
        if (--pending === 0) $("saving").classList.remove("on");
      });
    return queue;
  }

  // ---------- Render ----------
  function render() {
    const term = norm($("q").value.trim());
    $("total").textContent = people.length ? `(${people.length})` : "";
    const list = people
      .filter((p) => !term || norm(p.name).includes(term) || norm(p.nick).includes(term))
      .sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || a.name.localeCompare(b.name, "es"));

    if (!list.length) {
      $("rows").innerHTML = `<div class="empty">${people.length ? "Nadie coincide con la búsqueda." : "Todavía no agregaste participantes.<br>Tocá <b>Agregar participante</b> para empezar."}</div>`;
      return;
    }

    $("rows").innerHTML = list.map((p) => `
      <div class="row s-${esc(p.status)}" data-id="${esc(p.id)}">
        <div class="avatar">${avatarHtml(p)}</div>
        <div class="who"><b>${esc(p.name)}</b>${p.nick ? `<small>${esc(p.nick)}</small>` : ""}</div>
        <div class="seg">${["CONFIRMADO", "PENDIENTE", "RECHAZADO"].map((s) =>
          `<button type="button" data-s="${s}" class="${p.status === s ? "on" : ""}" data-act="status">${s}</button>`).join("")}</div>
        <div class="acts">
          <button class="btn icon" data-act="edit" title="Editar" aria-label="Editar ${esc(p.name)}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button class="btn icon danger" data-act="del" title="Eliminar" aria-label="Eliminar ${esc(p.name)}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
          </button>
        </div>
      </div>`).join("");
  }

  $("rows").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.closest(".row").dataset.id;
    const p = people.find((x) => x.id === id);
    if (!p) return;
    const act = btn.dataset.act;

    if (act === "status") {
      const s = btn.dataset.s;
      if (p.status === s) return;
      p.status = s;
      render();
      run(() => saveData(`${p.name}: ${s}`), `${p.name} → ${s}`);
    } else if (act === "edit") {
      openModal(p);
    } else if (act === "del") {
      if (!confirm(`¿Eliminar a ${p.name} de la lista?`)) return;
      people = people.filter((x) => x !== p);
      render();
      run(async () => {
        await saveData(`Eliminar a ${p.name}`);
        if (p.avatar) await deleteFile(p.avatar);
      }, `${p.name} fue eliminado`);
    }
  });
  $("q").addEventListener("input", render);

  // ---------- Modal ----------
  let editing = null;   // participant being edited, or null for new
  let draftPhoto = null; // { dataUrl, ext } new photo | "remove" | null (unchanged)
  let draftStatus = "PENDIENTE";

  function setStatus(s) {
    draftStatus = s;
    document.querySelectorAll("#fStatus button").forEach((b) => b.classList.toggle("on", b.dataset.s === s));
  }
  function paintModalAvatar() {
    const a = $("mAvatar");
    let src = "";
    if (draftPhoto && draftPhoto !== "remove") src = draftPhoto.dataUrl;
    else if (!draftPhoto && editing && editing.avatar) src = avatarUrl(editing);
    a.innerHTML = src ? `<img src="${esc(src)}" alt="">` : esc(initials($("fName").value));
    $("clearPhoto").style.display = src ? "" : "none";
  }

  function openModal(p) {
    editing = p || null;
    draftPhoto = null;
    $("mTitle").textContent = p ? "Editar participante" : "Agregar participante";
    $("fName").value = p ? p.name : "";
    $("fNick").value = p ? p.nick || "" : "";
    setStatus(p ? p.status : "PENDIENTE");
    paintModalAvatar();
    $("modal").classList.add("open");
    setTimeout(() => $("fName").focus(), 50);
  }
  function closeModal() { $("modal").classList.remove("open"); }

  document.querySelectorAll("#fStatus button").forEach((b) => b.addEventListener("click", () => setStatus(b.dataset.s)));
  $("fName").addEventListener("input", () => { if (!$("mAvatar").querySelector("img")) paintModalAvatar(); });
  $("cancelBtn").addEventListener("click", closeModal);
  $("modal").addEventListener("mousedown", (e) => { if (e.target === $("modal")) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  $("addBtn").addEventListener("click", () => openModal(null));

  // Photo picking
  const pick = () => $("file").click();
  $("pickBtn").addEventListener("click", pick);
  $("mAvatar").addEventListener("click", pick);
  $("mAvatar").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  $("clearPhoto").addEventListener("click", () => { draftPhoto = "remove"; paintModalAvatar(); });
  $("file").addEventListener("change", (e) => { if (e.target.files[0]) usePhoto(e.target.files[0]); e.target.value = ""; });
  const box = $("photoBox");
  ["dragenter", "dragover"].forEach((t) => box.addEventListener(t, (e) => { e.preventDefault(); box.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((t) => box.addEventListener(t, (e) => { e.preventDefault(); box.classList.remove("drag"); }));
  box.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) usePhoto(f); });

  async function usePhoto(file) {
    if (!file.type.startsWith("image/")) return toast("Ese archivo no es una imagen.", "err");
    try {
      draftPhoto = await squareImage(file, 320);
      paintModalAvatar();
    } catch {
      toast("No se pudo leer la imagen.", "err");
    }
  }

  function squareImage(file, size) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const ctx = c.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        let dataUrl = c.toDataURL("image/webp", 0.86);
        let ext = "webp";
        if (!dataUrl.startsWith("data:image/webp")) { dataUrl = c.toDataURL("image/jpeg", 0.88); ext = "jpg"; }
        resolve({ dataUrl, ext });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(); };
      img.src = url;
    });
  }

  $("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("fName").value.trim();
    if (!name) return $("fName").focus();
    const nick = $("fNick").value.trim();
    const status = draftStatus;
    const photo = draftPhoto;
    const isNew = !editing;
    const p = editing || { id: uid() };
    const oldAvatar = p.avatar || "";

    p.name = name;
    p.nick = nick;
    p.status = status;
    let newAvatarPath = null;
    if (photo === "remove") { p.avatar = ""; delete p._preview; }
    else if (photo) {
      newAvatarPath = `avatars/${p.id}-${Date.now().toString(36)}.${photo.ext}`;
      p.avatar = newAvatarPath;
      p._preview = photo.dataUrl;
    }
    if (isNew) people.push(p);
    closeModal();
    render();

    run(async () => {
      if (newAvatarPath) await uploadAvatar(newAvatarPath, photo.dataUrl, name);
      await saveData(isNew ? `Agregar a ${name}` : `Editar a ${name}`);
      if (oldAvatar && oldAvatar !== p.avatar) await deleteFile(oldAvatar);
    }, isNew ? `${name} fue agregado` : "Cambios guardados");
  });

  // ---------- Login ----------
  function guessRepo() {
    const h = location.hostname;
    if (!h.endsWith(".github.io")) return {};
    const owner = h.replace(/\.github\.io$/, "");
    const seg = location.pathname.split("/").filter(Boolean)[0];
    const repo = seg && !seg.endsWith(".html") ? seg : h;
    return { owner, repo };
  }

  function showLogin() {
    const g = guessRepo();
    $("owner").value = (cfg && cfg.owner) || g.owner || "";
    $("repo").value = (cfg && cfg.repo) || g.repo || "";
    $("token").value = "";
    $("app").hidden = true;
    $("login").hidden = false;
  }

  async function start() {
    $("login").hidden = true;
    $("app").hidden = false;
    $("rows").innerHTML = `<div class="empty">Cargando…</div>`;
    try {
      const repo = await gh("");
      if (repo.permissions && !repo.permissions.push) throw Object.assign(new Error("sin permiso de escritura"), { status: 403 });
      await fetchData();
      render();
    } catch (e) {
      console.error(e);
      toast(e.status === 401 ? "Token inválido o vencido." : e.status === 404 ? "No encuentro ese repositorio (o el token no tiene acceso)." : "No se pudo conectar: " + e.message, "err");
      showLogin();
    }
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    cfg = { owner: $("owner").value.trim(), repo: $("repo").value.trim(), token: $("token").value.trim() };
    store(cfg);
    $("loginBtn").disabled = true;
    await start();
    $("loginBtn").disabled = false;
  });

  $("logoutBtn").addEventListener("click", () => {
    if (!confirm("¿Cerrar sesión en este dispositivo? Vas a necesitar el token para volver a entrar.")) return;
    store({ owner: cfg.owner, repo: cfg.repo });
    cfg = load();
    showLogin();
  });

  window.addEventListener("beforeunload", (e) => { if (pending) { e.preventDefault(); e.returnValue = ""; } });

  if (cfg && cfg.token) start(); else showLogin();
})();

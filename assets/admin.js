(function () {
  "use strict";

  // ---------- Anti-clickjacking: the panel never runs inside a frame ----------
  if (window.top !== window.self) {
    document.documentElement.textContent = "";
    try { window.top.location = window.self.location.href; } catch (e) {}
    return;
  }

  const DATA_PATH = "data/participants.json";
  const STATUSES = ["CONFIRMADO", "PENDIENTE", "RECHAZADO"];
  const ORDER = { CONFIRMADO: 0, PENDIENTE: 1, RECHAZADO: 2 };
  const VAULT_KEY = "apokelipsis-vault";
  const LEGACY_KEY = "apokelipsis-admin";
  const FAIL_KEY = "apokelipsis-fails";
  const PBKDF2_ITER = 600000;
  const IDLE_MS = 15 * 60 * 1000;
  const MAX_UPLOAD = 15 * 1024 * 1024;

  const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const REPO_RE = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
  const TOKEN_RE = /^github_pat_[A-Za-z0-9_]{20,255}$/;
  const ID_RE = /^[a-z0-9]{1,32}$/;
  const AVATAR_RE = /^avatars\/[a-z0-9-]{1,80}\.(webp|jpg|png)$/;

  const $ = (id) => document.getElementById(id);

  let session = null; // { owner, repo, token } — lives only in memory
  let people = [];
  let sha = null;
  let queue = Promise.resolve();
  let pending = 0;
  let lastActivity = Date.now();

  // ---------- storage ----------
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  // ---------- crypto (PBKDF2-SHA256 → AES-256-GCM) ----------
  const te = new TextEncoder();
  const td = new TextDecoder();
  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function deriveKey(pass, salt, iter) {
    const base = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function sealVault(owner, repo, token, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt, PBKDF2_ITER);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: te.encode(owner + "/" + repo) }, key, te.encode(token));
    ls.set(VAULT_KEY, { v: 1, owner, repo, iter: PBKDF2_ITER, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) });
  }
  async function openVault(vault, pass) {
    const key = await deriveKey(pass, fromB64(vault.salt), vault.iter);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(vault.iv), additionalData: te.encode(vault.owner + "/" + vault.repo) },
      key, fromB64(vault.ct));
    return td.decode(pt);
  }

  // ---------- utils ----------
  function b64encodeUtf8(str) {
    const bytes = te.encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  const b64decodeUtf8 = (b64) => td.decode(fromB64(b64.replace(/\s/g, "")));
  const initials = (name) => String(name || "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)).slice(0, 32);
  const text = (s, max) => String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max);

  function el(tag, cls, content) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (content != null) e.textContent = content;
    return e;
  }
  function svgIcon(d) {
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    s.setAttribute("width", "18"); s.setAttribute("height", "18"); s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2.4");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
    d.forEach((x) => { const p = document.createElementNS(ns, "path"); p.setAttribute("d", x); s.append(p); });
    return s;
  }

  // Never trust the stored JSON blindly (defense in depth).
  function clean(p) {
    if (!p || typeof p !== "object") return null;
    const name = text(p.name, 40);
    if (!name || !STATUSES.includes(p.status)) return null;
    return {
      id: typeof p.id === "string" && ID_RE.test(p.id) ? p.id : uid(),
      name,
      nick: text(p.nick, 40),
      status: p.status,
      avatar: typeof p.avatar === "string" && AVATAR_RE.test(p.avatar) ? p.avatar : "",
    };
  }

  let toastTimer;
  function toast(msg, kind = "ok") {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast show " + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast " + kind), kind === "err" ? 6000 : 2600);
  }

  function show(id) {
    ["setup", "migrate", "unlock", "app"].forEach((x) => { $(x).hidden = x !== id; });
  }

  // ---------- GitHub API ----------
  async function gh(path, opts = {}) {
    if (!session) throw Object.assign(new Error("bloqueado"), { status: 0 });
    const res = await fetch(`https://api.github.com/repos/${session.owner}/${session.repo}${path}`, {
      ...opts,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${session.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) {
      let msg = "";
      try { msg = (await res.json()).message; } catch (e) {}
      throw Object.assign(new Error(msg || res.statusText), { status: res.status });
    }
    return res.status === 204 ? null : res.json();
  }

  async function verifyRepo() {
    const repo = await gh("");
    if (!repo.permissions || !repo.permissions.push) {
      throw Object.assign(new Error("La llave no tiene permiso de escritura en este repositorio."), { status: 403 });
    }
  }

  async function fetchData() {
    try {
      const f = await gh(`/contents/${DATA_PATH}?t=${Date.now()}`);
      sha = f.sha;
      const parsed = JSON.parse(b64decodeUtf8(f.content) || "[]");
      people = (Array.isArray(parsed) ? parsed : []).map(clean).filter(Boolean);
    } catch (e) {
      if (e.status === 404) { sha = null; people = []; } else throw e;
    }
  }

  async function saveData(message) {
    const out = people.map(({ id, name, nick, status, avatar }) => ({ id, name, nick, status, avatar }));
    const body = { message, content: b64encodeUtf8(JSON.stringify(out, null, 2) + "\n") };
    if (sha) body.sha = sha;
    const r = await gh(`/contents/${DATA_PATH}`, { method: "PUT", body: JSON.stringify(body) });
    sha = r.content.sha;
  }

  async function uploadAvatar(path, dataUrl, name) {
    if (!AVATAR_RE.test(path)) throw new Error("ruta de foto inválida");
    await gh(`/contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `Foto de ${name}`, content: dataUrl.split(",")[1] }) });
  }

  async function deleteFile(path) {
    if (!AVATAR_RE.test(path)) return;
    try {
      const f = await gh(`/contents/${path}`);
      await gh(`/contents/${path}`, { method: "DELETE", body: JSON.stringify({ message: `Borrar ${path}`, sha: f.sha }) });
    } catch (e) { /* si no existe, no importa */ }
  }

  function run(task, okMsg) {
    pending++;
    $("saving").classList.add("on");
    queue = queue
      .then(task)
      .then(() => okMsg && toast(okMsg))
      .catch(async (e) => {
        console.error(e);
        if (e.status === 401) { toast("La llave fue revocada o venció. Configurá una nueva.", "err"); hardReset(false); return; }
        if (e.status === 403) toast("La llave no tiene permiso para guardar.", "err");
        else if (e.status === 409 || e.status === 422) toast("La lista cambió en otro lado. Se recargó; probá de nuevo.", "err");
        else toast("No se pudo guardar: " + e.message, "err");
        try { await fetchData(); } catch (x) {}
        render();
      })
      .finally(() => { if (--pending === 0) $("saving").classList.remove("on"); });
    return queue;
  }

  // ---------- Render ----------
  function avatarUrl(p) {
    if (p._preview) return p._preview;
    if (!p.avatar) return "";
    return `https://raw.githubusercontent.com/${session.owner}/${session.repo}/HEAD/${p.avatar}`;
  }
  function fillAvatar(box, p) {
    const u = avatarUrl(p);
    if (!u) { box.textContent = initials(p.name); return; }
    const img = el("img");
    img.alt = "";
    img.addEventListener("error", () => {
      if (p.avatar && img.src.indexOf("raw.githubusercontent.com") !== -1) img.src = p.avatar;
      else box.textContent = initials(p.name);
    });
    img.src = u;
    box.replaceChildren(img);
  }

  function render() {
    const term = norm($("q").value.trim());
    $("total").textContent = people.length ? `(${people.length})` : "";
    const list = people
      .filter((p) => !term || norm(p.name).includes(term) || norm(p.nick).includes(term))
      .sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || a.name.localeCompare(b.name, "es"));

    if (!list.length) {
      $("rows").replaceChildren(el("div", "empty", people.length
        ? "Nadie coincide con la búsqueda."
        : "Todavía no agregaste participantes. Tocá «Agregar participante» para empezar."));
      return;
    }

    $("rows").replaceChildren(...list.map((p) => {
      const row = el("div", "row s-" + p.status);
      row.dataset.id = p.id;
      const av = el("div", "avatar");
      fillAvatar(av, p);
      const who = el("div", "who");
      who.append(el("b", null, p.name));
      if (p.nick) who.append(el("small", null, p.nick));
      const seg = el("div", "seg");
      STATUSES.forEach((s) => {
        const b = el("button", p.status === s ? "on" : "", s);
        b.type = "button"; b.dataset.s = s; b.dataset.act = "status";
        seg.append(b);
      });
      const acts = el("div", "acts");
      const ed = el("button", "btn icon");
      ed.type = "button"; ed.dataset.act = "edit"; ed.title = "Editar"; ed.setAttribute("aria-label", "Editar " + p.name);
      ed.append(svgIcon(["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"]));
      const del = el("button", "btn icon danger");
      del.type = "button"; del.dataset.act = "del"; del.title = "Eliminar"; del.setAttribute("aria-label", "Eliminar " + p.name);
      del.append(svgIcon(["M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"]));
      acts.append(ed, del);
      row.append(av, who, seg, acts);
      return row;
    }));
  }

  $("rows").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || !session) return;
    const p = people.find((x) => x.id === btn.closest(".row").dataset.id);
    if (!p) return;
    const act = btn.dataset.act;

    if (act === "status") {
      const s = btn.dataset.s;
      if (!STATUSES.includes(s) || p.status === s) return;
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
  let editing = null;
  let draftPhoto = null; // { dataUrl, ext } | "remove" | null
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
    if (src) { const img = el("img"); img.alt = ""; img.src = src; a.replaceChildren(img); }
    else a.textContent = initials($("fName").value);
    $("clearPhoto").hidden = !src;
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
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return toast("Usá una imagen PNG, JPG, WEBP o GIF.", "err");
    if (file.size > MAX_UPLOAD) return toast("La imagen es demasiado grande (máximo 15 MB).", "err");
    try {
      draftPhoto = await squareImage(file, 320);
      paintModalAvatar();
    } catch (e) {
      toast("No se pudo leer la imagen.", "err");
    }
  }

  // Re-encoding through a canvas strips EXIF/GPS metadata and any embedded payloads.
  function squareImage(file, size) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        if (!s) { URL.revokeObjectURL(url); return reject(); }
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const ctx = c.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        let q = 0.86, dataUrl, ext = "webp";
        do {
          dataUrl = c.toDataURL("image/webp", q);
          if (!dataUrl.startsWith("data:image/webp")) { dataUrl = c.toDataURL("image/jpeg", q); ext = "jpg"; }
          q -= 0.15;
        } while (dataUrl.length > 400000 && q > 0.3);
        resolve({ dataUrl, ext });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(); };
      img.src = url;
    });
  }

  $("form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!session) return;
    const name = text($("fName").value, 40);
    if (!name) { toast("Escribí un nombre.", "err"); return $("fName").focus(); }
    const nick = text($("fNick").value, 40);
    const status = STATUSES.includes(draftStatus) ? draftStatus : "PENDIENTE";
    const photo = draftPhoto;
    const isNew = !editing;
    const p = editing || { id: uid() };
    const oldAvatar = p.avatar || "";

    p.name = name; p.nick = nick; p.status = status;
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

  // ---------- Session / auth ----------
  function passError(a, b, token) {
    if (a.length < 10) return "La contraseña debe tener al menos 10 caracteres.";
    if (/^(.)\1+$/.test(a)) return "Esa contraseña es demasiado simple.";
    if (token && a === token) return "La contraseña no puede ser el token.";
    if (a !== b) return "Las contraseñas no coinciden.";
    return "";
  }

  function guessRepo() {
    const h = location.hostname;
    if (!h.endsWith(".github.io")) return {};
    const owner = h.replace(/\.github\.io$/, "");
    const seg = location.pathname.split("/").filter(Boolean)[0];
    return { owner, repo: seg && !seg.endsWith(".html") ? seg : h };
  }

  async function enter() {
    show("app");
    lastActivity = Date.now();
    $("rows").replaceChildren(el("div", "empty", "Cargando…"));
    await fetchData();
    render();
  }

  function lock(reason) {
    if (!session) return;
    session = null; people = []; sha = null;
    closeModal();
    $("rows").replaceChildren();
    $("q").value = "";
    $("pass").value = "";
    $("unlockErr").textContent = reason || "";
    show("unlock");
    setTimeout(() => $("pass").focus(), 50);
  }

  function hardReset(ask) {
    if (ask && !confirm("Se va a borrar la llave guardada en este dispositivo. Vas a necesitar un token para volver a entrar. ¿Continuar?")) return;
    const v = ls.get(VAULT_KEY) || ls.get(LEGACY_KEY) || {};
    ls.del(VAULT_KEY); ls.del(LEGACY_KEY); ls.del(FAIL_KEY);
    session = null; people = []; sha = null;
    closeModal();
    showSetup(v.owner, v.repo);
  }

  function showSetup(owner, repo) {
    const g = guessRepo();
    $("owner").value = owner || g.owner || "";
    $("repo").value = repo || g.repo || "";
    ["token", "p1", "p2"].forEach((id) => { $(id).value = ""; });
    $("setupErr").textContent = "";
    show("setup");
  }

  async function busy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  }

  $("setupForm").addEventListener("submit", (e) => {
    e.preventDefault();
    busy($("setupBtn"), async () => {
      const owner = $("owner").value.trim();
      const repo = $("repo").value.trim();
      const token = $("token").value.trim();
      const err = (m) => { $("setupErr").textContent = m; };
      if (!OWNER_RE.test(owner)) return err("Usuario de GitHub inválido.");
      if (!REPO_RE.test(repo)) return err("Nombre de repositorio inválido.");
      if (!TOKEN_RE.test(token)) return err("Usá un token «fine-grained» (empieza con github_pat_).");
      const pe = passError($("p1").value, $("p2").value, token);
      if (pe) return err(pe);
      session = { owner, repo, token };
      try {
        await verifyRepo();
      } catch (x) {
        session = null;
        return err(x.status === 401 ? "Token inválido o vencido." : x.status === 404 ? "No encuentro ese repositorio (o el token no tiene acceso)." : x.message);
      }
      await sealVault(owner, repo, token, $("p1").value);
      ls.del(LEGACY_KEY);
      ["token", "p1", "p2"].forEach((id) => { $(id).value = ""; });
      try { await enter(); } catch (x) { toast("No se pudo cargar la lista: " + x.message, "err"); }
    });
  });

  $("migrateForm").addEventListener("submit", (e) => {
    e.preventDefault();
    busy($("migrateBtn"), async () => {
      const legacy = ls.get(LEGACY_KEY) || {};
      const pe = passError($("m1").value, $("m2").value, legacy.token);
      if (pe) { $("migrateErr").textContent = pe; return; }
      await sealVault(legacy.owner, legacy.repo, legacy.token, $("m1").value);
      ls.del(LEGACY_KEY);
      $("m1").value = $("m2").value = "";
      session = { owner: legacy.owner, repo: legacy.repo, token: legacy.token };
      try { await verifyRepo(); await enter(); }
      catch (x) { toast(x.status === 401 ? "La llave guardada ya no sirve. Configurá una nueva." : x.message, "err"); if (x.status === 401) hardReset(false); }
    });
  });

  $("unlockForm").addEventListener("submit", (e) => {
    e.preventDefault();
    busy($("unlockBtn"), async () => {
      const vault = ls.get(VAULT_KEY);
      if (!vault) return showSetup();
      const fails = ls.get(FAIL_KEY) || { n: 0, until: 0 };
      const wait = Math.ceil((fails.until - Date.now()) / 1000);
      if (wait > 0) { $("unlockErr").textContent = `Demasiados intentos. Esperá ${wait} s.`; return; }
      let token;
      try {
        token = await openVault(vault, $("pass").value);
      } catch (x) {
        fails.n += 1;
        if (fails.n >= 5) fails.until = Date.now() + Math.min(30000 * 2 ** (fails.n - 5), 15 * 60 * 1000);
        ls.set(FAIL_KEY, fails);
        $("unlockErr").textContent = fails.n >= 5 ? "Contraseña incorrecta. Bloqueado temporalmente." : "Contraseña incorrecta.";
        $("pass").value = "";
        return;
      }
      ls.del(FAIL_KEY);
      $("pass").value = "";
      $("unlockErr").textContent = "";
      session = { owner: vault.owner, repo: vault.repo, token };
      try { await verifyRepo(); await enter(); }
      catch (x) {
        if (x.status === 401) { toast("La llave fue revocada o venció. Configurá una nueva.", "err"); hardReset(false); }
        else { session = null; show("unlock"); $("unlockErr").textContent = "No se pudo conectar: " + x.message; }
      }
    });
  });

  $("resetBtn").addEventListener("click", () => hardReset(true));
  $("lockBtn").addEventListener("click", () => lock());
  $("logoutBtn").addEventListener("click", () => hardReset(true));

  // Auto-lock after inactivity.
  ["pointerdown", "keydown", "scroll", "touchstart"].forEach((t) =>
    window.addEventListener(t, () => { lastActivity = Date.now(); }, { passive: true }));
  setInterval(() => {
    if (session && !pending && Date.now() - lastActivity > IDLE_MS) lock("Se bloqueó por inactividad.");
  }, 20000);

  window.addEventListener("beforeunload", (e) => { if (pending) { e.preventDefault(); e.returnValue = ""; } });

  // ---------- Boot ----------
  if (!window.crypto || !crypto.subtle) {
    document.querySelector("main").textContent = "Este navegador no soporta cifrado seguro. Abrí el panel desde https con un navegador actualizado.";
    return;
  }
  const legacy = ls.get(LEGACY_KEY);
  if (ls.get(VAULT_KEY)) show("unlock");
  else if (legacy && legacy.token && OWNER_RE.test(legacy.owner || "") && REPO_RE.test(legacy.repo || "")) show("migrate");
  else showSetup(legacy && legacy.owner, legacy && legacy.repo);
})();

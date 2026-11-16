# APOKÉLIPSIS SMP · Participantes

- `index.html` → página pública (la que compartís con los invitados).
- `admin.html` → panel de administrador (solo funciona con tu token de GitHub).
- `data/participants.json` → la lista (la edita el panel, no hace falta tocarla a mano).
- `avatars/` → fotos de perfil subidas desde el panel.

## Publicar (una sola vez)

1. Creá una cuenta en https://github.com (si no tenés).
2. Creá un repositorio **público** nuevo, por ejemplo `apokelipsis` (https://github.com/new).
3. En el repo: **Add file → Upload files** y arrastrá TODO el contenido de esta carpeta
   (`index.html`, `admin.html`, `README.md` y las carpetas `assets`, `data`, `avatars`). Commit.
4. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main` / `(root)` → Save.
5. En ~1 minuto la página queda en `https://TU-USUARIO.github.io/apokelipsis/`.
   Ese es el link para los invitados.

## Crear tu llave de administrador (token)

1. https://github.com/settings/personal-access-tokens/new
2. *Repository access* → **Only select repositories** → elegí el repo.
3. *Permissions → Repository permissions → Contents* → **Read and write**.
4. Generá y copiá el token.

## Usar el panel

Entrá a `https://TU-USUARIO.github.io/apokelipsis/admin.html`, pegá el token y creá una contraseña.
El token queda guardado **cifrado** (AES-256) solo en ese navegador; cada vez que entres te pide la contraseña.
El panel se bloquea solo después de 15 minutos sin uso. Sin token, nadie puede modificar la lista.

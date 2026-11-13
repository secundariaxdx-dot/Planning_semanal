# Planning semanal

Planificador semanal que funciona en el ordenador y en el móvil, y se sincroniza entre dispositivos.

- **Tareas por día** (lunes a domingo): añadir, marcar como hechas, editar, eliminar y mover a otro día (arrastrando en el ordenador o desde el menú de la tarea).
- **Navegar entre semanas** (‹ Hoy ›; en el ordenador también con las flechas del teclado). Cada semana se guarda por separado y una tarea se puede pasar a la semana siguiente.
- **Objetivos y notas** de la semana.
- **Funciona sin conexión** y se puede instalar como app en el móvil.

No hay que compilar nada: son archivos HTML, CSS y JavaScript que GitHub Pages sirve tal cual.

## 1. Publicarla con GitHub Pages

1. En GitHub, abre el repositorio → **Settings** → **Pages**.
2. En *Build and deployment* elige **Source: Deploy from a branch**.
3. Elige la rama donde está el código (por ejemplo `main`) y la carpeta **`/ (root)`** → **Save**.
4. En uno o dos minutos la app estará en:
   `https://secundariaxdx-dot.github.io/Planning_semanal/`

## 2. Activar la sincronización (una vez en cada dispositivo)

Los datos se guardan en un **Gist secreto** de tu cuenta de GitHub, que la app crea sola.

1. Abre la app y pulsa el botón de sincronización (arriba a la derecha).
2. Pulsa **«Crea un token de GitHub»**. Se abre GitHub con el permiso `gist` ya marcado. Ponle la caducidad que quieras y genera el token.
3. Copia el token, pégalo en la app y pulsa **Conectar**.
4. Repite los pasos 1 a 3 en el móvil (puedes usar el mismo token).

La app sincroniza al hacer cambios, al volver a ella y cada 45 segundos mientras está abierta. Si dos dispositivos cambian cosas distintas a la vez, se conservan los dos cambios. Si cambian **la misma** tarea, gana el cambio más reciente.

### Instalarla en el móvil

- **iPhone (Safari):** botón Compartir → *Añadir a pantalla de inicio*.
- **Android (Chrome):** menú ⋮ → *Instalar aplicación* / *Añadir a pantalla de inicio*.

## Privacidad

- El token se guarda solo en el navegador de cada dispositivo y únicamente da acceso a tus gists.
- Un gist «secreto» no aparece en tu perfil ni en buscadores, pero **cualquiera que tenga su enlace puede leerlo**. No guardes en la app nada muy sensible.
- Si pierdes un dispositivo, borra el token en <https://github.com/settings/tokens>.
- El botón **Exportar** descarga una copia de seguridad de todos los datos en formato JSON.

## Archivos

| Archivo | Para qué sirve |
| --- | --- |
| `index.html` | Estructura de la página |
| `styles.css` | Estilos (modo claro y oscuro, adaptado al móvil) |
| `app.js` | Interfaz y lógica de la app |
| `store.js` | Modelo de datos y fusión de cambios entre dispositivos |
| `sync.js` | Sincronización con GitHub Gist |
| `sw.js`, `manifest.webmanifest`, `icons/` | Uso sin conexión e instalación como app |

# Planning semanal

Planificador semanal que funciona en el ordenador y en el móvil, y se sincroniza entre dispositivos.

- **Tareas por día** (lunes a domingo): añadir, marcar como hechas, editar, eliminar y mover a otro día (arrastrando en el ordenador o desde el menú de la tarea).
- **Tareas que se repiten**: al editar una tarea, elige en «Repetir cada semana» los días en que debe aparecer. Se muestran con el símbolo ↻.
- **Objetivos y notas** de la semana. El círculo naranja de un objetivo lo marca como «empezado pero no acabado».
- **Navegar entre semanas**: botones ‹ Hoy ›, flechas del teclado en el ordenador o deslizando el dedo en el móvil.
- **Pasar pendientes a la semana siguiente**: mueve lo que no se ha hecho y lo marca con la etiqueta «Pendiente».
- **Deshacer** al eliminar o al pasar pendientes.
- **Barra de progreso** de la semana y **modo claro u oscuro** (en Ajustes).
- **Funciona sin conexión**, se abre al instante y se puede instalar como app en el móvil.

No hay que compilar nada: son archivos HTML, CSS y JavaScript que GitHub Pages sirve tal cual.

## 1. Publicarla con GitHub Pages

1. En GitHub, abre el repositorio → **Settings** → **Pages**.
2. En *Build and deployment* elige **Source: Deploy from a branch**.
3. Elige la rama donde está el código (por ejemplo `main`) y la carpeta **`/ (root)`** → **Save**.
4. En uno o dos minutos la app estará en:
   `https://secundariaxdx-dot.github.io/Planning_semanal/`

## 2. Activar la sincronización (una vez en cada dispositivo)

Los datos se guardan en un **Gist secreto** de tu cuenta de GitHub, que la app crea sola.

1. Abre la app y pulsa el botón de ajustes (la rueda, arriba a la derecha).
2. Pulsa **«Crea un token de GitHub»**. Se abre GitHub con el permiso `gist` ya marcado. Ponle la caducidad que quieras y genera el token.
3. Copia el token, pégalo en la app y pulsa **Conectar**.
4. Repite los pasos 1 a 3 en el móvil (puedes usar el mismo token).

La app sincroniza al hacer cambios, al volver a ella y cada 45 segundos mientras está abierta. El punto de color sobre la rueda indica el estado (verde: sincronizado; amarillo: sin conexión; rojo: error), y un aviso aparece cuando se pierde o se recupera la conexión.

Si dos dispositivos cambian cosas distintas a la vez, se conservan los dos cambios. Si cambian **la misma** tarea, gana el cambio más reciente.

### Instalarla en el móvil

- **iPhone (Safari):** botón Compartir → *Añadir a pantalla de inicio*.
- **Android (Chrome):** menú ⋮ → *Instalar aplicación* / *Añadir a pantalla de inicio*.

Cuando hay una versión nueva de la app, aparece el aviso «Hay una versión nueva» con el botón **Recargar**.

## 3. Conectar Google Calendar (opcional)

La app puede mostrar los eventos de tu Google Calendar principal dentro de cada día de la agenda y crearlos, editarlos y borrarlos desde aquí. Los eventos viven solo en Google (no se copian al Gist), así que no se duplican.

**Lo haces una sola vez** (lleva unos 10 minutos). En la app: ruedecita → Ajustes → *Google Calendar* → «Cómo conseguir el Client ID». Los pasos son:

1. Crea un proyecto en <https://console.cloud.google.com/projectcreate> (por ejemplo «Planning semanal»).
2. Activa la **API de Google Calendar** en ese proyecto.
3. En *Google Auth Platform* configura la pantalla de consentimiento: público **Externo**, tu correo, y añade tu correo como **usuario de prueba**. En *Acceso a los datos* añade el permiso `.../auth/calendar.events`.
4. Crea un **cliente OAuth de tipo «Aplicación web»** con el origen de JavaScript autorizado `https://secundariaxdx-dot.github.io` (sin barra final ni ruta).
5. Copia el **ID de cliente** (`...apps.googleusercontent.com`), pégalo en Ajustes y pulsa **Conectar con Google**. Google avisará de que la app no está verificada: es la tuya, pulsa «Configuración avanzada» → «Ir a Planning semanal».

Cosas que conviene saber:

- **Cada hora** Google caduca el permiso (no hay servidor que lo renueve). Cuando pase, el botón junto a «Agenda» pone **Reconectar Google**; un clic y listo. Tus datos no se pierden.
- **Cambios hechos en Google:** la app los recoge al abrir la semana, al volver a la pestaña y cada minuto. Pulsar el botón «Google Calendar» fuerza la actualización.
- **Sin conexión** se ven los últimos eventos descargados, pero no se pueden crear ni editar hasta recuperar la conexión.
- **Eventos que se repiten:** al editar o borrar uno, el cambio afecta solo a esa repetición.
- **Todo el día y horas:** los eventos de día completo salen arriba, en color sólido; los demás con su hora, en tu zona horaria. Los eventos de varios días aparecen en cada día.
- **Desconectar** (Ajustes → Desconectar Google) revoca el permiso y borra la copia local; tus eventos de Google no se tocan.
- Solo se usa el calendario principal.

## Notas con formato

El apartado **Notas** funciona como las notas de Apple. La barra de arriba tiene: **T** título, **B** negrita, *I* cursiva, ~~S~~ tachado, **•≡** lista, **☑** lista de tareas (pulsa la casilla y el elemento se tacha) y **▸ Desplegable** (una sección que se pliega pulsando su flecha; la ✕ de su título la elimina). Atajos al empezar una línea: `- ` crea una lista, `[] ` una lista de tareas y `# ` un título. Las notas antiguas (solo texto) se conservan tal cual.

## Cómo funcionan algunas cosas

- **Tareas repetidas.** Los cambios de días valen desde la semana que estás viendo; las semanas anteriores no cambian. «Quitar esta semana» la quita solo de esa semana. Para dejar de repetirla, desmarca todos los días. Las tareas repetidas no se pasan como pendientes, porque vuelven a aparecer solas.
- **Pasar pendientes.** Las tareas y los objetivos sin hacer se *mueven* a la semana siguiente (dejan de estar en la actual). Los objetivos empezados siguen en naranja.
- **Limpieza.** Las marcas internas de elementos borrados se eliminan a los 60 días, para que el archivo no crezca sin límite.

## Privacidad

- El Client ID y el permiso temporal de Google (1 hora) se guardan solo en el navegador de cada dispositivo. El permiso permite ver y editar eventos de tu calendario.
- El token se guarda solo en el navegador de cada dispositivo y únicamente da acceso a tus gists.
- Un gist «secreto» no aparece en tu perfil ni en buscadores, pero **cualquiera que tenga su enlace puede leerlo**. No guardes en la app nada muy sensible.
- Si pierdes un dispositivo, borra el token en <https://github.com/settings/tokens>.
- El botón **Exportar** (en Ajustes) descarga una copia de seguridad de todos los datos en formato JSON.

## Archivos

| Archivo | Para qué sirve |
| --- | --- |
| `index.html` | Estructura de la página |
| `styles.css` | Estilos (modo claro y oscuro, adaptado al móvil) |
| `app.js` | Interfaz y lógica de la app |
| `store.js` | Modelo de datos, tareas repetidas y fusión de cambios entre dispositivos |
| `sync.js` | Sincronización con GitHub Gist |
| `notes.js` | Editor de notas con formato |
| `gcal.js` | Conexión con Google Calendar (inicio de sesión, leer, crear, editar y borrar eventos) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Uso sin conexión e instalación como app |

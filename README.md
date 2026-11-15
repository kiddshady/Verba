# Verba

Transcribe audios en tu propia máquina con [Whisper](https://github.com/openai/whisper).
Nada sale de la PC: el audio se lee de donde está y el modelo corre en tu GPU.

Es una app de escritorio para Windows, hecha con Electron sobre la plantilla Opal.

## Qué hace

- **Cola.** Agregás audios con el botón o soltándolos sobre la ventana (también una
  carpeta entera). Se transcriben de a uno y la cola sigue aunque cambies de vista
  o cierres y vuelvas a abrir.
- **Biblioteca.** Las transcripciones listas, por grupo, con su duración y su
  calidad: cuánto del tiempo Whisper estuvo seguro de lo que escribía y cuántas
  veces se quedó repitiendo.
- **Lectura.** El texto en párrafos de alrededor de un minuto (el largo se
  elige en Ajustes), cada uno con su tiempo. Un clic en un párrafo lleva el audio ahí, y el texto sigue al audio
  mientras suena. Los tramos de confianza baja van avisados, y lo que Whisper
  inventa en los silencios («Gracias.») va tachado y no sale al exportar.
- **Grupos.** Un grupo junta los audios que comparten vocabulario: un tema, un
  podcast, un cliente, una materia. Los creás vos, con el nombre que quieras, y
  se pueden renombrar o quitar. Un audio también puede ir sin grupo.
- **Correcciones por grupo.** Seleccionás una palabra mal escrita, ponés cómo
  va, y queda en el vocabulario de ese grupo: se aplica a todos sus audios. El
  texto de Whisper se guarda como salió; las correcciones se aplican al mostrar
  y al exportar, así que sacar una devuelve el original.
- **Términos.** Una lista de nombres y palabras técnicas por grupo que se le
  pasa a Whisper antes de empezar, para que los escriba bien.
- **Exportar.** Markdown con tiempos, texto corrido, texto con tiempos y
  subtítulos `.srt`, al lado del audio.

Lee `mp3`, `m4a`, `ogg`, `opus`, `wav`, `flac`, `aac`, `wma`, `mp4`, `mkv`, `webm`
y `mov`.

## Qué necesita

Verba no trae Whisper adentro: usa el Python que ya tengas.

- **Windows 10 u 11.**
- **Python** con `openai-whisper` y `torch`. Con una GPU NVIDIA, el `torch` con
  CUDA; sin GPU anda en CPU, bastante más lento.

  ```
  pip install openai-whisper
  ```

- **ffmpeg** en el `PATH` (Whisper lo usa para abrir los audios).

Si tu Python no es el `python` del `PATH`, se cambia en **Ajustes → Motor**. El
modelo por defecto es `large-v3-turbo`; uno que no esté bajado, Whisper lo
descarga la primera vez que se usa.

## Instalar

Bajá `Verba-Setup-<versión>.exe` de la
[página de releases](https://github.com/kiddshady/Verba/releases). El instalador
no está firmado, así que Windows puede mostrar el aviso de SmartScreen.

Desde la 0.2.0 la app se actualiza sola: busca una versión nueva al abrir y cada
cuatro horas, la baja en segundo plano y entra cuando cerrás Verba. El estado
está en **Ajustes → Acerca de**.

Para armar el instalador vos:

```
npm install
npm run build        # deja dist/Verba-Setup-<versión>.exe
```

## Desarrollo

```
npm install
npm start            # la app
npm run dev          # con la consola de la interfaz en la terminal y la vista Piezas
npm test             # tokens, almacenamiento, formato y el texto (node pelado)
npm run smoke        # monta la app con datos propios y la recorre
npm run icon         # regenera el ícono y las marcas desde tools/marca.cjs
```

El humo no toca tus datos ni muestra una ventana. Con `--capturas <carpeta>` deja
un PNG de cada vista, y con `VERBA_HUMO_AUDIO=<audio>` además transcribe ese
audio con Whisper de verdad.

## Cómo está armada

```
main.cjs               La ventana y el arranque.
preload.cjs            La única puerta entre la interfaz y el sistema.
motor/verba_motor.py   Un proceso de Python que carga Whisper una vez y habla
                       JSON por líneas. Se apaga solo cuando la cola lleva un
                       rato vacía, para soltar la memoria de la GPU.
src/
  motor.cjs            La cola, las transcripciones en disco y los vocabularios.
  actualizador.cjs     Las actualizaciones, sobre los releases de GitHub.
  texto.cjs            Calidad, párrafos, correcciones y formatos de salida.
                       Puro: no toca el disco ni Electron.
  ipc.cjs              Lo que la interfaz puede pedir.
  store.cjs            JSON atómico: ajustes, documentos, colecciones.
renderer/
  js/app.js            Las vistas, el reproductor y el panel de correcciones.
  css/verba.css        Lo propio de la app (prefijo vb-); el resto es Opal.
```

Los datos son archivos JSON legibles: en desarrollo, en `data/`; instalada, en
la carpeta de datos de la app. Cada transcripción es un archivo con los
segmentos de Whisper tal como salieron. Los audios no se copian.

La referencia del sistema de diseño está en [docs/sistema.md](docs/sistema.md).

## Licencia

MIT. Los componentes de terceros están en [NOTICE](NOTICE).

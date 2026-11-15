"""Verba: el motor. Un proceso que carga Whisper una vez y transcribe lo que le piden.

Habla JSON por líneas: lee pedidos por stdin y escribe eventos por stdout.

  pedido  {"op": "transcribir", "id", "audio", "prompt", "modelo", "idioma"}
          {"op": "salir"}
  evento  {"ev": "arranco"}                        el proceso está vivo
          {"ev": "listo", "dispositivo", "gpu"}    torch y whisper importados
          {"ev": "audio", "id", "dur", "picos"}    el audio se leyó (picos 0..255)
          {"ev": "cargando", "id", "modelo"}       el modelo entra a memoria
          {"ev": "progreso", "id", "p"}            0..1
          {"ev": "hecho", "id", "dur", "tardo", "modelo", "dispositivo", "segs"}
          {"ev": "error", "id", "msg"}

Cada segmento lleva s, e (segundos), t (texto) y las tres medidas con las que
se juzga la calidad: lp (avg_logprob), ns (no_speech_prob) y cr (compression_ratio).
"""
import json
import sys
import time

PICOS = 2400


def decir(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    decir({"ev": "arranco"})

    import numpy as np
    import torch
    import whisper
    import whisper.transcribe  # noqa: F401  (carga el módulo)

    # «import whisper.transcribe as wt» daría la FUNCIÓN: el paquete la exporta
    # con el mismo nombre que su módulo. El módulo se toma de sys.modules.
    wt = sys.modules["whisper.transcribe"]

    cuda = torch.cuda.is_available()
    dispositivo = "cuda" if cuda else "cpu"
    actual = {"id": None}

    class Barra:
        """Reemplaza a tqdm adentro de whisper: el avance sale como evento."""

        def __init__(self, total=None, **_):
            self.total = total or 1
            self.n = 0
            self.ultimo = 0.0

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def update(self, n=1):
            self.n += n
            ahora = time.time()
            if ahora - self.ultimo > 0.25 or self.n >= self.total:
                self.ultimo = ahora
                decir({"ev": "progreso", "id": actual["id"], "p": min(1.0, self.n / self.total)})

    class _Tqdm:
        tqdm = Barra

    wt.tqdm = _Tqdm
    decir({"ev": "listo", "dispositivo": dispositivo,
           "gpu": torch.cuda.get_device_name(0) if cuda else None})

    modelos = {}

    def transcribir(op):
        t0 = time.time()
        actual["id"] = op["id"]
        audio = whisper.load_audio(op["audio"])
        dur = len(audio) / 16000
        n = min(PICOS, max(1, len(audio) // 160))
        m = len(audio) // n
        if m:
            picos = np.abs(audio[: m * n]).reshape(n, m).max(axis=1)
            techo = float(np.percentile(picos, 99.5)) or 1.0
            picos = np.clip(picos / techo * 255, 0, 255).astype(int).tolist()
        else:
            picos = []
        decir({"ev": "audio", "id": op["id"], "dur": dur, "picos": picos})

        nombre = op.get("modelo") or "large-v3-turbo"
        if nombre not in modelos:
            decir({"ev": "cargando", "id": op["id"], "modelo": nombre})
            modelos.clear()   # uno solo en memoria: la VRAM es de todos
            modelos[nombre] = whisper.load_model(nombre, device=dispositivo)
        r = modelos[nombre].transcribe(
            audio,
            language=op.get("idioma") or None,
            fp16=cuda,
            condition_on_previous_text=False,
            initial_prompt=op.get("prompt") or None,
            verbose=False,
        )
        segs = [{
            "s": round(float(s["start"]), 2), "e": round(float(s["end"]), 2), "t": s["text"].strip(),
            "lp": round(float(s["avg_logprob"]), 3), "ns": round(float(s["no_speech_prob"]), 3),
            "cr": round(float(s["compression_ratio"]), 2),
        } for s in r["segments"] if s["text"].strip()]
        decir({"ev": "hecho", "id": op["id"], "dur": dur, "tardo": time.time() - t0,
               "modelo": nombre, "dispositivo": dispositivo, "idioma": r.get("language"), "segs": segs})

    for linea in sys.stdin:
        linea = linea.strip()
        if not linea:
            continue
        try:
            op = json.loads(linea)
        except ValueError:
            continue
        if op.get("op") == "salir":
            break
        if op.get("op") == "transcribir":
            try:
                transcribir(op)
            except Exception as err:  # el motor sigue vivo para el próximo audio
                decir({"ev": "error", "id": op.get("id"), "msg": f"{type(err).__name__}: {err}"})
            finally:
                actual["id"] = None


if __name__ == "__main__":
    main()

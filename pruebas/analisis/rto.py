#!/usr/bin/env python3
"""
Cruza el CSV de la sonda con el registro de inyecciones de fallos y calcula,
para cada falla, el impacto visto por el cliente:

  - fallos       : peticiones fallidas atribuibles a esa falla
  - deteccion_ms : desde la inyección hasta el primer fallo observado
  - rto_ms       : desde la inyección hasta la primera respuesta correcta
                   posterior al último fallo (0 si no hubo fallos)
  - lat_max_ms   : latencia máxima en la ventana (reintentos absorbidos)

Uso:
  python pruebas/analisis/rto.py resultados/sonda-<lote>-sonda.csv resultados/eventos-<lote>.log [ventana_s]
"""
import csv
import sys
from datetime import datetime

INYECCIONES = ("KILL", "NETEM ", "PARTICION")


def ts(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    sonda, eventos = sys.argv[1], sys.argv[2]
    ventana = float(sys.argv[3]) * 1000 if len(sys.argv) > 3 else 30000.0

    muestras = []
    with open(sonda, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            muestras.append((float(r["epoch_ms"]), r["ok"] == "1", float(r["latencia_ms"]), r["status"]))
    muestras.sort()

    fallas = []
    with open(eventos, encoding="utf-8-sig") as f:
        for linea in f:
            if ";" not in linea:
                continue
            t, texto = linea.strip().split(";", 1)
            if texto.startswith(INYECCIONES):
                fallas.append((ts(t), texto))

    print(f"| Falla inyectada | Fallos cliente | Detección (ms) | RTO (ms) | Latencia máx. (ms) | Códigos |")
    print(f"|---|---|---|---|---|---|")
    for i, (t0, texto) in enumerate(fallas):
        fin = min(t0 + ventana, fallas[i + 1][0] if i + 1 < len(fallas) else float("inf"))
        en_ventana = [m for m in muestras if t0 <= m[0] < fin]
        malos = [m for m in en_ventana if not m[1]]
        lat_max = max((m[2] for m in en_ventana), default=0)
        if malos:
            deteccion = malos[0][0] - t0
            ultimo_malo = malos[-1][0]
            recuperado = next((m for m in muestras if m[0] > ultimo_malo and m[1]), None)
            rto = (recuperado[0] + recuperado[2] - t0) if recuperado else float("nan")
            codigos = {}
            for m in malos:
                codigos[m[3]] = codigos.get(m[3], 0) + 1
            cod = ", ".join(f"{k}:{v}" for k, v in sorted(codigos.items()))
            print(f"| {texto} | {len(malos)}/{len(en_ventana)} | {deteccion:.0f} | {rto:.0f} | {lat_max:.0f} | {cod} |")
        else:
            print(f"| {texto} | 0/{len(en_ventana)} | — | 0 | {lat_max:.0f} | — |")


if __name__ == "__main__":
    main()

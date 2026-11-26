#!/usr/bin/env python3
"""
Gráfico "tipo dashboard" de un escenario y sus métricas clave, a partir del CSV
de la sonda y del registro de eventos de inyección de fallos.

Genera un PNG con 3 paneles alineados en el tiempo:
  1. Latencia de cada pedido + p95 por segundo (ms)
  2. Pedidos confirmados por segundo (TPS)
  3. Pedidos fallidos por segundo
con líneas verticales en el instante exacto de cada inyección/recuperación.

Además imprime (y guarda en JSON) las métricas para la tabla del informe:
TPS promedio, latencia p95/p99, tasa de error y RTO observado.

Uso:
  python pruebas/analisis/graficos.py <sonda.csv> <eventos.log> <salida.png> "<Título>"
Requiere matplotlib (pip install matplotlib).
"""
import csv
import json
import sys
from collections import defaultdict
from datetime import datetime

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.ticker  # noqa: E402

# Paleta (validada para daltonismo): serie 1 azul, serie 2 naranja; rojo = estado crítico
AZUL, NARANJA, ROJO = "#257de0", "#f47230", "#dc3c3d"
TEXTO, TEXTO2, GRILLA = "#191919", "#666666", "#e6e6e6"


def ms(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


def pct(vals, q):
    if not vals:
        return 0.0
    s = sorted(vals)
    return s[min(len(s) - 1, int(len(s) * q))]


def etiqueta(texto):
    t = texto
    for a, b in (("NETEM-OFF ", "fin latencia "), ("NETEM ", "latencia "), ("PARTICION ", "partición "),
                 ("RECONEXION ", "reconexión "), ("primario PostgreSQL ", "primario BD "),
                 (" (reincorporacion)", ""), (" y reinicio para reincorporarse", ""), (" aislado", "")):
        t = t.replace(a, b)
    return t


def main():
    if len(sys.argv) < 5:
        print(__doc__)
        sys.exit(1)
    sonda, eventos, salida, titulo = sys.argv[1:5]

    filas = []
    with open(sonda, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            filas.append((float(r["epoch_ms"]), r["ok"] == "1", float(r["latencia_ms"]), r["status"]))
    filas.sort()
    t0 = filas[0][0]
    t_fin = max(t + l for t, _, l, _ in filas)
    dur_s = (filas[-1][0] - t0) / 1000 + 1

    evs = []
    with open(eventos, encoding="utf-8-sig") as f:
        for linea in f:
            if ";" in linea:
                t, txt = linea.strip().split(";", 1)
                if not txt.startswith(("INICIO", "FIN")):
                    evs.append(((ms(t) - t0) / 1000, txt))

    # --------------------------------------------------------------- métricas
    ok = [f for f in filas if f[1]]
    lat_ok = [f[2] for f in ok]
    fallidas = [f for f in filas if not f[1]]
    rto = 0.0
    iny = [e for e in evs if e[1].startswith(("KILL", "NETEM ", "PARTICION"))]
    if fallidas and iny:
        t_iny = t0 + iny[0][0] * 1000
        malos = [f for f in fallidas if f[0] >= t_iny]
        if malos:
            rec = next((f for f in filas if f[0] > malos[-1][0] and f[1]), None)
            rto = ((rec[0] + rec[2]) - t_iny) if rec else float("nan")
    metricas = {
        "escenario": titulo,
        "peticiones": len(filas),
        "tps_promedio": round(len(ok) / dur_s, 1),
        "latencia_p50_ms": round(pct(lat_ok, 0.5)),
        "latencia_p95_ms": round(pct(lat_ok, 0.95)),
        "latencia_p99_ms": round(pct(lat_ok, 0.99)),
        "latencia_max_ms": round(max(lat_ok, default=0)),
        "tasa_error_pct": round(100 * len(fallidas) / max(1, len(filas)), 2),
        "rto_ms": None if rto != rto else round(rto),  # NaN = no se recuperó
    }

    # --------------------------------------------------------------- series por segundo
    tps, err, lat_seg = defaultdict(int), defaultdict(int), defaultdict(list)
    for t, bien, lat, _ in filas:
        s = int((t - t0) // 1000)
        if bien:
            tps[s] += 1
            lat_seg[s].append(lat)
        else:
            err[s] += 1
    segs = list(range(int(dur_s) - 1))  # se omite el último segundo (incompleto)

    # --------------------------------------------------------------- gráfico
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.edgecolor": GRILLA,
                         "axes.labelcolor": TEXTO2, "xtick.color": TEXTO2, "ytick.color": TEXTO2})
    fig, (a1, a2, a3) = plt.subplots(3, 1, figsize=(10, 6.6), sharex=True,
                                     gridspec_kw={"height_ratios": [2.2, 1.3, 1]})
    fig.suptitle(titulo, x=0.01, ha="left", fontsize=12, fontweight="bold", color=TEXTO)

    a1.scatter([(t - t0) / 1000 for t, b, _, _ in filas if b], lat_ok, s=6, color=AZUL, alpha=0.35,
               linewidths=0, label="latencia de cada pedido")
    xs = [s + 0.5 for s in segs if lat_seg[s]]
    ys = [pct(lat_seg[s], 0.95) for s in segs if lat_seg[s]]
    a1.plot(xs, ys, color=NARANJA, lw=2, label="p95 por segundo")
    if xs:
        a1.annotate("p95", (xs[-1], ys[-1]), xytext=(4, 0), textcoords="offset points",
                    color=TEXTO, fontsize=8, va="center")
    a1.set_ylabel("Latencia (ms)")
    if max(lat_ok, default=0) > 400:   # escala logarítmica solo si hay picos grandes
        a1.set_yscale("symlog", linthresh=100)
    a1.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{v:,.0f}".replace(",", ".")))
    a1.set_ylim(bottom=0)
    a1.legend(loc="lower left", bbox_to_anchor=(0, 1.0), frameon=False, fontsize=8, ncol=2,
              borderaxespad=0.2)

    a2.plot([s + 0.5 for s in segs], [tps[s] for s in segs], color=AZUL, lw=2)
    a2.set_ylabel("TPS (confirmados/s)")
    a2.set_ylim(bottom=0)

    hubo_fallos = bool(err)
    a3.bar([s + 0.5 for s in segs], [err.get(s, 0) for s in segs], width=0.85, color=ROJO)
    a3.set_ylabel("Fallidos/s")
    a3.set_ylim(0, max(1, max(err.values(), default=0)) * 1.15)
    if not hubo_fallos:
        a3.text(0.5, 0.5, "sin peticiones fallidas", transform=a3.transAxes, ha="center",
                va="center", color=TEXTO2, fontsize=9)
    a3.set_xlabel("Segundos desde el inicio de la carga")

    for ax in (a1, a2, a3):
        ax.grid(axis="y", color=GRILLA, lw=0.8)
        ax.set_axisbelow(True)
        for lado in ("top", "right"):
            ax.spines[lado].set_visible(False)
        for x, _ in evs:
            ax.axvline(x, color=TEXTO2, lw=1, ls="--")
    for i, (x, txt) in enumerate(evs):
        a1.annotate(etiqueta(txt), (x, 1), xycoords=("data", "axes fraction"), xytext=(3, -12 - 11 * (i % 3)),
                    textcoords="offset points", fontsize=8, color=TEXTO, ha="left")
    a3.set_xlim(0, (t_fin - t0) / 1000)

    resumen = (f"TPS prom. {metricas['tps_promedio']}  ·  p95 {metricas['latencia_p95_ms']} ms  ·  "
               f"p99 {metricas['latencia_p99_ms']} ms  ·  error {metricas['tasa_error_pct']} %  ·  "
               f"RTO {'no se recuperó' if metricas['rto_ms'] is None else str(metricas['rto_ms']) + ' ms'}")
    fig.text(0.01, 0.005, resumen, fontsize=8.5, color=TEXTO2)
    fig.tight_layout(rect=(0, 0.025, 1, 0.965))
    fig.savefig(salida, dpi=160)
    with open(salida.rsplit(".", 1)[0] + ".json", "w", encoding="utf-8") as f:
        json.dump(metricas, f, ensure_ascii=False, indent=2)
    print(json.dumps(metricas, ensure_ascii=False))


if __name__ == "__main__":
    main()

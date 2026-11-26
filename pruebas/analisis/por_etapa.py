#!/usr/bin/env python3
"""
Resume un CSV de k6 (--out csv=...) en intervalos de tiempo para ubicar el
punto de quiebre: peticiones/s, pedidos confirmados/s (TPS), p50/p95/p99,
porcentaje de errores y usuarios virtuales activos en cada intervalo.

Uso:
  python pruebas/analisis/por_etapa.py resultados/k6-<lote>.csv [intervalo_s=30] [p95_limite_ms=1000] [error_limite_pct=5]
"""
import csv
import sys
from collections import defaultdict


def pct(vals, q):
    if not vals:
        return 0.0
    s = sorted(vals)
    return s[min(len(s) - 1, int(len(s) * q))]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    archivo = sys.argv[1]
    paso = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    lim_p95 = float(sys.argv[3]) if len(sys.argv) > 3 else 1000.0
    lim_err = float(sys.argv[4]) if len(sys.argv) > 4 else 5.0

    dur = defaultdict(list)
    errores = defaultdict(int)
    pedidos_ok = defaultdict(int)
    vus = defaultdict(float)
    t_ini = None
    with open(archivo, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            t = float(r["timestamp"])
            t_ini = t if t_ini is None else min(t_ini, t)
            r["_t"] = t
            nombre = r["metric_name"]
            if nombre == "http_req_duration":
                b = int((t - (t_ini or t)) // paso)
                dur[b].append(float(r["metric_value"]))
                st = r.get("status") or "0"
                if st == "0" or st.startswith("5"):
                    errores[b] += 1
                if r.get("name") == "POST /api/pedidos" and st == "200":
                    pedidos_ok[b] += 1
            elif nombre == "vus":
                b = int((t - (t_ini or t)) // paso)
                vus[b] = max(vus[b], float(r["metric_value"]))

    print(f"| Intervalo | VUs | Req/s | TPS pedidos | p50 ms | p95 ms | p99 ms | Errores % | Estado |")
    print(f"|---|---|---|---|---|---|---|---|---|")
    quiebre = None
    for b in sorted(dur):
        d = dur[b]
        n = len(d)
        e = 100.0 * errores[b] / n if n else 0.0
        p95 = pct(d, 0.95)
        malo = p95 > lim_p95 or e > lim_err
        if malo and quiebre is None:
            quiebre = b
        print(f"| {b * paso}-{(b + 1) * paso}s | {vus[b]:.0f} | {n / paso:.1f} | {pedidos_ok[b] / paso:.1f} | "
              f"{pct(d, 0.5):.0f} | {p95:.0f} | {pct(d, 0.99):.0f} | {e:.2f} | {'QUIEBRE' if malo else 'ok'} |")
    if quiebre is not None:
        print(f"\nPunto de quiebre: intervalo {quiebre * paso}-{(quiebre + 1) * paso}s "
              f"(~{vus[quiebre]:.0f} VUs, {len(dur[quiebre]) / paso:.1f} req/s): p95 > {lim_p95:.0f} ms o errores > {lim_err}%.")
    else:
        print(f"\nNo se alcanzó el punto de quiebre (p95 <= {lim_p95:.0f} ms y errores <= {lim_err}% en todos los intervalos).")


if __name__ == "__main__":
    main()

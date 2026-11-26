// =============================================================================
// Módulo C - Servicio de Auditoría (Go) - TechOrders U3
//
// Cambios respecto a la U2:
//   - Cliente Redis Cluster (go-redis ClusterClient): sigue los MOVED/ASK y
//     actualiza la topología sola cuando una réplica es promovida a maestro.
//   - Stateless: la clave de cada traza es "log:<request_id>" (idempotente).
//     Se eliminó el contador en memoria que provocaba colisiones entre réplicas.
//   - Listado sin KEYS: índice ordenado repartido en 16 shards
//     ("audit:idx:{n}"), consultado en paralelo y mezclado.
//   - Trazabilidad: cada traza guarda nodo_auditoria (HOSTNAME de la réplica).
//   - /cluster/redis: estado de nodos, slots, claves por maestro y eventos de
//     failover detectados (persistidos en Redis, no en memoria).
//
// =============================================================================
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	indexShards     = 16                  // nº de índices ordenados (repartidos por hash slot)
	keyMasterSet    = "ha:redis:maestros" // último conjunto de maestros observado
	keyFailoverList = "ha:redis:eventos"  // historial de eventos de failover
)

var (
	rdb      *redis.ClusterClient
	hostname string
	started  = time.Now()
)

// ----------------------------------------------------------------------------- tipos

type LogRequest struct {
	RequestID   string      `json:"request_id"`
	Evento      string      `json:"evento"`
	Origen      string      `json:"origen"`
	NodoGateway string      `json:"nodo_gateway"`
	Cliente     string      `json:"cliente"`
	Producto    string      `json:"producto"`
	Precio      interface{} `json:"precio"`
	Pago        string      `json:"pago"`
	Lote        string      `json:"lote"`
	Timestamp   string      `json:"timestamp"`
}

type LogEntry struct {
	LogRequest
	Key           string `json:"key"`
	NodoAuditoria string `json:"nodo_auditoria"`
	RegistradoEn  string `json:"registrado_en"`
	RegistradoMs  int64  `json:"registrado_ms"`
}

// ----------------------------------------------------------------------------- utilidades

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Node", hostname)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func indexKey(requestID string) string {
	// Las llaves {n} son "hash tags": fijan el slot del índice n, así los 16
	// índices quedan repartidos entre los 3 maestros del clúster.
	return fmt.Sprintf("audit:idx:{%d}", crc32.ChecksumIEEE([]byte(requestID))%indexShards)
}

func loteKey(lote string) string { return "audit:lote:" + lote }

func reqCtx(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}

// ----------------------------------------------------------------------------- POST /logs

func handlePostLog(w http.ResponseWriter, r *http.Request) {
	var req LogRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "ERROR", "mensaje": err.Error()})
		return
	}
	if req.RequestID == "" {
		req.RequestID = newUUID()
	}
	if req.Evento == "" {
		req.Evento = "SOLICITUD_ENTRANTE"
	}
	now := time.Now().UTC()
	entry := LogEntry{
		LogRequest:    req,
		Key:           "log:" + req.RequestID,
		NodoAuditoria: hostname,
		RegistradoEn:  now.Format(time.RFC3339Nano),
		RegistradoMs:  now.UnixMilli(),
	}
	data, _ := json.Marshal(entry)

	ctx, cancel := reqCtx(r, 4*time.Second)
	defer cancel()

	// SET NX: si el Gateway reintenta la misma petición, la traza no se duplica
	// ni se sobrescribe (idempotencia por request_id).
	created, err := rdb.SetNX(ctx, entry.Key, data, 0).Result()
	if err != nil {
		log.Printf("[%s] Error guardando %s en Redis: %v", hostname, entry.Key, err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "ERROR", "mensaje": "No se pudo guardar la auditoria", "nodo": hostname})
		return
	}
	if created {
		// Índices secundarios (en otros slots): listado ordenado y conteo por lote
		_, err = rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
			p.ZAdd(ctx, indexKey(req.RequestID), redis.Z{Score: float64(entry.RegistradoMs), Member: entry.Key})
			if req.Lote != "" {
				p.SAdd(ctx, loteKey(req.Lote), entry.Key)
			}
			return nil
		})
		if err != nil {
			log.Printf("[%s] Advertencia: traza %s guardada pero índice no actualizado: %v", hostname, entry.Key, err)
		}
	} else {
		// Reintento: devolver la traza ya existente
		if prev, e := rdb.Get(ctx, entry.Key).Bytes(); e == nil {
			_ = json.Unmarshal(prev, &entry)
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":         "Guardado",
		"log_id":         entry.Key,
		"nodo":           hostname,
		"nodo_auditoria": entry.NodoAuditoria,
		"duplicado":      !created,
		"timestamp":      entry.RegistradoEn,
	})
}

// ----------------------------------------------------------------------------- GET /logs

func fetchEntries(ctx context.Context, keys []string) []LogEntry {
	out := make([]LogEntry, 0, len(keys))
	if len(keys) == 0 {
		return out
	}
	cmds, _ := rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		for _, k := range keys {
			p.Get(ctx, k)
		}
		return nil
	})
	for _, c := range cmds {
		val, err := c.(*redis.StringCmd).Bytes()
		if err != nil {
			continue
		}
		var e LogEntry
		if json.Unmarshal(val, &e) == nil {
			out = append(out, e)
		}
	}
	return out
}

func handleGetLogs(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	evento := r.URL.Query().Get("evento")

	ctx, cancel := reqCtx(r, 4*time.Second)
	defer cancel()

	type scored struct {
		key   string
		score float64
	}
	var all []scored
	cmds, err := rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		for i := 0; i < indexShards; i++ {
			p.ZRevRangeWithScores(ctx, fmt.Sprintf("audit:idx:{%d}", i), 0, int64(limit-1))
		}
		return nil
	})
	if err != nil && !errors.Is(err, redis.Nil) {
		log.Printf("[%s] Error parcial leyendo índices: %v", hostname, err)
	}
	for _, c := range cmds {
		zs, e := c.(*redis.ZSliceCmd).Result()
		if e != nil {
			continue // shard sin responder: se devuelve lo disponible (degradación parcial)
		}
		for _, z := range zs {
			all = append(all, scored{key: z.Member.(string), score: z.Score})
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].score > all[j].score })
	if len(all) > limit {
		all = all[:limit]
	}
	keys := make([]string, len(all))
	for i, s := range all {
		keys[i] = s.key
	}
	entries := fetchEntries(ctx, keys)
	if evento != "" {
		filtered := entries[:0]
		for _, e := range entries {
			if e.Evento == evento {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
	}
	writeJSON(w, http.StatusOK, entries)
}

// ----------------------------------------------------------------------------- GET /logs/stats?lote=X

func handleLogStats(w http.ResponseWriter, r *http.Request) {
	lote := r.URL.Query().Get("lote")
	if lote == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"status": "ERROR", "mensaje": "parametro lote requerido"})
		return
	}
	ctx, cancel := reqCtx(r, 20*time.Second)
	defer cancel()

	keys, err := rdb.SMembers(ctx, loteKey(lote)).Result()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "ERROR", "mensaje": err.Error()})
		return
	}
	porAuditoria := map[string]int{}
	porGateway := map[string]int{}
	total := 0
	for i := 0; i < len(keys); i += 500 {
		end := i + 500
		if end > len(keys) {
			end = len(keys)
		}
		for _, e := range fetchEntries(ctx, keys[i:end]) {
			total++
			porAuditoria[e.NodoAuditoria]++
			porGateway[e.NodoGateway]++
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"lote":               lote,
		"total_trazas":       total,
		"por_nodo_auditoria": porAuditoria,
		"por_nodo_gateway":   porGateway,
	})
}

// ----------------------------------------------------------------------------- GET /cluster/redis

type RedisNode struct {
	ID       string `json:"id"`
	Addr     string `json:"addr"`
	Rol      string `json:"rol"` // maestro | replica
	MasterID string `json:"master_id,omitempty"`
	Estado   string `json:"estado"` // UP | DOWN | SOSPECHOSO
	Slots    string `json:"slots,omitempty"`
	Claves   *int64 `json:"claves,omitempty"`
}

func parseClusterNodes(raw string) []RedisNode {
	var nodes []RedisNode
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		f := strings.Fields(line)
		if len(f) < 8 {
			continue
		}
		addr := strings.Split(f[1], "@")[0]
		flags := f[2]
		n := RedisNode{ID: f[0][:8], Addr: addr, Rol: "replica", Estado: "UP"}
		if strings.Contains(flags, "master") {
			n.Rol = "maestro"
		}
		if f[3] != "-" {
			n.MasterID = f[3][:8]
		}
		switch {
		case strings.Contains(flags, "fail?"):
			n.Estado = "SOSPECHOSO"
		case strings.Contains(flags, "fail"), f[7] == "disconnected":
			n.Estado = "DOWN"
		}
		if len(f) > 8 {
			n.Slots = strings.Join(f[8:], " ")
		}
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Addr < nodes[j].Addr })
	return nodes
}

func handleClusterStatus(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := reqCtx(r, 4*time.Second)
	defer cancel()

	raw, err := rdb.ClusterNodes(ctx).Result()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{"estado": "DOWN", "error": err.Error(), "nodo": hostname})
		return
	}
	info, _ := rdb.ClusterInfo(ctx).Result()
	nodes := parseClusterNodes(raw)

	// Claves por nodo (evidencia del sharding): DBSIZE en cada shard
	var mu sync.Mutex
	sizes := map[string]int64{}
	_ = rdb.ForEachShard(ctx, func(ctx context.Context, c *redis.Client) error {
		if n, e := c.DBSize(ctx).Result(); e == nil {
			mu.Lock()
			sizes[c.Options().Addr] = n
			mu.Unlock()
		}
		return nil
	})
	masters := []string{}
	down := []string{}
	for i := range nodes {
		if v, ok := sizes[nodes[i].Addr]; ok {
			v := v
			nodes[i].Claves = &v
		}
		if nodes[i].Rol == "maestro" && nodes[i].Estado == "UP" && nodes[i].Slots != "" {
			masters = append(masters, nodes[i].Addr)
		}
		if nodes[i].Estado != "UP" {
			down = append(down, nodes[i].Addr)
		}
	}
	sort.Strings(masters)

	// Detección de failover sin estado local: GETSET atómico del conjunto de
	// maestros. Si cambió respecto a la última observación, se registra un evento.
	current := strings.Join(masters, ",")
	if len(masters) > 0 {
		prev, e := rdb.SetArgs(ctx, keyMasterSet, current, redis.SetArgs{Get: true}).Result()
		if e != nil && !errors.Is(e, redis.Nil) {
			log.Printf("[%s] no se pudo actualizar %s: %v", hostname, keyMasterSet, e)
		} else if prev != "" && prev != current {
			ev, _ := json.Marshal(map[string]string{
				"ocurrido_en":     time.Now().UTC().Format(time.RFC3339),
				"componente":      "redis",
				"tipo":            "FAILOVER",
				"maestros_antes":  prev,
				"maestros_ahora":  current,
				"nodos_con_falla": strings.Join(down, ","),
				"detectado_por":   hostname,
			})
			rdb.LPush(ctx, keyFailoverList, ev)
			rdb.LTrim(ctx, keyFailoverList, 0, 49)
			log.Printf("[%s] FAILOVER Redis detectado: %s -> %s", hostname, prev, current)
		}
	}
	eventos := []map[string]interface{}{}
	if raws, e := rdb.LRange(ctx, keyFailoverList, 0, 19).Result(); e == nil {
		for _, s := range raws {
			var m map[string]interface{}
			if json.Unmarshal([]byte(s), &m) == nil {
				eventos = append(eventos, m)
			}
		}
	}

	estado := "DOWN"
	if strings.Contains(info, "cluster_state:ok") {
		estado = "OK"
		if len(down) > 0 {
			estado = "DEGRADADO"
		}
	}
	epoch := ""
	for _, l := range strings.Split(info, "\n") {
		if strings.HasPrefix(l, "cluster_current_epoch:") {
			epoch = strings.TrimSpace(strings.TrimPrefix(l, "cluster_current_epoch:"))
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"estado":         estado,
		"maestros":       len(masters),
		"nodos":          nodes,
		"current_epoch":  epoch,
		"eventos":        eventos,
		"consultado_por": hostname,
	})
}

// ----------------------------------------------------------------------------- GET /health

func handleHealth(w http.ResponseWriter, r *http.Request) {
	// Liveness: responde 200 mientras el proceso esté vivo. El estado de Redis se
	// informa pero no tumba el health check (si Redis cae, sacar TODAS las réplicas
	// del balanceador solo agregaría una falla en cascada).
	ctx, cancel := reqCtx(r, 1500*time.Millisecond)
	defer cancel()
	redisState := "UP"
	if err := rdb.Ping(ctx).Err(); err != nil {
		redisState = "DOWN"
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"modulo":     "modulo-c-auditoria",
		"status":     "UP",
		"nodo":       hostname,
		"redis":      redisState,
		"uptime_seg": int(time.Since(started).Seconds()),
	})
}

// ----------------------------------------------------------------------------- main

func main() {
	hostname = os.Getenv("NODE_NAME")
	if hostname == "" {
		hostname, _ = os.Hostname()
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "6000"
	}
	addrs := strings.Split(os.Getenv("REDIS_NODES"), ",")
	if os.Getenv("REDIS_NODES") == "" {
		addrs = []string{"redis-1:6379", "redis-2:6379", "redis-3:6379"}
	}

	rdb = redis.NewClusterClient(&redis.ClusterOptions{
		Addrs:           addrs,
		DialTimeout:     2 * time.Second,
		ReadTimeout:     2 * time.Second,
		WriteTimeout:    2 * time.Second,
		MaxRedirects:    8,
		MaxRetries:      6, // reintentos internos durante una elección de maestro
		MinRetryBackoff: 100 * time.Millisecond,
		MaxRetryBackoff: 1500 * time.Millisecond,
		PoolSize:        50,
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/logs", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			handlePostLog(w, r)
		case http.MethodGet:
			handleGetLogs(w, r)
		default:
			http.Error(w, "Metodo no permitido", http.StatusMethodNotAllowed)
		}
	})
	mux.HandleFunc("/logs/stats", handleLogStats)
	mux.HandleFunc("/cluster/redis", handleClusterStatus)
	mux.HandleFunc("/health", handleHealth)

	srv := &http.Server{Addr: os.Getenv("BIND_ADDR") + ":" + port, Handler: mux, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second}
	log.Printf("Modulo C (Auditoria) [%s] escuchando en puerto %s; Redis Cluster: %v", hostname, port, addrs)
	log.Fatal(srv.ListenAndServe())
}

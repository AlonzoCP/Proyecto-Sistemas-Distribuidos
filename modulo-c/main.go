package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

var ctx = context.Background()
var rdb *redis.Client
var logCounter uint64

type LogRequest struct {
	Evento    string      `json:"evento"`
	Origen    string      `json:"origen"`
	Cliente   string      `json:"cliente"`
	Producto  string      `json:"producto"`
	Precio    interface{} `json:"precio"`
	Monto     interface{} `json:"monto"`
	Timestamp string      `json:"timestamp"`
}

func handleLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Metodo no permitido", http.StatusMethodNotAllowed)
		return
	}

	var req LogRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	seq := atomic.AddUint64(&logCounter, 1)
	logID := fmt.Sprintf("log:%s-%03d", time.Now().Format("20060102150405"), seq)
	data, _ := json.Marshal(req)

	// Persistir traza en Redis (Motor BD 2)
	if err := rdb.Set(ctx, logID, data, 0).Err(); err != nil {
		log.Printf("Error guardando en Redis: %v", err)
		http.Error(w, "No se pudo guardar la auditoria", http.StatusInternalServerError)
		return
	}

	// Respuesta hacia Modulo A
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":    "Guardado",
		"log_id":    logID,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

// Funcion para obtener los logs desde Redis y devolverlos como JSON
func getLogsHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	ctx := context.Background()
	keys, err := rdb.Keys(ctx, "log:*").Result()
	if err != nil {
		http.Error(w, `{"status":"ERROR","mensaje":"Fallo al leer claves de Redis"}`, http.StatusInternalServerError)
		return
	}

	logs := []map[string]interface{}{}
	for _, key := range keys {
		val, err := rdb.Get(ctx, key).Result()
		if err == nil {
			var logEntry map[string]interface{}
			if json.Unmarshal([]byte(val), &logEntry) == nil {
				logEntry["key"] = key
				logs = append(logs, logEntry)
			}
		}
	}

	json.NewEncoder(w).Encode(logs)
}

func main() {
	redisHost := os.Getenv("REDIS_HOST")
	if redisHost == "" {
		redisHost = "db-nosql"
	}
	redisPort := os.Getenv("REDIS_PORT")
	if redisPort == "" {
		redisPort = "6379"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "6000"
	}

	rdb = redis.NewClient(&redis.Options{
		Addr: fmt.Sprintf("%s:%s", redisHost, redisPort),
	})

	http.HandleFunc("/logs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			handleLogs(w, r)
			return
		}
		if r.Method == http.MethodGet {
			getLogsHandler(w, r)
			return
		}
		http.Error(w, "Metodo no permitido", http.StatusMethodNotAllowed)
	})
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"modulo": "modulo-c",
			"status": "UP",
		})
	})
	log.Printf("Modulo C (Auditoria) escuchando en puerto %s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}

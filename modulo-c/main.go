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
	}

	// Respuesta hacia Modulo A
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":    "Guardado",
		"log_id":    logID,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func main() {
	redisHost := os.Getenv("REDIS_HOST")
	if redisHost == "" {
		redisHost = "db-nosql"
	}

	rdb = redis.NewClient(&redis.Options{
		Addr: fmt.Sprintf("%s:6379", redisHost),
	})

	http.HandleFunc("/logs", handleLogs)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"modulo": "modulo-c",
			"status": "UP",
		})
	})

	log.Println("Modulo C (Auditoria) escuchando en puerto 6000")
	if err := http.ListenAndServe(":6000", nil); err != nil {
		log.Fatal(err)
	}
}

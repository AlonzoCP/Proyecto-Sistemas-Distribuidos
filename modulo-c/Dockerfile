# Build en dos etapas: binario estático + imagen final mínima
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /modulo-c .

FROM alpine:3.20
COPY --from=build /modulo-c /usr/local/bin/modulo-c
EXPOSE 6000
# busybox wget se usa en el healthcheck de docker-compose
CMD ["modulo-c"]
